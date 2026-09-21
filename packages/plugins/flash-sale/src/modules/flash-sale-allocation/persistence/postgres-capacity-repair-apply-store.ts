import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AppliedCapacityRepairAction,
  ApplyCapacityRepairResult,
  CapacityRepairApplyStore,
  compareRepairPlanKeys,
  PreparedApplyCapacityRepairCommand,
  repairPlanDigest,
} from "../application"
import { LedgerReconciliationIssueCode } from "../domain"
import {
  ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE,
  AllocationOutboxEventName,
  hashAllocationEventIdentity,
} from "../../../shared"
import { lockAllocationMovementWriter } from "./capacity-movement-producer"
import {
  PostgresCapacityRepairPlanStore,
  RepairActionRow,
} from "./postgres-capacity-repair-plan-store"
import {
  MovementLedgerReconciliationEvidence,
  PostgresMovementLedgerReconciliationStore,
} from "./postgres-movement-ledger-reconciliation-store"

const CAMPAIGN_LOCK_NAMESPACE = "flash-sale-allocation-campaign:"
const APPROVAL_JTI_UNIQUE_CONSTRAINT =
  "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique"
const PLAN_RUN_UNIQUE_CONSTRAINT =
  "IDX_flash_sale_capacity_repair_apply_run_plan_unique"
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"])
const EVENT_NAME = AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED
const AGGREGATE_TYPE = ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE
const SAFE_CODES = new Set<string>([
  LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.CONSUMED_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.RAW_MIRROR_DRIFT,
])
const DECIMAL = /^(0|[1-9][0-9]*)$/

export type CapacityRepairApplyFaultPoint =
  | "after_business_locks"
  | "after_capacity_cas"
  | "after_outbox_before_commit"
  | "after_commit_before_response"

export interface CapacityRepairApplyFaultInjector {
  hit(point: CapacityRepairApplyFaultPoint, identity: string): Promise<void>
}

type ApplyStoreOptions = Readonly<{
  application_name?: string
  fault_injector?: CapacityRepairApplyFaultInjector
}>

type LockedBusinessScope = Readonly<{
  policies: readonly Readonly<{
    id: string
    state: string
    deleted_at: Date | string | null
  }>[]
  capacities: readonly Readonly<{
    id: string
    allocation_policy_id: string
    state: string
    deleted_at: Date | string | null
  }>[]
}>

type ApplyRunRow = Readonly<{
  id: string
  plan_run_id: string
  plan_schema_version: string
  campaign_id: string
  command_digest: string
  plan_evidence_digest: string
  ordered_action_set_digest: string
  approval_token_digest: string
  approval_claims_digest: string
  approval_reference_digest: string
  approver: string
  approval_issuer: string
  approval_audience: string
  approval_tenant: string
  approval_jti_digest: string
  approval_permission_version: string
  approval_roles: unknown
  approval_purpose: string
  approval_issued_at: Date | string
  approval_not_before: Date | string
  approval_expires_at: Date | string
  requester: string
  reason: string
  ticket: string
  status: string
  result_digest: string
  finished_at: Date | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type ApplyActionRow = Readonly<{
  id: string
  apply_run_id: string
  plan_action_id: string
  capacity_id: string
  before_capacity_version: string
  after_capacity_version: string
  before_granted_quantity: string
  before_held_quantity: string
  before_consumed_quantity: string
  before_raw_granted_quantity: string
  before_raw_held_quantity: string
  before_raw_consumed_quantity: string
  after_granted_quantity: string
  after_held_quantity: string
  after_consumed_quantity: string
  after_raw_granted_quantity: string
  after_raw_held_quantity: string
  after_raw_consumed_quantity: string
  evidence_digest: string
  status: string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type ApplyIdentityRow = Readonly<{
  id: string
  request_identity_digest: string
  apply_run_id: string
  command_digest: string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type OutboxRow = Readonly<{
  id: string
  event_name: string
  schema_version: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: string
  event_hash: string
  payload: unknown
  status: string
  available_at: Date | string
  occurred_at: Date | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

function invariant(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.REPAIR_APPLY_INVARIANT_VIOLATION,
    message
  )
}

function conflict(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.REPAIR_APPLY_CONFLICT,
    message
  )
}

function errorField(error: unknown, field: "code" | "constraint"): unknown {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    if (record[field] !== undefined) return record[field]
    current = record.cause ?? record.originalError ?? record.driverError
  }
  return undefined
}

function isExactApplyConsumptionConflict(error: unknown): boolean {
  return (
    errorField(error, "code") === "23505" &&
    (errorField(error, "constraint") === APPROVAL_JTI_UNIQUE_CONSTRAINT ||
      errorField(error, "constraint") === PLAN_RUN_UNIQUE_CONSTRAINT)
  )
}

export function rethrowCapacityRepairApplyPersistenceError(
  error: unknown,
  exhaustedTransactionRetry = false
): never {
  if (isExactApplyConsumptionConflict(error)) {
    conflict(
      "repair Plan or approval JTI was already consumed by another Apply"
    )
  }
  if (
    exhaustedTransactionRetry &&
    RETRYABLE_TRANSACTION_CODES.has(String(errorField(error, "code")))
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
      "capacity repair Apply transaction must be retried"
    )
  }
  throw error
}

