import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/framework/utils"
import {
  AllocationHoldState,
  AllocationFenceDisposition,
  AllocationPolicyState,
  CapacityState,
  PurchaseAttemptState,
} from "../../../types"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationStore,
  CancelHeldQuotaCommand,
  AllocationCampaignFenceRecord,
  AllocationCampaignFenceResult,
  AllocationControlResult,
  ClaimedAllocationHold,
  ClaimedPurchaseAttempt,
  ClaimAttemptPersistenceInput,
  ClaimAttemptResult,
  HoldQuotaPersistenceInput,
  HoldQuotaResult,
  FenceAndCloseCampaignAllocationCommand,
  ExpireDueQuotaCommand,
  ExpireDueQuotaResult,
  ExpireQuotaCommand,
  ProvisionAllocationPersistenceInput,
  ProvisionedAllocationPolicy,
  ProvisionedCapacity,
  SettlementQuotaCommand,
  SettleQuotaResult,
  TransitionAllocationCommand,
} from "../application"
import {
  appendAllocationOutboxEvent,
  verifyAllocationOutboxReplay,
} from "./allocation-outbox-producer"

type PolicyRow = {
  id: string
  campaign_id: string
  configuration_hash: string
  rules_version: number | string
  state: AllocationPolicyState
  starts_at: Date | string
  ends_at: Date | string
  hold_ttl_seconds: number | string
  per_subject_limit: number | string
  version: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  is_in_window: boolean
  expires_at: Date | string
}
type FenceRow = {
  id: string
  campaign_id: string
  disposition: AllocationFenceDisposition
  campaign_version: number | string
  rules_version: number | string
  version: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}
type AttemptRow = {
  id: string
  allocation_policy_id: string
  campaign_id: string
  subject_id: string
  cart_id: string | null
  idempotency_key_hash: string
  request_hash: string
  state: PurchaseAttemptState
  rules_version: number | string
  expires_at: Date | string
  version: number | string
  last_error_code: string | null
  terminal_at: Date | string | null
  settlement_id: string | null
  settlement_started_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}
type CapacityRow = {
  id: string
  allocation_policy_id: string
  campaign_item_id: string
  shard_no: number | string
  state: CapacityState
  granted_quantity: number | string
  held_quantity: number | string
  consumed_quantity: number | string
  rules_version: number | string
  version: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}
type SubjectRow = {
  id: string
  limit_quantity: number | string
  held_quantity: number | string
  consumed_quantity: number | string
  rules_version: number | string
  version: number | string
}
type HoldRow = {
  id: string
  attempt_id: string
  capacity_id: string
  campaign_item_id: string
  quantity: number | string
  state: AllocationHoldState
  expires_at: Date | string
  version: number | string
  resolved_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

const ATTEMPT_COLUMNS = `id, allocation_policy_id, campaign_id, subject_id,
  cart_id, idempotency_key_hash, request_hash, state, rules_version, expires_at,
  version, last_error_code, terminal_at, settlement_id,
  settlement_started_at, created_at, updated_at, deleted_at`
const HOLD_COLUMNS = `id, attempt_id, capacity_id, campaign_item_id, quantity,
  state, expires_at, version, resolved_at, created_at, updated_at, deleted_at`
const POLICY_COLUMNS = `id, campaign_id, rules_version, configuration_hash,
  state, starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version,
  created_at, updated_at, deleted_at`
const CAPACITY_COLUMNS = `id, allocation_policy_id, campaign_item_id, shard_no,
  state, granted_quantity, held_quantity, consumed_quantity, rules_version,
  version, created_at, updated_at, deleted_at`
const FENCE_COLUMNS = `id, campaign_id, disposition, campaign_version,
  rules_version, version, created_at, updated_at, deleted_at`
const CAMPAIGN_CONTROL_LOCK_NAMESPACE = "flash-sale-allocation-campaign:"
const RETRYABLE_DATABASE_CODES = new Set(["55P03", "40P01", "40001"])

type ExpireNextDueAttemptResult =
  | Readonly<{ kind: "expired"; result: SettleQuotaResult }>
  | Readonly<{ kind: "conflicted"; attempt_id: string }>
  | Readonly<{
      kind: "failed"
      attempt_id: string
      error_code:
        | AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION
        | AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE
    }>

export function calculateAllocationRetryDelayMs(
  attempt: number,
  random: number = Math.random()
): number {
  return Math.min(
    50,
    5 * 2 ** Math.max(0, attempt - 1) + Math.floor(random * 5)
  )
}

const asDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value)
const asNullableDate = (value: Date | string | null) =>
  value === null ? null : asDate(value)