export function shouldRetryCapacityRepairApplyTransaction(
  error: unknown
): boolean {
  return (
    RETRYABLE_TRANSACTION_CODES.has(String(errorField(error, "code"))) ||
    isExactApplyConsumptionConflict(error)
  )
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${repairPlanDigest(value).slice(0, 26)}`
}

function iso(value: Date | string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()))
    invariant("invalid Apply audit timestamp")
  return parsed.toISOString()
}

function same(left: unknown, right: unknown): boolean {
  return repairPlanDigest(left) === repairPlanDigest(right)
}

function decimal(value: string, field: string): bigint {
  if (!DECIMAL.test(value)) invariant(`${field} is not a canonical decimal`)
  return BigInt(value)
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

function actionContent(row: Omit<ApplyActionRow, "evidence_digest">) {
  return {
    ...row,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

function actionEvidenceDigest(row: Omit<ApplyActionRow, "evidence_digest">) {
  return repairPlanDigest({
    schema: "capacity-repair-apply-action-receipt-v1",
    ...actionContent(row),
  })
}

function publicAction(row: ApplyActionRow): AppliedCapacityRepairAction {
  return Object.freeze({
    id: row.id,
    plan_action_id: row.plan_action_id,
    capacity_id: row.capacity_id,
    before_capacity_version: row.before_capacity_version,
    after_capacity_version: row.after_capacity_version,
    before_held_quantity: row.before_held_quantity,
    before_consumed_quantity: row.before_consumed_quantity,
    after_held_quantity: row.after_held_quantity,
    after_consumed_quantity: row.after_consumed_quantity,
    evidence_digest: row.evidence_digest,
  })
}

export class PostgresCapacityRepairApplyStore
  implements CapacityRepairApplyStore
{
  constructor(
    private readonly baseRepository: DAL.RepositoryService,
    private readonly options: ApplyStoreOptions = {}
  ) {}

  async applyCapacityRepair(
    input: PreparedApplyCapacityRepairCommand
  ): Promise<ApplyCapacityRepairResult> {
    let result!: ApplyCapacityRepairResult
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.withSessionIdentityLock(input, async (manager) => {
          let outcome: ApplyCapacityRepairResult | undefined
          let lockedScope: LockedBusinessScope | undefined
          const planStore = new PostgresCapacityRepairPlanStore(
            this.baseRepository
          )
          const reconciler = new PostgresMovementLedgerReconciliationStore(
            this.baseRepository,
            {
              beforeSnapshot: async (lockedManager) => {
                lockedScope = await this.lockBusinessScope(lockedManager, input)
              },
              resultComputed: async (lockedManager, computed, evidence) => {
                const replay = await this.verifyReplay(lockedManager, input)
                if (replay) {
                  outcome = replay
                  return
                }
                if (!lockedScope)
                  invariant("Apply business scope was not locked")
                this.assertClosedBusinessScope(lockedScope)
                const plan = await planStore.verifyPlanForApply(
                  lockedManager,
                  {
                    plan_run_id: input.plan_run_id,
                    expected_evidence_digest:
                      input.expected_plan_evidence_digest,
                    ordered_action_ids: input.ordered_action_ids,
                    statement_timeout_ms: input.statement_timeout_ms,
                  },
                  computed.snapshot_at,
                  evidence
                )
                if (plan.campaign_id !== input.campaign_id) {
                  invariant("approval Campaign does not match the repair Plan")
                }
                outcome = await this.applyFresh(
                  lockedManager,
                  input,
                  plan.actions
                )
              },
            },
            "repair_plan"
          )
          await reconciler.reconcileInTransaction(manager, {
            campaign_id: input.campaign_id,
            sample_limit: 100,
            statement_timeout_ms: input.statement_timeout_ms,
            batch_size: 500,
          })
          if (!outcome) invariant("Apply transaction produced no outcome")
          return outcome
        })
        break
      } catch (error) {
        if (attempt === 0 && shouldRetryCapacityRepairApplyTransaction(error)) {
          continue
        }
        rethrowCapacityRepairApplyPersistenceError(error, attempt > 0)
      }
    }
    if (result.disposition === "fresh") {
      await this.options.fault_injector?.hit(
        "after_commit_before_response",
        input.request_identity_digest
      )
    }
    return result
  }

  private async lockBusinessScope(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand
  ): Promise<LockedBusinessScope> {
    await lockAllocationMovementWriter(manager)
    await manager.execute(
      "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
      [`${CAMPAIGN_LOCK_NAMESPACE}${input.campaign_id}`]
    )
    const policies = (await manager.execute(
      `select id, state, deleted_at from flash_sale_allocation_policy
        where campaign_id = ? order by id for update`,
      [input.campaign_id]
    )) as LockedBusinessScope["policies"]
    await manager.execute(
      `select id from flash_sale_capacity_movement_control
        order by id for update`
    )
    await manager.execute(
      `select checkpoint.id from flash_sale_capacity_movement_checkpoint checkpoint
        order by checkpoint.capacity_id, checkpoint.id for update of checkpoint`
    )
    await manager.execute(
      `select id from flash_sale_purchase_attempt
        where campaign_id = ? order by id for update`,
      [input.campaign_id]
    )
    await manager.execute(
      `select id from flash_sale_subject_allocation
        where campaign_id = ? order by subject_id, id for update`,
      [input.campaign_id]
    )
    const capacities = (await manager.execute(
      `select capacity.id, capacity.allocation_policy_id,
              capacity.state, capacity.deleted_at
         from flash_sale_capacity capacity
        join flash_sale_allocation_policy policy
          on policy.id = capacity.allocation_policy_id
       where policy.campaign_id = ?
       order by capacity.campaign_item_id, capacity.shard_no, capacity.id
       for update of capacity`,
      [input.campaign_id]
    )) as LockedBusinessScope["capacities"]
    await manager.execute(
      `select hold.id from flash_sale_allocation_hold hold
       where hold.attempt_id in (
               select id from flash_sale_purchase_attempt where campaign_id = ?)
          or hold.capacity_id in (
               select capacity.id from flash_sale_capacity capacity
               join flash_sale_allocation_policy policy
                 on policy.id = capacity.allocation_policy_id
              where policy.campaign_id = ?)
       order by hold.attempt_id, hold.campaign_item_id, hold.id for update of hold`,
      [input.campaign_id, input.campaign_id]
    )
    // Immutable Plan audit rows are locked only after every online business
    // row class, so Apply cannot invert the writer/provision lock order.
    await manager.execute(
      `select id from flash_sale_capacity_repair_run
        where id = ? order by id for update`,
      [input.plan_run_id]
    )
    await manager.execute(
      `select id from flash_sale_capacity_repair_action
        where run_id = ? order by capacity_id, id for update`,
      [input.plan_run_id]
    )
    await this.options.fault_injector?.hit(
      "after_business_locks",
      input.request_identity_digest
    )
    return { policies, capacities }
  }

  private assertClosedBusinessScope(scope: LockedBusinessScope): void {
    if (scope.policies.length < 1 || scope.capacities.length < 1) {
      invariant("Apply requires a non-empty CLOSED Policy/Capacity scope")
    }
    const policyIds = new Set(scope.policies.map((policy) => policy.id))
    if (
      scope.policies.some(
        (policy) => policy.deleted_at !== null || policy.state !== "closed"
      ) ||
      scope.capacities.some(
        (capacity) =>
          capacity.deleted_at !== null ||
          capacity.state !== "closed" ||
          !policyIds.has(capacity.allocation_policy_id)
      )
    ) {
      invariant(
        "Apply requires every Policy and Capacity to be live and CLOSED"
      )
    }
    const coveredPolicyIds = new Set(
      scope.capacities.map((capacity) => capacity.allocation_policy_id)
    )
    if (scope.policies.some((policy) => !coveredPolicyIds.has(policy.id))) {
      invariant("Apply refuses a Policy without a locked Capacity")
    }
  }

  private async databaseNow(manager: SqlEntityManager): Promise<string> {
    const rows = (await manager.execute(
      "select clock_timestamp() as now"
    )) as Array<{ now: Date | string }>
    if (!rows[0]) invariant("database clock returned no timestamp")
    return iso(rows[0].now)
  }

  private async applyFresh(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand,
    planActions: readonly RepairActionRow[]
  ): Promise<ApplyCapacityRepairResult> {
    const auditAt = await this.databaseNow(manager)
    this.assertApprovalValid(input, auditAt)
    if (
      planActions.length < 1 ||
      planActions.length !== input.ordered_action_ids.length
    ) {
      invariant("Apply requires the complete non-empty Plan action set")
    }
    const applyRunId = stableId("fsraprun", {
      schema: "capacity-repair-apply-run-id-v1",
      request_identity_digest: input.request_identity_digest,
    })
    const receiptActions: ApplyActionRow[] = []
    for (const plan of [...planActions].sort((left, right) =>
      compareRepairPlanKeys(left.capacity_id, right.capacity_id)
    )) {
      this.verifySafePlanAction(plan)
      const beforeVersion = plan.before_capacity_version
      if (!beforeVersion) invariant("Apply action is missing Capacity version")
      const rows = (await manager.execute(
        `update flash_sale_capacity
            set held_quantity = ?::numeric,
                consumed_quantity = ?::numeric,
                raw_held_quantity = jsonb_set(raw_held_quantity, '{value}',
                                                to_jsonb(?::text), false),
                raw_consumed_quantity = jsonb_set(raw_consumed_quantity, '{value}',
                                                    to_jsonb(?::text), false),
                version = version + 1,
                updated_at = ?::timestamptz
          where id = ? and deleted_at is null and state = 'closed'
            and version::text = ?
            and granted_quantity::text = ?
            and held_quantity::text = ?
            and consumed_quantity::text = ?
            and raw_granted_quantity->>'value' = ?
            and raw_held_quantity->>'value' = ?
            and raw_consumed_quantity->>'value' = ?
          returning version::text as version,
                    granted_quantity::text as granted_quantity,
                    held_quantity::text as held_quantity,
                    consumed_quantity::text as consumed_quantity,
                    raw_granted_quantity->>'value' as raw_granted_quantity,
                    raw_held_quantity->>'value' as raw_held_quantity,
                    raw_consumed_quantity->>'value' as raw_consumed_quantity`,
        [
          plan.expected_held_quantity,
          plan.expected_consumed_quantity,
          plan.expected_raw_held_quantity,
          plan.expected_raw_consumed_quantity,
          auditAt,
          plan.capacity_id,
          beforeVersion,
          plan.before_granted_quantity,
          plan.before_held_quantity,
          plan.before_consumed_quantity,
          plan.before_raw_granted_quantity,
          plan.before_raw_held_quantity,
          plan.before_raw_consumed_quantity,
        ]
      )) as Array<{
        version: string
        granted_quantity: string
        held_quantity: string
        consumed_quantity: string
        raw_granted_quantity: string
        raw_held_quantity: string
        raw_consumed_quantity: string
      }>
      const after = rows[0]
      if (!after) invariant("Capacity repair CAS failed while locked")
      const base = {
        id: stableId("fsrapact", {
          schema: "capacity-repair-apply-action-id-v1",
          apply_run_id: applyRunId,
          plan_action_id: plan.id,
        }),
        apply_run_id: applyRunId,
        plan_action_id: plan.id,
        capacity_id: plan.capacity_id,
        before_capacity_version: beforeVersion,
        after_capacity_version: after.version,
        before_granted_quantity: plan.before_granted_quantity,
        before_held_quantity: plan.before_held_quantity,
        before_consumed_quantity: plan.before_consumed_quantity,
        before_raw_granted_quantity: plan.before_raw_granted_quantity,
        before_raw_held_quantity: plan.before_raw_held_quantity,
        before_raw_consumed_quantity: plan.before_raw_consumed_quantity,
        after_granted_quantity: after.granted_quantity,
        after_held_quantity: after.held_quantity,
        after_consumed_quantity: after.consumed_quantity,
        after_raw_granted_quantity: after.raw_granted_quantity,
        after_raw_held_quantity: after.raw_held_quantity,
        after_raw_consumed_quantity: after.raw_consumed_quantity,
        status: "applied",
        created_at: auditAt,
        updated_at: auditAt,
        deleted_at: null,
      } as const
      receiptActions.push({
        ...base,
        evidence_digest: actionEvidenceDigest(base),
      })
    }
    await this.options.fault_injector?.hit(
      "after_capacity_cas",
      input.request_identity_digest
    )
    const runWithoutResult = {
      id: applyRunId,
      plan_run_id: input.plan_run_id,
      plan_schema_version: "2",
      campaign_id: input.campaign_id,
      command_digest: input.command_digest,
      plan_evidence_digest: input.expected_plan_evidence_digest,
      ordered_action_set_digest: input.ordered_action_set_digest,
      approval_token_digest: input.approval_token_digest,
      approval_claims_digest: input.approval_claims_digest,
      approval_reference_digest: input.approval_reference_digest,
      approver: input.approver,
      approval_issuer: input.approval_issuer,
      approval_audience: input.approval_audience,
      approval_tenant: input.approval_tenant,
      approval_jti_digest: input.approval_jti_digest,
      approval_permission_version: input.approval_permission_version,
      approval_roles: input.approval_roles,
      approval_purpose: input.approval_purpose,
      approval_issued_at: input.approval_issued_at,
      approval_not_before: input.approval_not_before,
      approval_expires_at: input.approval_expires_at,
      requester: input.requester,
      reason: input.reason,
      ticket: input.ticket,
      status: "applied",
      finished_at: auditAt,
      created_at: auditAt,
      updated_at: auditAt,
      deleted_at: null,
    } as const
    const resultDigest = repairPlanDigest({
      schema: "capacity-repair-apply-result-v1",
      run: runWithoutResult,
      actions: receiptActions,
    })
    await this.insertReceipt(
      manager,
      input,
      runWithoutResult,
      resultDigest,
      receiptActions
    )
    const outbox = await this.insertOutbox(
      manager,
      input,
      applyRunId,
      resultDigest,
      receiptActions,
      auditAt
    )
    // Re-check after every CAS and append, immediately before the transaction
    // is allowed to commit. A long-running repair cannot outlive its approval.
    this.assertApprovalValid(input, await this.databaseNow(manager))
    await this.options.fault_injector?.hit(
      "after_outbox_before_commit",
      input.request_identity_digest
    )
    return {
      disposition: "fresh",
      apply_run_id: applyRunId,
      plan_run_id: input.plan_run_id,
      result_digest: resultDigest,
      outbox_event_id: outbox.id,
      actions: Object.freeze(receiptActions.map(publicAction)),
    }
  }

  private assertApprovalValid(
    input: PreparedApplyCapacityRepairCommand,
    databaseTime: string
  ): void {
    if (
      input.approval_issued_at > databaseTime ||
      input.approval_not_before > databaseTime ||
      input.approval_expires_at <= databaseTime
    ) {
      invariant("repair approval is not valid at the database commit clock")
    }
  }

  private verifySafePlanAction(plan: RepairActionRow): void {
    if (
      plan.deleted_at !== null ||
      plan.classification !== "safe_repair" ||
      plan.status !== "proposed" ||
      plan.issue_codes.length < 1 ||
      plan.issue_codes.some((code) => !SAFE_CODES.has(code))
    ) {
      invariant("Plan action is not an immutable safe-repair proposal")
    }
    const decimals = [
      plan.before_granted_quantity,
      plan.before_held_quantity,
      plan.before_consumed_quantity,
      plan.before_raw_granted_quantity,
      plan.before_raw_held_quantity,
      plan.before_raw_consumed_quantity,
      plan.expected_granted_quantity,
      plan.expected_held_quantity,
      plan.expected_consumed_quantity,
      plan.expected_raw_granted_quantity,
      plan.expected_raw_held_quantity,
      plan.expected_raw_consumed_quantity,
    ]
    decimals.forEach((value, index) => decimal(value, `Plan decimal ${index}`))
    if (
      plan.before_granted_quantity !== plan.expected_granted_quantity ||
      plan.before_raw_granted_quantity !== plan.before_granted_quantity ||
      plan.expected_raw_granted_quantity !== plan.expected_granted_quantity ||
      plan.expected_raw_held_quantity !== plan.expected_held_quantity ||
      plan.expected_raw_consumed_quantity !== plan.expected_consumed_quantity ||
      decimal(plan.expected_held_quantity, "expected held") +
        decimal(plan.expected_consumed_quantity, "expected consumed") >
        decimal(plan.expected_granted_quantity, "expected granted") ||
      (plan.before_held_quantity === plan.expected_held_quantity &&
        plan.before_consumed_quantity === plan.expected_consumed_quantity &&
        plan.before_raw_held_quantity === plan.expected_raw_held_quantity &&
        plan.before_raw_consumed_quantity ===
          plan.expected_raw_consumed_quantity)
    ) {
      invariant("Plan action crosses the automatic counter repair boundary")
    }
  }

  private async insertReceipt(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand,
    run: Readonly<Record<string, unknown>> & { id: string },
    resultDigest: string,
    actions: readonly ApplyActionRow[]
  ): Promise<void> {
    await manager.execute(
      `insert into flash_sale_capacity_repair_apply_run
        (id, plan_run_id, plan_schema_version, campaign_id, command_digest,
         plan_evidence_digest, ordered_action_set_digest, approval_token_digest,
         approval_claims_digest, approval_reference_digest, approver,
         approval_issuer, approval_audience, approval_tenant,
         approval_jti_digest, approval_permission_version, approval_roles,
         approval_purpose, approval_issued_at, approval_not_before,
         approval_expires_at, requester, reason, ticket, status, result_digest,
         finished_at, created_at, updated_at)
       values (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?,
               ?::timestamptz, ?::timestamptz, ?::timestamptz, ?, ?, ?,
               'applied', ?, ?::timestamptz, ?::timestamptz, ?::timestamptz)`,
      [
        run.id,
        input.plan_run_id,
        input.campaign_id,
        input.command_digest,
        input.expected_plan_evidence_digest,
        input.ordered_action_set_digest,
        input.approval_token_digest,
        input.approval_claims_digest,
        input.approval_reference_digest,
        input.approver,
        input.approval_issuer,
        input.approval_audience,
        input.approval_tenant,
        input.approval_jti_digest,
        input.approval_permission_version,
        JSON.stringify(input.approval_roles),
        input.approval_purpose,
        input.approval_issued_at,
        input.approval_not_before,
        input.approval_expires_at,
        input.requester,
        input.reason,
        input.ticket,
        resultDigest,
        run.finished_at,
        run.created_at,
        run.updated_at,
      ]
    )
    for (const action of actions) {
      await manager.execute(
        `insert into flash_sale_capacity_repair_apply_action
          (id, apply_run_id, plan_action_id, capacity_id,
           before_capacity_version, after_capacity_version,
           before_granted_quantity, before_held_quantity,
           before_consumed_quantity, before_raw_granted_quantity,
           before_raw_held_quantity, before_raw_consumed_quantity,
           after_granted_quantity, after_held_quantity,
           after_consumed_quantity, after_raw_granted_quantity,
           after_raw_held_quantity, after_raw_consumed_quantity,
           evidence_digest, status, created_at, updated_at)
         values (?, ?, ?, ?, ?::integer, ?::integer, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, 'applied', ?::timestamptz, ?::timestamptz)`,
        [
          action.id,
          action.apply_run_id,
          action.plan_action_id,
          action.capacity_id,
          action.before_capacity_version,
          action.after_capacity_version,
          action.before_granted_quantity,
          action.before_held_quantity,
          action.before_consumed_quantity,
          action.before_raw_granted_quantity,
          action.before_raw_held_quantity,
          action.before_raw_consumed_quantity,
          action.after_granted_quantity,
          action.after_held_quantity,
          action.after_consumed_quantity,
          action.after_raw_granted_quantity,
          action.after_raw_held_quantity,
          action.after_raw_consumed_quantity,
          action.evidence_digest,
          action.created_at,
          action.updated_at,
        ]
      )
    }
    const identityAt = run.created_at as string
    await manager.execute(
      `insert into flash_sale_capacity_repair_apply_identity
        (id, request_identity_digest, apply_run_id, command_digest,
         created_at, updated_at)
       values (?, ?, ?, ?, ?::timestamptz, ?::timestamptz)`,
      [
        stableId("fsrapid", {
          schema: "capacity-repair-apply-identity-id-v1",
          request_identity_digest: input.request_identity_digest,
        }),
        input.request_identity_digest,
        run.id,
        input.command_digest,
        identityAt,
        identityAt,
      ]
    )
  }

  private async insertOutbox(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand,
    applyRunId: string,
    resultDigest: string,
    actions: readonly ApplyActionRow[],
    auditAt: string
  ): Promise<{ id: string }> {
    const payload = {
      apply_run_id: applyRunId,
      plan_run_id: input.plan_run_id,
      campaign_id: input.campaign_id,
      result_digest: resultDigest,
      action_ids: actions
        .map((action) => action.id)
        .sort(compareRepairPlanKeys),
      ticket: input.ticket,
    }
    const identity = {
      event_name: EVENT_NAME,
      schema_version: 1,
      aggregate_type: AGGREGATE_TYPE,
      aggregate_id: applyRunId,
      aggregate_version: 1,
      payload,
    } as const
    const eventHash = hashAllocationEventIdentity(identity)
    const id = stableId("fsaevt", {
      schema: "capacity-repair-apply-outbox-id-v1",
      apply_run_id: applyRunId,
    })
    await manager.execute(
      `insert into flash_sale_allocation_outbox_event
        (id, event_name, schema_version, aggregate_type, aggregate_id,
         aggregate_version, event_hash, payload, status, available_at,
         occurred_at, attempt_count, lease_epoch, redrive_count,
         created_at, updated_at)
       values (?, ?, 1, ?, ?, 1, ?, ?::jsonb, 'pending', ?::timestamptz,
               ?::timestamptz, 0, 0, 0, ?::timestamptz, ?::timestamptz)`,
      [
        id,
        EVENT_NAME,
        AGGREGATE_TYPE,
        applyRunId,
        eventHash,
        JSON.stringify(payload),
        auditAt,
        auditAt,
        auditAt,
        auditAt,
      ]
    )
    return { id }
  }

  private async verifyReplay(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand
  ): Promise<ApplyCapacityRepairResult | undefined> {
    const expectedRunId = stableId("fsraprun", {
      schema: "capacity-repair-apply-run-id-v1",
      request_identity_digest: input.request_identity_digest,
    })
    const identities = (await manager.execute(
      `select id, request_identity_digest, apply_run_id, command_digest,
              created_at, updated_at, deleted_at
         from flash_sale_capacity_repair_apply_identity
        where request_identity_digest = ? or apply_run_id = ? order by id`,
      [input.request_identity_digest, expectedRunId]
    )) as ApplyIdentityRow[]
    const runs = (await manager.execute(
      `select id, plan_run_id, plan_schema_version::text as plan_schema_version,
              campaign_id, command_digest, plan_evidence_digest,
              ordered_action_set_digest, approval_token_digest,
              approval_claims_digest, approval_reference_digest, approver,
              approval_issuer, approval_audience, approval_tenant,
              approval_jti_digest, approval_permission_version, approval_roles,
              approval_purpose, approval_issued_at, approval_not_before,
              approval_expires_at, requester, reason, ticket, status,
              result_digest, finished_at, created_at, updated_at, deleted_at
         from flash_sale_capacity_repair_apply_run
        where id = ? or plan_run_id = ? or approval_jti_digest = ? order by id`,
      [expectedRunId, input.plan_run_id, input.approval_jti_digest]
    )) as ApplyRunRow[]
    if (identities.length === 0 && runs.length === 0) return undefined
    if (
      identities.length === 0 &&
      runs.length > 0 &&
      !runs.some((run) => run.id === expectedRunId)
    ) {
      conflict("repair Plan or approval JTI was already consumed")
    }
    if (identities.length !== 1 || runs.length !== 1) {
      invariant("Apply request, Plan, or approval JTI history is ambiguous")
    }
    const identity = identities[0]
    const run = runs[0]
    if (!identity || !run) invariant("Apply receipt history is incomplete")
    const auditAt = iso(run.created_at)
    const expectedIdentity = {
      id: stableId("fsrapid", {
        schema: "capacity-repair-apply-identity-id-v1",
        request_identity_digest: input.request_identity_digest,
      }),
      request_identity_digest: input.request_identity_digest,
      apply_run_id: expectedRunId,
      command_digest: input.command_digest,
      created_at: auditAt,
      updated_at: auditAt,
      deleted_at: null,
    }
    const normalizedIdentity = {
      ...identity,
      created_at: iso(identity.created_at),
      updated_at: iso(identity.updated_at),
    }
    if (!same(normalizedIdentity, expectedIdentity)) {
      invariant("Apply Identity replay drifted")
    }
    const normalizedRun = {
      ...run,
      approval_roles: json(run.approval_roles),
      approval_issued_at: iso(run.approval_issued_at),
      approval_not_before: iso(run.approval_not_before),
      approval_expires_at: iso(run.approval_expires_at),
      finished_at: iso(run.finished_at),
      created_at: auditAt,
      updated_at: iso(run.updated_at),
    }
    const expectedRunFields = {
      id: expectedRunId,
      plan_run_id: input.plan_run_id,
      plan_schema_version: "2",
      campaign_id: input.campaign_id,
      command_digest: input.command_digest,
      plan_evidence_digest: input.expected_plan_evidence_digest,
      ordered_action_set_digest: input.ordered_action_set_digest,
      approval_token_digest: input.approval_token_digest,
      approval_claims_digest: input.approval_claims_digest,
      approval_reference_digest: input.approval_reference_digest,
      approver: input.approver,
      approval_issuer: input.approval_issuer,
      approval_audience: input.approval_audience,
      approval_tenant: input.approval_tenant,
      approval_jti_digest: input.approval_jti_digest,
      approval_permission_version: input.approval_permission_version,
      approval_roles: input.approval_roles,
      approval_purpose: input.approval_purpose,
      approval_issued_at: input.approval_issued_at,
      approval_not_before: input.approval_not_before,
      approval_expires_at: input.approval_expires_at,
      requester: input.requester,
      reason: input.reason,
      ticket: input.ticket,
      status: "applied",
      finished_at: auditAt,
      created_at: auditAt,
      updated_at: auditAt,
      deleted_at: null,
    }
    const { result_digest: resultDigest, ...runWithoutDigest } = normalizedRun
    if (!same(runWithoutDigest, expectedRunFields)) {
      invariant("Apply Run replay command or approval drifted")
    }
    const actions = (await manager.execute(
      `select id, apply_run_id, plan_action_id, capacity_id,
              before_capacity_version::text as before_capacity_version,
              after_capacity_version::text as after_capacity_version,
              before_granted_quantity, before_held_quantity,
              before_consumed_quantity, before_raw_granted_quantity,
              before_raw_held_quantity, before_raw_consumed_quantity,
              after_granted_quantity, after_held_quantity,
              after_consumed_quantity, after_raw_granted_quantity,
              after_raw_held_quantity, after_raw_consumed_quantity,
              evidence_digest, status, created_at, updated_at, deleted_at
         from flash_sale_capacity_repair_apply_action
        where apply_run_id = ? order by capacity_id, id`,
      [expectedRunId]
    )) as ApplyActionRow[]
    if (actions.length !== input.ordered_action_ids.length) {
      invariant("Apply Action replay row set is incomplete")
    }
    const normalizedActions = actions.map((action) => ({
      ...action,
      created_at: iso(action.created_at),
      updated_at: iso(action.updated_at),
    }))
    for (const action of normalizedActions) {
      const { evidence_digest: evidenceDigest, ...content } = action
      if (
        action.deleted_at !== null ||
        !input.ordered_action_ids.includes(action.plan_action_id) ||
        evidenceDigest !== actionEvidenceDigest(content)
      ) {
        invariant("Apply Action replay evidence drifted")
      }
    }
    const recalculatedResult = repairPlanDigest({
      schema: "capacity-repair-apply-result-v1",
      run: expectedRunFields,
      actions: normalizedActions,
    })
    if (resultDigest !== recalculatedResult) {
      invariant("Apply result digest drifted")
    }
    const outbox = await this.verifyOutbox(
      manager,
      input,
      expectedRunId,
      resultDigest,
      normalizedActions,
      auditAt
    )
    return {
      disposition: "replay",
      apply_run_id: expectedRunId,
      plan_run_id: input.plan_run_id,
      result_digest: resultDigest,
      outbox_event_id: outbox.id,
      actions: Object.freeze(normalizedActions.map(publicAction)),
    }
  }

  private async verifyOutbox(
    manager: SqlEntityManager,
    input: PreparedApplyCapacityRepairCommand,
    applyRunId: string,
    resultDigest: string,
    actions: readonly ApplyActionRow[],
    auditAt: string
  ): Promise<OutboxRow> {
    const rows = (await manager.execute(
      `select id, event_name, schema_version::text as schema_version,
              aggregate_type, aggregate_id,
              aggregate_version::text as aggregate_version, event_hash,
              payload, status, available_at, occurred_at, created_at,
              updated_at, deleted_at
         from flash_sale_allocation_outbox_event
        where aggregate_type = ? and aggregate_id = ? order by id`,
      [AGGREGATE_TYPE, applyRunId]
    )) as OutboxRow[]
    const row = rows[0]
    if (rows.length !== 1 || !row) invariant("Apply outbox replay is missing")
    const payload = {
      apply_run_id: applyRunId,
      plan_run_id: input.plan_run_id,
      campaign_id: input.campaign_id,
      result_digest: resultDigest,
      action_ids: actions
        .map((action) => action.id)
        .sort(compareRepairPlanKeys),
      ticket: input.ticket,
    }
    const identity = {
      event_name: EVENT_NAME,
      schema_version: 1,
      aggregate_type: AGGREGATE_TYPE,
      aggregate_id: applyRunId,
      aggregate_version: 1,
      payload,
    } as const
    const expected = {
      id: stableId("fsaevt", {
        schema: "capacity-repair-apply-outbox-id-v1",
        apply_run_id: applyRunId,
      }),
      event_name: EVENT_NAME,
      schema_version: "1",
      aggregate_type: AGGREGATE_TYPE,
      aggregate_id: applyRunId,
      aggregate_version: "1",
      event_hash: hashAllocationEventIdentity(identity),
      payload,
      occurred_at: auditAt,
      created_at: auditAt,
      deleted_at: null,
    }
    const normalized = {
      id: row.id,
      event_name: row.event_name,
      schema_version: row.schema_version,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      aggregate_version: row.aggregate_version,
      event_hash: row.event_hash,
      payload: json(row.payload),
      occurred_at: iso(row.occurred_at),
      created_at: iso(row.created_at),
      deleted_at: row.deleted_at,
    }
    if (!same(normalized, expected)) invariant("Apply outbox replay drifted")
    return row
  }

  private async withSessionIdentityLock<T>(
    input: PreparedApplyCapacityRepairCommand,
    task: (manager: SqlEntityManager) => Promise<T>
  ): Promise<T> {
    const manager = this.baseRepository.getFreshManager<SqlEntityManager>()
    const knex = manager.getKnex()
    const connection = await knex.client.acquireConnection()
    let settings:
      | {
          application_name: string
          statement_timeout: string
          lock_timeout: string
        }
      | undefined
    let locked = false
    let quarantine = false
    let value: T | undefined
    let failure: unknown
    try {
      const result = await knex
        .raw(
          `select current_setting('application_name') as application_name,
                  current_setting('statement_timeout') as statement_timeout,
                  current_setting('lock_timeout') as lock_timeout`
        )
        .connection(connection)
      settings = (result as { rows: (typeof settings)[] }).rows[0]
      if (!settings) invariant("failed to read Apply lock session settings")
      await knex
        .raw("select set_config('application_name', ?, false)", [
          this.options.application_name ??
            `flash-sale-apply-${
              process.pid
            }-${input.request_identity_digest.slice(0, 12)}`,
        ])
        .connection(connection)
      for (const setting of ["statement_timeout", "lock_timeout"] as const) {
        await knex
          .raw(`select set_config('${setting}', ?, false)`, [
            `${input.statement_timeout_ms}ms`,
          ])
          .connection(connection)
      }
      await knex
        .raw("select pg_advisory_lock(hashtextextended(?, 0))", [
          `capacity-repair-apply:${input.request_identity_digest}`,
        ])
        .connection(connection)
      locked = true
      const transaction = await knex.transaction(undefined, {
        isolationLevel: "repeatable read",
        connection,
      })
      manager.setTransactionContext(transaction)
      try {
        value = await task(manager)
        await transaction.commit()
        await transaction.executionPromise
      } catch (error) {
        if (!transaction.isCompleted()) {
          try {
            await transaction.rollback(error)
          } catch {
            quarantine = true
          }
        }
        await transaction.executionPromise.catch(() => undefined)
        failure = error
      } finally {
        manager.resetTransactionContext()
      }
    } catch (error) {
      failure = error
    }
    try {
      if (locked) {
        const unlocked = await knex
          .raw(
            "select pg_advisory_unlock(hashtextextended(?, 0)) as unlocked",
            [`capacity-repair-apply:${input.request_identity_digest}`]
          )
          .connection(connection)
        if (
          (unlocked as { rows: Array<{ unlocked: boolean }> }).rows[0]
            ?.unlocked !== true
        ) {
          quarantine = true
          if (failure === undefined)
            failure = new Error("Apply lock cleanup failed")
        }
      }
      if (!settings) {
        quarantine = true
      } else {
        for (const [name, value] of Object.entries(settings)) {
          await knex
            .raw(`select set_config('${name}', ?, false)`, [value])
            .connection(connection)
        }
      }
    } catch (error) {
      quarantine = true
      if (failure === undefined) failure = error
    }
    if (quarantine) {
      ;(connection as { __knex__disposed?: string }).__knex__disposed =
        "capacity repair Apply session cleanup failed"
    }
    delete (connection as { __knexTxId?: string }).__knexTxId
    await knex.client.releaseConnection(connection)
    if (failure !== undefined) throw failure
    return value as T
  }
}