function mapAttempt(row: AttemptRow): ClaimedPurchaseAttempt {
  return {
    ...row,
    rules_version: Number(row.rules_version),
    expires_at: asDate(row.expires_at),
    version: Number(row.version),
    terminal_at: asNullableDate(row.terminal_at),
    settlement_started_at: asNullableDate(row.settlement_started_at),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function mapHold(row: HoldRow): ClaimedAllocationHold {
  return {
    ...row,
    quantity: Number(row.quantity),
    expires_at: asDate(row.expires_at),
    version: Number(row.version),
    resolved_at: asNullableDate(row.resolved_at),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function mapPolicy(row: PolicyRow): ProvisionedAllocationPolicy {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    rules_version: Number(row.rules_version),
    configuration_hash: row.configuration_hash,
    state: row.state,
    starts_at: asDate(row.starts_at),
    ends_at: asDate(row.ends_at),
    hold_ttl_seconds: Number(row.hold_ttl_seconds),
    per_subject_limit: Number(row.per_subject_limit),
    version: Number(row.version),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function mapCapacity(row: CapacityRow): ProvisionedCapacity {
  return {
    ...row,
    shard_no: Number(row.shard_no),
    granted_quantity: Number(row.granted_quantity),
    held_quantity: Number(row.held_quantity),
    consumed_quantity: Number(row.consumed_quantity),
    rules_version: Number(row.rules_version),
    version: Number(row.version),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function mapFence(row: FenceRow): AllocationCampaignFenceRecord {
  return {
    ...row,
    campaign_version: Number(row.campaign_version),
    rules_version: Number(row.rules_version),
    version: Number(row.version),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }
  const candidate = error as {
    code?: string
    driverException?: { code?: string }
    cause?: { code?: string }
  }
  return (
    candidate.code ?? candidate.driverException?.code ?? candidate.cause?.code
  )
}

export class PostgresAllocationAttemptStore implements AllocationStore {
  constructor(
    private readonly baseRepository: DAL.RepositoryService,
    private readonly faultInjector?: AllocationFaultInjector
  ) {}

  async claimAttempt(input: ClaimAttemptPersistenceInput) {
    return await this.runTransaction((manager) =>
      this.claimInTransaction(manager, input)
    )
  }

  async holdQuota(input: HoldQuotaPersistenceInput) {
    return await this.runTransaction((manager) =>
      this.holdInTransaction(manager, input)
    )
  }

  async claimAndHoldQuota(input: ClaimAttemptPersistenceInput) {
    return await this.runTransaction(async (manager) => {
      const claim = await this.claimInTransaction(manager, input)
      return await this.holdInTransaction(manager, {
        attempt_id: claim.attempt.id,
        campaign_id: input.campaign_id,
        subject_id: input.subject_id,
        cart_id: input.cart_id,
        request_hash: input.request_hash,
        expected_rules_version: input.expected_rules_version,
        items: input.items,
      })
    })
  }

  async cancelHeldQuota(input: CancelHeldQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.settleInTransaction(manager, input.attempt_id, "cancel")
    )
  }

  async beginQuotaSettlement(input: SettlementQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.beginSettlementInTransaction(
        manager,
        input.attempt_id,
        input.settlement_id
      )
    )
  }

  async consumeQuotaSettlement(input: SettlementQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.settleInTransaction(
        manager,
        input.attempt_id,
        "consume",
        input.settlement_id
      )
    )
  }

  async authorizeQuotaSettlement(input: SettlementQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.authorizeSettlementInTransaction(
        manager,
        input.attempt_id,
        input.settlement_id
      )
    )
  }

  async releaseQuotaSettlement(input: SettlementQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.settleInTransaction(
        manager,
        input.attempt_id,
        "release",
        input.settlement_id
      )
    )
  }

  async expireQuota(input: ExpireQuotaCommand) {
    return await this.runTransaction((manager) =>
      this.settleInTransaction(manager, input.attempt_id, "expire")
    )
  }

  async expireDueQuota(
    input: ExpireDueQuotaCommand
  ): Promise<ExpireDueQuotaResult> {
    const attemptIds: string[] = []
    const excludedAttemptIds: string[] = []
    const failures: ExpireDueQuotaResult["failures"][number][] = []
    let scanned = 0
    let conflicted = 0
    for (let index = 0; index < input.limit; index++) {
      const result = await this.expireNextDueAttempt(excludedAttemptIds)
      if (result === null) {
        break
      }
      scanned++
      const attemptId =
        result.kind === "expired" ? result.result.attempt.id : result.attempt_id
      excludedAttemptIds.push(attemptId)
      if (result.kind === "conflicted") {
        conflicted++
      } else if (result.kind === "failed") {
        failures.push({
          attempt_id: result.attempt_id,
          error_code: result.error_code,
        })
      } else {
        attemptIds.push(result.result.attempt.id)
      }
    }
    return {
      scanned,
      expired: attemptIds.length,
      conflicted,
      failed: failures.length,
      failures,
      attempt_ids: attemptIds,
    }
  }

  private async expireNextDueAttempt(
    excludedAttemptIds: readonly string[]
  ): Promise<ExpireNextDueAttemptResult | null> {
    let candidateId: string | undefined
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const settlement =
          await this.baseRepository.transaction<SqlEntityManager>(
            async (manager) => {
              await manager.execute(
                "set local transaction isolation level read committed"
              )
              await manager.execute("set local lock_timeout = '3s'")

              let candidate: { id: string } | undefined
              if (candidateId) {
                const rows = (await manager.execute(
                  `select id from flash_sale_purchase_attempt
                where id = ? and deleted_at is null for update`,
                  [candidateId]
                )) as Array<{ id: string }>
                candidate = rows[0]
              } else {
                const exclusion = excludedAttemptIds.length
                  ? `and id not in (${excludedAttemptIds
                      .map(() => "?")
                      .join(", ")})`
                  : ""
                const rows = (await manager.execute(
                  `select id from flash_sale_purchase_attempt
                where state = ? and expires_at <= now() and deleted_at is null
                  ${exclusion}
                order by expires_at, id
                limit 1 for update skip locked`,
                  [PurchaseAttemptState.QUOTA_HELD, ...excludedAttemptIds]
                )) as Array<{ id: string }>
                candidate = rows[0]
              }
              if (!candidate) {
                return null
              }
              candidateId = candidate.id
              return await this.settleInTransaction(
                manager,
                candidate.id,
                "expire"
              )
            }
          )
        return settlement === null
          ? null
          : { kind: "expired", result: settlement }
      } catch (error) {
        if (!candidateId) {
          // Selection/infrastructure failures are not attributable to one
          // Attempt and must fail the job visibly.
          throw error
        }
        if (error instanceof AllocationCommandError) {
          if (
            error.code === AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT
          ) {
            return { kind: "conflicted", attempt_id: candidateId }
          }
          if (
            error.code ===
            AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION
          ) {
            return {
              kind: "failed",
              attempt_id: candidateId,
              error_code:
                AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION,
            }
          }
          if (
            error.code === AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE
          ) {
            return {
              kind: "failed",
              attempt_id: candidateId,
              error_code: AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
            }
          }
        }
        const code = databaseErrorCode(error)
        if (!code || !RETRYABLE_DATABASE_CODES.has(code)) {
          throw error
        }
        if (attempt === 3) {
          return {
            kind: "failed",
            attempt_id: candidateId,
            error_code: AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
          }
        }
        await new Promise((resolve) =>
          setTimeout(resolve, calculateAllocationRetryDelayMs(attempt))
        )
      }
    }
    throw new AllocationCommandError(
      AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
      "Expiry attempt remained contended after the retry budget"
    )
  }

  async provisionAllocation(input: ProvisionAllocationPersistenceInput) {
    return await this.runTransaction((manager) =>
      this.provisionInTransaction(manager, input)
    )
  }

  async openAllocation(input: TransitionAllocationCommand) {
    return await this.runTransaction((manager) =>
      this.transitionAllocationInTransaction(manager, input, "open")
    )
  }

  async closeAllocation(input: TransitionAllocationCommand) {
    return await this.runTransaction((manager) =>
      this.transitionAllocationInTransaction(manager, input, "close")
    )
  }

  async fenceAndCloseCampaignAllocation(
    input: FenceAndCloseCampaignAllocationCommand
  ) {
    return await this.runTransaction((manager) =>
      this.fenceAndCloseCampaignInTransaction(manager, input)
    )
  }

  private async runTransaction<T>(
    operation: (manager: SqlEntityManager) => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.baseRepository.transaction<SqlEntityManager>(
          async (manager) => {
            await manager.execute(
              "set local transaction isolation level read committed"
            )
            await manager.execute("set local lock_timeout = '3s'")
            return await operation(manager)
          }
        )
      } catch (error) {
        const code = databaseErrorCode(error)
        if (!code || !RETRYABLE_DATABASE_CODES.has(code)) {
          throw error
        }
        if (attempt === 3) {
          throw new AllocationCommandError(
            AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
            "Allocation is temporarily contended; retry the command"
          )
        }
        await new Promise((resolve) =>
          setTimeout(resolve, calculateAllocationRetryDelayMs(attempt))
        )
      }
    }
    throw new AllocationCommandError(
      AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
      "Allocation is temporarily contended; retry the command"
    )
  }

  private async databaseNow(manager: SqlEntityManager): Promise<Date> {
    const rows = (await manager.execute(
      "select clock_timestamp() as fresh_now"
    )) as Array<{ fresh_now: Date | string }>
    return asDate(rows[0].fresh_now)
  }

  private async provisionInTransaction(
    manager: SqlEntityManager,
    input: ProvisionAllocationPersistenceInput
  ): Promise<AllocationControlResult> {
    await this.lockCampaignControl(manager, input.campaign_id)
    await this.assertCampaignNotFenced(manager, input.campaign_id)

    const latestPolicies = (await manager.execute(
      `select ${POLICY_COLUMNS}
         from flash_sale_allocation_policy
        where campaign_id = ? and deleted_at is null
        order by rules_version desc, id
        limit 1 for update`,
      [input.campaign_id]
    )) as PolicyRow[]
    const latest = latestPolicies[0]
    if (latest) {
      const latestRulesVersion = Number(latest.rules_version)
      if (input.rules_version < latestRulesVersion) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.STALE_RULES_VERSION,
          `Rules version ${input.rules_version} is older than ${latestRulesVersion}`
        )
      }
      if (input.rules_version === latestRulesVersion) {
        if (latest.configuration_hash !== input.configuration_hash) {
          throw new AllocationCommandError(
            AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT,
            "The campaign rules version already has a different snapshot"
          )
        }
        return {
          policy: mapPolicy(latest),
          capacities: await this.lockPolicyCapacities(manager, latest.id),
          replayed: true,
        }
      }
    }

    const activePolicies = (await manager.execute(
      `select ${POLICY_COLUMNS}
         from flash_sale_allocation_policy
        where campaign_id = ? and deleted_at is null
          and state in (?, ?)
        order by rules_version desc, id for update`,
      [
        input.campaign_id,
        AllocationPolicyState.PREPARED,
        AllocationPolicyState.OPEN,
      ]
    )) as PolicyRow[]
    if (activePolicies.length > 1) {
      throw this.invariant("Campaign has multiple active allocation policies")
    }
    const active = activePolicies[0]
    if (active) {
      if (active.state === AllocationPolicyState.OPEN) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.ACTIVE_POLICY_CONFLICT,
          `Open allocation rules version ${active.rules_version} cannot be superseded`
        )
      }
      const activity = (await manager.execute(
        `select
           exists(select 1 from flash_sale_purchase_attempt
                   where allocation_policy_id = ? and deleted_at is null) as has_attempt,
           exists(select 1 from flash_sale_allocation_hold h
                    join flash_sale_capacity c on c.id = h.capacity_id
                   where c.allocation_policy_id = ?
                     and h.deleted_at is null and c.deleted_at is null) as has_hold`,
        [active.id, active.id]
      )) as Array<{ has_attempt: boolean; has_hold: boolean }>
      if (activity[0]?.has_attempt || activity[0]?.has_hold) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.ACTIVE_POLICY_CONFLICT,
          "Prepared allocation has purchase activity and cannot be superseded"
        )
      }
      const capacities = await this.lockPolicyCapacities(manager, active.id)
      if (capacities.length === 0) {
        throw this.invariant("Prepared allocation policy has no capacities")
      }
      await this.closeLockedPolicy(manager, active, capacities)
    }

    return await this.insertProvisionedAllocation(manager, input)
  }

  private async insertProvisionedAllocation(
    manager: SqlEntityManager,
    input: ProvisionAllocationPersistenceInput
  ): Promise<AllocationControlResult> {
    const policyRows = (await manager.execute(
      `insert into flash_sale_allocation_policy
        (id, campaign_id, rules_version, configuration_hash, state, starts_at,
         ends_at, hold_ttl_seconds, per_subject_limit, version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       returning ${POLICY_COLUMNS}`,
      [
        generateEntityId(undefined, "fsapol"),
        input.campaign_id,
        input.rules_version,
        input.configuration_hash,
        AllocationPolicyState.PREPARED,
        input.starts_at,
        input.ends_at,
        input.hold_ttl_seconds,
        input.per_subject_limit,
      ]
    )) as PolicyRow[]
    const policy = policyRows[0]
    if (!policy) {
      throw this.invariant("Allocation policy insert returned no row")
    }

    const capacities: ProvisionedCapacity[] = []
    for (const item of input.items) {
      const rows = (await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity,
           raw_consumed_quantity)
         values (?, ?, ?, 0, ?, ?, 0, 0, ?, 1,
           jsonb_build_object('value', ?::text, 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20))
         returning ${CAPACITY_COLUMNS}`,
        [
          generateEntityId(undefined, "fscap"),
          policy.id,
          item.campaign_item_id,
          CapacityState.PREPARED,
          item.quota,
          input.rules_version,
          item.quota,
        ]
      )) as CapacityRow[]
      if (!rows[0]) {
        throw this.invariant("Capacity insert returned no row")
      }
      capacities.push(mapCapacity(rows[0]))
    }
    return { policy: mapPolicy(policy), capacities, replayed: false }
  }

  private async transitionAllocationInTransaction(
    manager: SqlEntityManager,
    input: TransitionAllocationCommand,
    transition: "open" | "close"
  ): Promise<AllocationControlResult> {
    const identities = (await manager.execute(
      `select campaign_id from flash_sale_allocation_policy
        where id = ? and deleted_at is null`,
      [input.policy_id]
    )) as Array<{ campaign_id: string }>
    if (!identities[0]) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ALLOCATION_POLICY_NOT_FOUND,
        "Allocation policy does not exist"
      )
    }
    await this.lockCampaignControl(manager, identities[0].campaign_id)
    if (transition === "open") {
      await this.assertCampaignNotFenced(manager, identities[0].campaign_id)
    }
    const policies = (await manager.execute(
      `select ${POLICY_COLUMNS}
         from flash_sale_allocation_policy
        where id = ? and deleted_at is null for update`,
      [input.policy_id]
    )) as PolicyRow[]
    const policy = policies[0]
    if (!policy) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ALLOCATION_POLICY_NOT_FOUND,
        "Allocation policy does not exist"
      )
    }
    if (Number(policy.rules_version) !== input.expected_rules_version) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.STALE_RULES_VERSION,
        "Allocation policy rules version does not match the command"
      )
    }

    const capacities = await this.lockPolicyCapacities(manager, policy.id)
    if (capacities.length === 0) {
      throw this.invariant("Allocation policy has no capacities")
    }
    const targetPolicyState =
      transition === "open"
        ? AllocationPolicyState.OPEN
        : AllocationPolicyState.CLOSED
    const targetCapacityState =
      transition === "open" ? CapacityState.OPEN : CapacityState.CLOSED
    if (policy.state === targetPolicyState) {
      if (
        capacities.some((capacity) => capacity.state !== targetCapacityState)
      ) {
        throw this.invariant("Allocation policy and capacity states disagree")
      }
      return { policy: mapPolicy(policy), capacities, replayed: true }
    }
    const allowed =
      transition === "open"
        ? policy.state === AllocationPolicyState.PREPARED
        : policy.state === AllocationPolicyState.PREPARED ||
          policy.state === AllocationPolicyState.OPEN
    if (!allowed || Number(policy.version) !== input.expected_version) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ALLOCATION_POLICY_STATE_CONFLICT,
        `Allocation policy cannot ${transition} from ${policy.state} at version ${policy.version}`
      )
    }
    if (
      capacities.some(
        (capacity) =>
          capacity.state !==
            (policy.state === AllocationPolicyState.PREPARED
              ? CapacityState.PREPARED
              : CapacityState.OPEN) ||
          capacity.rules_version !== input.expected_rules_version
      )
    ) {
      throw this.invariant("Allocation policy and capacity snapshots disagree")
    }

    const updatedCapacities: ProvisionedCapacity[] = []
    for (const capacity of capacities) {
      const rows = (await manager.execute(
        `update flash_sale_capacity
            set state = ?, version = version + 1, updated_at = now()
          where id = ? and state = ? and version = ?
          returning ${CAPACITY_COLUMNS}`,
        [targetCapacityState, capacity.id, capacity.state, capacity.version]
      )) as CapacityRow[]
      if (!rows[0]) {
        throw this.invariant("Capacity transition CAS failed while locked")
      }
      updatedCapacities.push(mapCapacity(rows[0]))
    }
    const updatedPolicies = (await manager.execute(
      `update flash_sale_allocation_policy
          set state = ?, version = version + 1, updated_at = now()
        where id = ? and state = ? and version = ?
        returning ${POLICY_COLUMNS}`,
      [targetPolicyState, policy.id, policy.state, Number(policy.version)]
    )) as PolicyRow[]
    if (!updatedPolicies[0]) {
      throw this.invariant(
        "Allocation policy transition CAS failed while locked"
      )
    }
    return {
      policy: mapPolicy(updatedPolicies[0]),
      capacities: updatedCapacities,
      replayed: false,
    }
  }

  private async fenceAndCloseCampaignInTransaction(
    manager: SqlEntityManager,
    input: FenceAndCloseCampaignAllocationCommand
  ): Promise<AllocationCampaignFenceResult> {
    await this.lockCampaignControl(manager, input.campaign_id)
    const existingRows = (await manager.execute(
      `select ${FENCE_COLUMNS}
         from flash_sale_allocation_campaign_fence
        where campaign_id = ? and deleted_at is null for update`,
      [input.campaign_id]
    )) as FenceRow[]
    const existing = existingRows[0]
    if (existing) {
      if (existing.disposition !== input.disposition) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCE_CONFLICT,
          `Campaign is already fenced as ${existing.disposition}`
        )
      }
      const snapshot = await this.loadClosedCampaignSnapshot(
        manager,
        input.campaign_id
      )
      return {
        fence: mapFence(existing),
        ...snapshot,
        replayed: true,
      }
    }

    const insertedRows = (await manager.execute(
      `insert into flash_sale_allocation_campaign_fence
        (id, campaign_id, disposition, campaign_version, rules_version, version)
       values (?, ?, ?, ?, ?, 1)
       returning ${FENCE_COLUMNS}`,
      [
        generateEntityId(undefined, "fsafence"),
        input.campaign_id,
        input.disposition,
        input.campaign_version,
        input.rules_version,
      ]
    )) as FenceRow[]
    const fence = insertedRows[0]
    if (!fence) {
      throw this.invariant("Allocation campaign fence insert returned no row")
    }

    const policies = (await manager.execute(
      `select ${POLICY_COLUMNS}
         from flash_sale_allocation_policy
        where campaign_id = ? and deleted_at is null
          and state in (?, ?)
        order by rules_version, id for update`,
      [
        input.campaign_id,
        AllocationPolicyState.PREPARED,
        AllocationPolicyState.OPEN,
      ]
    )) as PolicyRow[]
    const closedPolicies: ProvisionedAllocationPolicy[] = []
    const closedCapacities: ProvisionedCapacity[] = []
    for (const policy of policies) {
      const capacities = await this.lockPolicyCapacities(manager, policy.id)
      if (capacities.length === 0) {
        throw this.invariant("Allocation policy has no capacities")
      }
      const closed = await this.closeLockedPolicy(manager, policy, capacities)
      closedPolicies.push(closed.policy)
      closedCapacities.push(...closed.capacities)
    }
    return {
      fence: mapFence(fence),
      closed_policies: closedPolicies,
      closed_capacities: closedCapacities,
      replayed: false,
    }
  }

  private async closeLockedPolicy(
    manager: SqlEntityManager,
    policy: PolicyRow,
    capacities: readonly ProvisionedCapacity[]
  ): Promise<{
    policy: ProvisionedAllocationPolicy
    capacities: ProvisionedCapacity[]
  }> {
    const expectedCapacityState =
      policy.state === AllocationPolicyState.PREPARED
        ? CapacityState.PREPARED
        : CapacityState.OPEN
    if (
      policy.state !== AllocationPolicyState.PREPARED &&
      policy.state !== AllocationPolicyState.OPEN
    ) {
      throw this.invariant("Only active allocation policies can be closed")
    }
    if (
      capacities.some(
        (capacity) =>
          capacity.state !== expectedCapacityState ||
          capacity.rules_version !== Number(policy.rules_version)
      )
    ) {
      throw this.invariant("Allocation policy and capacity snapshots disagree")
    }
    const updatedCapacities: ProvisionedCapacity[] = []
    for (const capacity of capacities) {
      const rows = (await manager.execute(
        `update flash_sale_capacity
            set state = ?, version = version + 1, updated_at = now()
          where id = ? and state = ? and version = ?
          returning ${CAPACITY_COLUMNS}`,
        [CapacityState.CLOSED, capacity.id, capacity.state, capacity.version]
      )) as CapacityRow[]
      if (!rows[0]) {
        throw this.invariant("Capacity close CAS failed while locked")
      }
      updatedCapacities.push(mapCapacity(rows[0]))
    }
    const policyRows = (await manager.execute(
      `update flash_sale_allocation_policy
          set state = ?, version = version + 1, updated_at = now()
        where id = ? and state = ? and version = ?
        returning ${POLICY_COLUMNS}`,
      [
        AllocationPolicyState.CLOSED,
        policy.id,
        policy.state,
        Number(policy.version),
      ]
    )) as PolicyRow[]
    if (!policyRows[0]) {
      throw this.invariant("Allocation policy close CAS failed while locked")
    }
    return {
      policy: mapPolicy(policyRows[0]),
      capacities: updatedCapacities,
    }
  }

  private async loadClosedCampaignSnapshot(
    manager: SqlEntityManager,
    campaignId: string
  ): Promise<{
    closed_policies: ProvisionedAllocationPolicy[]
    closed_capacities: ProvisionedCapacity[]
  }> {
    const policies = (await manager.execute(
      `select ${POLICY_COLUMNS}
         from flash_sale_allocation_policy
        where campaign_id = ? and deleted_at is null
        order by rules_version, id for update`,
      [campaignId]
    )) as PolicyRow[]
    if (
      policies.some((policy) => policy.state !== AllocationPolicyState.CLOSED)
    ) {
      throw this.invariant("Fenced campaign has an active allocation policy")
    }
    const capacities: ProvisionedCapacity[] = []
    for (const policy of policies) {
      const locked = await this.lockPolicyCapacities(manager, policy.id)
      if (locked.some((capacity) => capacity.state !== CapacityState.CLOSED)) {
        throw this.invariant("Fenced campaign has an active capacity")
      }
      capacities.push(...locked)
    }
    return {
      closed_policies: policies.map(mapPolicy),
      closed_capacities: capacities,
    }
  }

  private async lockCampaignControl(
    manager: SqlEntityManager,
    campaignId: string
  ): Promise<void> {
    await manager.execute(
      "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
      [`${CAMPAIGN_CONTROL_LOCK_NAMESPACE}${campaignId}`]
    )
  }

  private async assertCampaignNotFenced(
    manager: SqlEntityManager,
    campaignId: string
  ): Promise<void> {
    const rows = (await manager.execute(
      `select disposition from flash_sale_allocation_campaign_fence
        where campaign_id = ? and deleted_at is null`,
      [campaignId]
    )) as Array<{ disposition: AllocationFenceDisposition }>
    if (rows[0]) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCED,
        `Campaign allocation is fenced as ${rows[0].disposition}`
      )
    }
  }

  private async lockPolicyCapacities(
    manager: SqlEntityManager,
    policyId: string
  ): Promise<ProvisionedCapacity[]> {
    const rows = (await manager.execute(
      `select ${CAPACITY_COLUMNS} from flash_sale_capacity
        where allocation_policy_id = ? and deleted_at is null
        order by campaign_item_id, shard_no for update`,
      [policyId]
    )) as CapacityRow[]
    return rows.map(mapCapacity)
  }

  private async claimInTransaction(
    manager: SqlEntityManager,
    input: ClaimAttemptPersistenceInput
  ): Promise<ClaimAttemptResult> {
    const replay = await this.findByIdentity(manager, input)
    if (replay) {
      return await this.resolveClaimReplay(
        manager,
        replay,
        input.request_hash,
        input.items
      )
    }
    const policies = (await manager.execute(
      `select id, rules_version, state, per_subject_limit,
              (now() >= starts_at and now() < ends_at) as is_in_window,
              least(now() + hold_ttl_seconds * interval '1 second', ends_at) as expires_at
         from flash_sale_allocation_policy
        where campaign_id = ? and deleted_at is null
        order by case state when 'open' then 0 when 'prepared' then 1 else 2 end,
                 rules_version desc limit 1`,
      [input.campaign_id]
    )) as PolicyRow[]
    const policy = policies[0]
    if (
      !policy ||
      policy.state !== AllocationPolicyState.OPEN ||
      !policy.is_in_window
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
        "The flash sale is not active"
      )
    }
    if (Number(policy.rules_version) !== input.expected_rules_version) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.STALE_RULES_VERSION,
        "The allocation policy rules version does not match the request"
      )
    }
    const inserted = (await manager.execute(
      `insert into flash_sale_purchase_attempt
        (id, allocation_policy_id, campaign_id, subject_id, cart_id,
         idempotency_key_hash, request_hash, state, rules_version, expires_at, version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) on conflict do nothing
       returning ${ATTEMPT_COLUMNS}`,
      [
        generateEntityId(undefined, "fsatt"),
        policy.id,
        input.campaign_id,
        input.subject_id,
        input.cart_id,
        input.idempotency_key_hash,
        input.request_hash,
        PurchaseAttemptState.PENDING,
        input.expected_rules_version,
        policy.expires_at,
      ]
    )) as AttemptRow[]
    if (inserted[0]) {
      return { attempt: mapAttempt(inserted[0]), replayed: false }
    }
    const existing = await this.findByIdentity(manager, input)
    if (!existing) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.CART_ATTEMPT_CONFLICT,
        "The cart already has a live purchase attempt for this campaign"
      )
    }
    return await this.resolveClaimReplay(
      manager,
      existing,
      input.request_hash,
      input.items
    )
  }

  private async holdInTransaction(
    manager: SqlEntityManager,
    input: HoldQuotaPersistenceInput
  ): Promise<HoldQuotaResult> {
    // Global lock order: Attempt -> Subject -> sorted Capacities -> sorted Holds.
    // Policy is an immutable execution snapshot and is read without a lock.
    const attempts = (await manager.execute(
      `select ${ATTEMPT_COLUMNS}, (expires_at > now()) as is_unexpired
         from flash_sale_purchase_attempt
        where id = ? and deleted_at is null for update`,
      [input.attempt_id]
    )) as Array<AttemptRow & { is_unexpired: boolean }>
    const attempt = attempts[0]
    if (!attempt) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        "Purchase attempt does not exist"
      )
    }
    this.assertAttemptIdentity(attempt, input)
    if (attempt.state === PurchaseAttemptState.QUOTA_HELD) {
      const holds = await this.lockHolds(manager, attempt.id)
      await verifyAllocationOutboxReplay(manager, mapAttempt(attempt), holds)
      return {
        status: "held",
        attempt: mapAttempt(attempt),
        holds,
        replayed: true,
      }
    }
    if (attempt.state === PurchaseAttemptState.QUOTA_REJECTED) {
      await verifyAllocationOutboxReplay(
        manager,
        mapAttempt(attempt),
        [],
        input.items
      )
      return {
        status: "rejected",
        attempt: mapAttempt(attempt),
        error_code: attempt.last_error_code as AllocationCommandErrorCode,
        replayed: true,
      }
    }
    if (attempt.state !== PurchaseAttemptState.PENDING) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        `Purchase attempt is already ${attempt.state}`
      )
    }
    if (!attempt.is_unexpired) {
      return await this.rejectAttempt(
        manager,
        attempt,
        AllocationCommandErrorCode.HOLD_EXPIRED,
        input.items
      )
    }

    const policies = (await manager.execute(
      `select id, rules_version, state, per_subject_limit,
              (now() >= starts_at and now() < ends_at) as is_in_window,
              ends_at as expires_at
         from flash_sale_allocation_policy
        where id = ? and deleted_at is null`,
      [attempt.allocation_policy_id]
    )) as PolicyRow[]
    const policy = policies[0]
    if (
      !policy ||
      policy.state !== AllocationPolicyState.OPEN ||
      !policy.is_in_window
    ) {
      return await this.rejectAttempt(
        manager,
        attempt,
        AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
        input.items
      )
    }
    if (
      Number(policy.rules_version) !== input.expected_rules_version ||
      Number(attempt.rules_version) !== Number(policy.rules_version)
    ) {
      return await this.rejectAttempt(
        manager,
        attempt,
        AllocationCommandErrorCode.STALE_RULES_VERSION,
        input.items
      )
    }

    const limit = Number(policy.per_subject_limit)
    await manager.execute(
      `insert into flash_sale_subject_allocation
        (id, campaign_id, subject_id, limit_quantity, held_quantity,
         consumed_quantity, rules_version, version, raw_limit_quantity,
         raw_held_quantity, raw_consumed_quantity)
       values (?, ?, ?, ?, 0, 0, ?, 1,
         jsonb_build_object('value', ?::text, 'precision', 20),
         jsonb_build_object('value', '0', 'precision', 20),
         jsonb_build_object('value', '0', 'precision', 20))
       on conflict (campaign_id, subject_id) do nothing`,
      [
        generateEntityId(undefined, "fssub"),
        input.campaign_id,
        input.subject_id,
        limit,
        input.expected_rules_version,
        limit,
      ]
    )
    const subjects = (await manager.execute(
      `select id, limit_quantity, held_quantity, consumed_quantity, rules_version, version
         from flash_sale_subject_allocation
        where campaign_id = ? and subject_id = ? and deleted_at is null for update`,
      [input.campaign_id, input.subject_id]
    )) as SubjectRow[]
    const subject = subjects[0]
    if (!subject) {
      throw this.invariant("Subject allocation disappeared after upsert")
    }

    const itemIds = input.items.map((item) => item.campaign_item_id)
    const placeholders = itemIds.map(() => "?").join(", ")
    const capacities = (await manager.execute(
      `select id, campaign_item_id, shard_no, state, granted_quantity,
              held_quantity, consumed_quantity, rules_version, version
         from flash_sale_capacity
        where allocation_policy_id = ? and campaign_item_id in (${placeholders})
          and shard_no = 0 and deleted_at is null
        order by campaign_item_id, shard_no for update`,
      [policy.id, ...itemIds]
    )) as CapacityRow[]
    const existingHolds = await this.lockHolds(manager, attempt.id)
    if (existingHolds.length > 0) {
      throw this.invariant(
        "Pending purchase attempt already has allocation holds"
      )
    }

    if (
      Number(subject.rules_version) !== input.expected_rules_version ||
      Number(subject.limit_quantity) !== limit
    ) {
      return await this.rejectAttempt(
        manager,
        attempt,
        AllocationCommandErrorCode.STALE_RULES_VERSION,
        input.items
      )
    }
    const total = input.items.reduce((sum, item) => sum + item.quantity, 0)
    if (!Number.isSafeInteger(total)) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.INVALID_COMMAND,
        "Total allocation quantity must be a safe integer"
      )
    }
    if (
      Number(subject.held_quantity) +
        Number(subject.consumed_quantity) +
        total >
      Number(subject.limit_quantity)
    ) {
      return await this.rejectAttempt(
        manager,
        attempt,
        AllocationCommandErrorCode.PURCHASE_LIMIT_EXCEEDED,
        input.items
      )
    }

    const capacityByItem = new Map(
      capacities.map((capacity) => [capacity.campaign_item_id, capacity])
    )
    for (const item of input.items) {
      const capacity = capacityByItem.get(item.campaign_item_id)
      if (!capacity) {
        return await this.rejectAttempt(
          manager,
          attempt,
          AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
          input.items
        )
      }
      if (Number(capacity.rules_version) !== input.expected_rules_version) {
        return await this.rejectAttempt(
          manager,
          attempt,
          AllocationCommandErrorCode.STALE_RULES_VERSION,
          input.items
        )
      }
      if (
        capacity.state !== CapacityState.OPEN ||
        Number(capacity.held_quantity) +
          Number(capacity.consumed_quantity) +
          item.quantity >
          Number(capacity.granted_quantity)
      ) {
        return await this.rejectAttempt(
          manager,
          attempt,
          AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
          input.items
        )
      }
    }

    const subjectUpdates = (await manager.execute(
      `update flash_sale_subject_allocation
          set held_quantity = held_quantity + ?,
              raw_held_quantity = jsonb_build_object(
                'value', (held_quantity + ?)::text, 'precision', 20),
              version = version + 1, updated_at = now()
        where id = ? and version = ?
          and held_quantity + consumed_quantity + ? <= limit_quantity
        returning id`,
      [total, total, subject.id, Number(subject.version), total]
    )) as Array<{ id: string }>
    if (!subjectUpdates[0]) {
      throw this.invariant("Subject allocation CAS failed while locked")
    }

    const holds: ClaimedAllocationHold[] = []
    for (const item of input.items) {
      const capacity = capacityByItem.get(item.campaign_item_id)!
      const capacityUpdates = (await manager.execute(
        `update flash_sale_capacity
            set held_quantity = held_quantity + ?,
                raw_held_quantity = jsonb_build_object(
                  'value', (held_quantity + ?)::text, 'precision', 20),
                version = version + 1, updated_at = now()
          where id = ? and state = ? and version = ?
            and held_quantity + consumed_quantity + ? <= granted_quantity
          returning id`,
        [
          item.quantity,
          item.quantity,
          capacity.id,
          CapacityState.OPEN,
          Number(capacity.version),
          item.quantity,
        ]
      )) as Array<{ id: string }>
      if (!capacityUpdates[0]) {
        throw this.invariant("Capacity CAS failed while locked")
      }
      const inserted = (await manager.execute(
        `insert into flash_sale_allocation_hold
          (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
           expires_at, version, raw_quantity)
         values (?, ?, ?, ?, ?, ?, ?, 1,
                 jsonb_build_object('value', ?::text, 'precision', 20))
         returning ${HOLD_COLUMNS}`,
        [
          generateEntityId(undefined, "fsahold"),
          attempt.id,
          capacity.id,
          item.campaign_item_id,
          item.quantity,
          AllocationHoldState.HELD,
          attempt.expires_at,
          item.quantity,
        ]
      )) as HoldRow[]
      holds.push(mapHold(inserted[0]))
    }
    const attemptUpdates = (await manager.execute(
      `update flash_sale_purchase_attempt
          set state = ?, version = version + 1, updated_at = now()
        where id = ? and state = ? and version = ?
        returning ${ATTEMPT_COLUMNS}`,
      [
        PurchaseAttemptState.QUOTA_HELD,
        attempt.id,
        PurchaseAttemptState.PENDING,
        Number(attempt.version),
      ]
    )) as AttemptRow[]
    if (!attemptUpdates[0]) {
      throw this.invariant("Purchase attempt CAS failed while locked")
    }
    const updatedAttempt = mapAttempt(attemptUpdates[0])
    await this.appendTransitionOutbox(manager, updatedAttempt, holds)
    return {
      status: "held",
      attempt: updatedAttempt,
      holds,
      replayed: false,
    }
  }

  private async authorizeSettlementInTransaction(
    manager: SqlEntityManager,
    attemptId: string,
    settlementId: string
  ): Promise<SettleQuotaResult> {
    const attempts = (await manager.execute(
      `select ${ATTEMPT_COLUMNS}
         from flash_sale_purchase_attempt
        where id = ? and deleted_at is null for update`,
      [attemptId]
    )) as AttemptRow[]
    const attempt = attempts[0]
    if (!attempt) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        "Purchase attempt does not exist"
      )
    }
    if (
      attempt.state !== PurchaseAttemptState.QUOTA_COMMITTING ||
      attempt.settlement_id !== settlementId
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        "Purchase attempt is not authorized for this settlement"
      )
    }
    const holds = await this.lockHolds(manager, attempt.id)
    if (
      holds.length === 0 ||
      holds.some((hold) => hold.state !== AllocationHoldState.HELD)
    ) {
      throw this.invariant("Committing purchase attempt must have held quota")
    }
    await verifyAllocationOutboxReplay(manager, mapAttempt(attempt), holds)
    return { attempt: mapAttempt(attempt), holds, replayed: true }
  }

  private async beginSettlementInTransaction(
    manager: SqlEntityManager,
    attemptId: string,
    settlementId: string
  ): Promise<SettleQuotaResult> {
    const attempts = (await manager.execute(
      `select ${ATTEMPT_COLUMNS}
         from flash_sale_purchase_attempt
        where id = ? and deleted_at is null for update`,
      [attemptId]
    )) as AttemptRow[]
    const attempt = attempts[0]
    if (!attempt) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        "Purchase attempt does not exist"
      )
    }
    if (attempt.state === PurchaseAttemptState.QUOTA_COMMITTING) {
      if (attempt.settlement_id !== settlementId) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
          "Purchase attempt is already committing under another settlement"
        )
      }
      const holds = await this.lockHolds(manager, attempt.id)
      if (
        holds.length === 0 ||
        holds.some((hold) => hold.state !== AllocationHoldState.HELD)
      ) {
        throw this.invariant("Committing purchase attempt must have held quota")
      }
      await verifyAllocationOutboxReplay(manager, mapAttempt(attempt), holds)
      return { attempt: mapAttempt(attempt), holds, replayed: true }
    }
    if (attempt.state !== PurchaseAttemptState.QUOTA_HELD) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        `Purchase attempt cannot begin settlement from ${attempt.state}`
      )
    }
    const holds = await this.lockHolds(manager, attempt.id)
    if (
      holds.length === 0 ||
      holds.some((hold) => hold.state !== AllocationHoldState.HELD)
    ) {
      throw this.invariant("Held purchase attempt must have held quota")
    }
    const now = await this.databaseNow(manager)
    if (asDate(attempt.expires_at).getTime() <= now.getTime()) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.HOLD_EXPIRED,
        "Purchase attempt hold expired before settlement began"
      )
    }
    const updated = (await manager.execute(
      `update flash_sale_purchase_attempt
          set state = ?, settlement_id = ?, settlement_started_at = ?::timestamptz,
              version = version + 1, updated_at = ?::timestamptz
        where id = ? and state = ? and version = ?
        returning ${ATTEMPT_COLUMNS}`,
      [
        PurchaseAttemptState.QUOTA_COMMITTING,
        settlementId,
        now,
        now,
        attempt.id,
        PurchaseAttemptState.QUOTA_HELD,
        Number(attempt.version),
      ]
    )) as AttemptRow[]
    if (!updated[0]) {
      throw this.invariant("Purchase attempt begin settlement CAS failed")
    }
    const updatedAttempt = mapAttempt(updated[0])
    await this.appendTransitionOutbox(manager, updatedAttempt, holds)
    return { attempt: updatedAttempt, holds, replayed: false }
  }

  private async settleInTransaction(
    manager: SqlEntityManager,
    attemptId: string,
    disposition: "consume" | "release" | "cancel" | "expire",
    settlementId?: string
  ): Promise<SettleQuotaResult> {
    const targetAttemptState =
      disposition === "consume"
        ? PurchaseAttemptState.QUOTA_CONSUMED
        : disposition === "release" || disposition === "cancel"
        ? PurchaseAttemptState.QUOTA_RELEASED
        : PurchaseAttemptState.QUOTA_EXPIRED
    const targetHoldState =
      disposition === "consume"
        ? AllocationHoldState.CONSUMED
        : disposition === "release" || disposition === "cancel"
        ? AllocationHoldState.RELEASED
        : AllocationHoldState.EXPIRED

    // Settlement obeys the same global lock order as admission:
    // Attempt -> Subject -> sorted Capacities -> sorted Holds. Once a held
    // Attempt is locked, its immutable Hold identity set cannot be added to or
    // removed from, so it is safe to discover capacity ids before taking the
    // ordered Capacity and Hold locks.
    const attempts = (await manager.execute(
      `select ${ATTEMPT_COLUMNS}
         from flash_sale_purchase_attempt
        where id = ? and deleted_at is null for update`,
      [attemptId]
    )) as AttemptRow[]
    const attempt = attempts[0]
    if (!attempt) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        "Purchase attempt does not exist"
      )
    }
    const expectedSourceState = settlementId
      ? PurchaseAttemptState.QUOTA_COMMITTING
      : PurchaseAttemptState.QUOTA_HELD
    if (
      attempt.state !== expectedSourceState &&
      attempt.state !== targetAttemptState
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        `Purchase attempt cannot ${disposition} from ${attempt.state}`
      )
    }
    if (
      settlementId
        ? attempt.settlement_id !== settlementId
        : attempt.settlement_id !== null
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        "Purchase attempt settlement identity does not match the command"
      )
    }
    const holdIdentities = (await manager.execute(
      `select id, capacity_id, campaign_item_id
         from flash_sale_allocation_hold
        where attempt_id = ? and deleted_at is null
        order by campaign_item_id`,
      [attempt.id]
    )) as Array<{
      id: string
      capacity_id: string
      campaign_item_id: string
    }>
    if (holdIdentities.length === 0) {
      throw this.invariant("Settled purchase attempt has no allocation holds")
    }

    const subjects = (await manager.execute(
      `select id, limit_quantity, held_quantity, consumed_quantity, rules_version, version
         from flash_sale_subject_allocation
        where campaign_id = ? and subject_id = ? and deleted_at is null for update`,
      [attempt.campaign_id, attempt.subject_id]
    )) as SubjectRow[]
    const subject = subjects[0]
    if (!subject) {
      throw this.invariant("Purchase attempt has no subject allocation")
    }

    const capacityIds = holdIdentities.map((hold) => hold.capacity_id)
    const capacityPlaceholders = capacityIds.map(() => "?").join(", ")
    const capacities = (await manager.execute(
      `select id, campaign_item_id, shard_no, state, granted_quantity,
              held_quantity, consumed_quantity, rules_version, version
         from flash_sale_capacity
        where id in (${capacityPlaceholders}) and deleted_at is null
        order by campaign_item_id, shard_no for update`,
      capacityIds
    )) as CapacityRow[]
    const holds = await this.lockHolds(manager, attempt.id)
    if (
      holds.length !== holdIdentities.length ||
      capacities.length !== holdIdentities.length
    ) {
      throw this.invariant("Settlement hold or capacity identity set changed")
    }

    if (attempt.state === targetAttemptState) {
      if (holds.some((hold) => hold.state !== targetHoldState)) {
        throw this.invariant("Terminal attempt and hold states disagree")
      }
      await verifyAllocationOutboxReplay(manager, mapAttempt(attempt), holds)
      return { attempt: mapAttempt(attempt), holds, replayed: true }
    }
    const settledAt = await this.databaseNow(manager)
    const expired = asDate(attempt.expires_at).getTime() <= settledAt.getTime()
    if (disposition === "expire" && !expired) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.HOLD_NOT_EXPIRED,
        "Purchase attempt hold has not expired"
      )
    }
    if (disposition === "cancel" && expired) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.HOLD_EXPIRED,
        "Expired quota must be resolved through the expiry command"
      )
    }
    if (holds.some((hold) => hold.state !== AllocationHoldState.HELD)) {
      throw this.invariant("Held purchase attempt contains a terminal hold")
    }

    const total = holds.reduce((sum, hold) => sum + hold.quantity, 0)
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw this.invariant("Settlement quantity is not a positive safe integer")
    }
    const capacityById = new Map(
      capacities.map((capacity) => [capacity.id, capacity])
    )
    for (const hold of holds) {
      const capacity = capacityById.get(hold.capacity_id)
      if (
        !capacity ||
        capacity.campaign_item_id !== hold.campaign_item_id ||
        Number(capacity.held_quantity) < hold.quantity
      ) {
        throw this.invariant("Capacity cannot satisfy settlement hold")
      }
    }
    if (Number(subject.held_quantity) < total) {
      throw this.invariant("Subject allocation cannot satisfy settlement holds")
    }

    const subjectRows = (await manager.execute(
      disposition === "consume"
        ? `update flash_sale_subject_allocation
              set held_quantity = held_quantity - ?,
                  consumed_quantity = consumed_quantity + ?,
                  raw_held_quantity = jsonb_build_object(
                    'value', (held_quantity - ?)::text, 'precision', 20),
                  raw_consumed_quantity = jsonb_build_object(
                    'value', (consumed_quantity + ?)::text, 'precision', 20),
                  version = version + 1, updated_at = ?::timestamptz
            where id = ? and version = ? and held_quantity >= ?
            returning id`
        : `update flash_sale_subject_allocation
              set held_quantity = held_quantity - ?,
                  raw_held_quantity = jsonb_build_object(
                    'value', (held_quantity - ?)::text, 'precision', 20),
                  version = version + 1, updated_at = ?::timestamptz
            where id = ? and version = ? and held_quantity >= ?
            returning id`,
      disposition === "consume"
        ? [
            total,
            total,
            total,
            total,
            settledAt,
            subject.id,
            Number(subject.version),
            total,
          ]
        : [total, total, settledAt, subject.id, Number(subject.version), total]
    )) as Array<{ id: string }>
    if (!subjectRows[0]) {
      throw this.invariant("Subject settlement CAS failed while locked")
    }
    if (disposition === "expire") {
      await this.faultInjector?.hit("during_expiry_release", attempt.id)
    }

    for (const capacity of capacities) {
      const quantity = holds
        .filter((hold) => hold.capacity_id === capacity.id)
        .reduce((sum, hold) => sum + hold.quantity, 0)
      const capacityRows = (await manager.execute(
        disposition === "consume"
          ? `update flash_sale_capacity
                set held_quantity = held_quantity - ?,
                    consumed_quantity = consumed_quantity + ?,
                    raw_held_quantity = jsonb_build_object(
                      'value', (held_quantity - ?)::text, 'precision', 20),
                    raw_consumed_quantity = jsonb_build_object(
                      'value', (consumed_quantity + ?)::text, 'precision', 20),
                    version = version + 1, updated_at = ?::timestamptz
              where id = ? and state = ? and version = ? and held_quantity >= ?
              returning id`
          : `update flash_sale_capacity
                set held_quantity = held_quantity - ?,
                    raw_held_quantity = jsonb_build_object(
                      'value', (held_quantity - ?)::text, 'precision', 20),
                    version = version + 1, updated_at = ?::timestamptz
              where id = ? and state = ? and version = ? and held_quantity >= ?
              returning id`,
        disposition === "consume"
          ? [
              quantity,
              quantity,
              quantity,
              quantity,
              settledAt,
              capacity.id,
              capacity.state,
              Number(capacity.version),
              quantity,
            ]
          : [
              quantity,
              quantity,
              settledAt,
              capacity.id,
              capacity.state,
              Number(capacity.version),
              quantity,
            ]
      )) as Array<{ id: string }>
      if (!capacityRows[0]) {
        throw this.invariant("Capacity settlement CAS failed while locked")
      }
    }

    const resolvedHolds: ClaimedAllocationHold[] = []
    for (const hold of holds) {
      const rows = (await manager.execute(
        `update flash_sale_allocation_hold
            set state = ?, resolved_at = ?::timestamptz,
                version = version + 1, updated_at = ?::timestamptz
          where id = ? and state = ? and version = ?
          returning ${HOLD_COLUMNS}`,
        [
          targetHoldState,
          settledAt,
          settledAt,
          hold.id,
          AllocationHoldState.HELD,
          hold.version,
        ]
      )) as HoldRow[]
      if (!rows[0]) {
        throw this.invariant(
          "Allocation hold settlement CAS failed while locked"
        )
      }
      resolvedHolds.push(mapHold(rows[0]))
    }

    const settledAttempts = (await manager.execute(
      `update flash_sale_purchase_attempt
          set state = ?, terminal_at = ?::timestamptz,
              version = version + 1, updated_at = ?::timestamptz
        where id = ? and state = ? and version = ?
        returning ${ATTEMPT_COLUMNS}`,
      [
        targetAttemptState,
        settledAt,
        settledAt,
        attempt.id,
        expectedSourceState,
        Number(attempt.version),
      ]
    )) as AttemptRow[]
    if (!settledAttempts[0]) {
      throw this.invariant(
        "Purchase attempt settlement CAS failed while locked"
      )
    }
    const settledAttempt = mapAttempt(settledAttempts[0])
    await this.appendTransitionOutbox(manager, settledAttempt, resolvedHolds)
    return {
      attempt: settledAttempt,
      holds: resolvedHolds,
      replayed: false,
    }
  }

  private assertAttemptIdentity(
    attempt: AttemptRow,
    input: HoldQuotaPersistenceInput
  ) {
    if (attempt.request_hash !== input.request_hash) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT,
        "Purchase attempt does not match the canonical business request"
      )
    }
    if (
      attempt.campaign_id !== input.campaign_id ||
      attempt.subject_id !== input.subject_id ||
      attempt.cart_id !== input.cart_id
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        "Purchase attempt identity does not match the command"
      )
    }
    if (Number(attempt.rules_version) !== input.expected_rules_version) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.STALE_RULES_VERSION,
        "Purchase attempt rules version does not match the command"
      )
    }
  }

  private async rejectAttempt(
    manager: SqlEntityManager,
    attempt: AttemptRow,
    errorCode: AllocationCommandErrorCode,
    requestedItems: readonly Readonly<{
      campaign_item_id: string
      quantity: number
    }>[]
  ): Promise<HoldQuotaResult> {
    const rows = (await manager.execute(
      `update flash_sale_purchase_attempt
          set state = ?, last_error_code = ?, terminal_at = now(),
              version = version + 1, updated_at = now()
        where id = ? and state = ? and version = ?
        returning ${ATTEMPT_COLUMNS}`,
      [
        PurchaseAttemptState.QUOTA_REJECTED,
        errorCode,
        attempt.id,
        PurchaseAttemptState.PENDING,
        Number(attempt.version),
      ]
    )) as AttemptRow[]
    if (!rows[0]) {
      throw this.invariant("Purchase attempt rejection CAS failed while locked")
    }
    const rejectedAttempt = mapAttempt(rows[0])
    await this.appendTransitionOutbox(
      manager,
      rejectedAttempt,
      [],
      requestedItems
    )
    return {
      status: "rejected",
      attempt: rejectedAttempt,
      error_code: errorCode,
      replayed: false,
    }
  }

  private async lockHolds(manager: SqlEntityManager, attemptId: string) {
    const rows = (await manager.execute(
      `select ${HOLD_COLUMNS} from flash_sale_allocation_hold
        where attempt_id = ? and deleted_at is null
        order by campaign_item_id for update`,
      [attemptId]
    )) as HoldRow[]
    return rows.map(mapHold)
  }

  private async appendTransitionOutbox(
    manager: SqlEntityManager,
    attempt: ClaimedPurchaseAttempt,
    holds: readonly ClaimedAllocationHold[],
    requestedItems: readonly Readonly<{
      campaign_item_id: string
      quantity: number
    }>[] = []
  ): Promise<void> {
    await this.faultInjector?.hit(
      "after_domain_transition_before_outbox",
      attempt.id
    )
    await appendAllocationOutboxEvent(manager, attempt, holds, requestedItems)
    await this.faultInjector?.hit("after_outbox_append_before_commit", attempt.id)
  }

  private async findByIdentity(
    manager: SqlEntityManager,
    input: Pick<
      ClaimAttemptPersistenceInput,
      "campaign_id" | "subject_id" | "idempotency_key_hash"
    >
  ) {
    const rows = (await manager.execute(
      `select ${ATTEMPT_COLUMNS} from flash_sale_purchase_attempt
        where campaign_id = ? and subject_id = ? and idempotency_key_hash = ?
        limit 1 for update`,
      [input.campaign_id, input.subject_id, input.idempotency_key_hash]
    )) as AttemptRow[]
    return rows[0]
  }

  private async resolveClaimReplay(
    manager: SqlEntityManager,
    existing: AttemptRow,
    requestHash: string,
    requestedItems: readonly Readonly<{
      campaign_item_id: string
      quantity: number
    }>[]
  ): Promise<ClaimAttemptResult> {
    if (existing.request_hash !== requestHash) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT,
        "The idempotency identity was already used for another request"
      )
    }
    const attempt = mapAttempt(existing)
    if (attempt.state !== PurchaseAttemptState.PENDING) {
      const holds = await this.lockHolds(manager, attempt.id)
      await verifyAllocationOutboxReplay(
        manager,
        attempt,
        holds,
        requestedItems
      )
    }
    return { attempt, replayed: true }
  }

  private invariant(message: string) {
    return new AllocationCommandError(
      AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION,
      message
    )
  }
}

export interface AllocationFaultInjector {
  hit(
    name:
      | "during_expiry_release"
      | "after_domain_transition_before_outbox"
      | "after_outbox_append_before_commit",
    attemptId: string
  ): void | Promise<void>
}
