import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  CapacityRepairPlanAction,
  CapacityRepairPlanStore,
  compareRepairPlanKeys,
  DryRunCapacityRepairResult,
  PreparedDryRunCapacityRepairCommand,
  repairPlanDigest,
} from "../application"
import {
  LedgerCapacityEntity,
  LedgerReconciliationIssue,
  LedgerReconciliationIssueCode,
  ProjectedCapacityCounters,
} from "../domain"
import {
  MovementLedgerReconciliationEvidence,
  PostgresMovementLedgerReconciliationStore,
} from "./postgres-movement-ledger-reconciliation-store"

type RepairStoreOptions = Readonly<{
  application_name?: string
  after_session_lock?: () => Promise<void>
}>

type RepairTransactionRunner = <T>(
  task: (manager: SqlEntityManager) => Promise<T>
) => Promise<T>

type RepairIdentityRow = Readonly<{
  id: string
  request_identity_digest: string
  run_id: string
  command_digest: string
  evidence_digest: string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type RepairRunRow = Readonly<{
  id: string
  plan_schema_version: string | number
  request_identity_digest: string
  command_digest: string
  campaign_id: string | null
  activation_id: string | null
  control_schema_version: string | null
  control_root_digest: string | null
  status: DryRunCapacityRepairResult["status"]
  classification: "safe_repair" | "manual_required" | null
  actor: string
  reason: string
  ticket: string
  evidence_digest: string
  issue_codes: string[]
  issue_count: string | number
  issue_manifest: unknown
  evidence_manifest: unknown
  snapshot_at: Date | string
  finished_at: Date | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type RepairActionRow = Readonly<{
  id: string
  run_id: string
  capacity_id: string
  before_capacity_version: string | null
  before_granted_quantity: string
  before_held_quantity: string
  before_consumed_quantity: string
  before_raw_granted_quantity: string
  before_raw_held_quantity: string
  before_raw_consumed_quantity: string
  expected_granted_quantity: string
  expected_held_quantity: string
  expected_consumed_quantity: string
  expected_raw_granted_quantity: string
  expected_raw_held_quantity: string
  expected_raw_consumed_quantity: string
  issue_codes: string[]
  classification: "safe_repair"
  evidence_digest: string
  status: "proposed"
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}>

type LegacyRepairActionRow = Omit<RepairActionRow, "before_capacity_version">

const REPAIR_IDENTITY_UNIQUE =
  "IDX_flash_sale_capacity_repair_identity_digest_unique"

const SAFE_ACTION_CODES = new Set<LedgerReconciliationIssueCode>([
  LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.CONSUMED_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.RAW_MIRROR_DRIFT,
])

function invariant(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.REPAIR_PLAN_INVARIANT_VIOLATION,
    message
  )
}

function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareRepairPlanKeys)
}

function iso(value: Date | string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) invariant("invalid audit timestamp")
  return parsed.toISOString()
}

function same(value: unknown, expected: unknown): boolean {
  return repairPlanDigest(value) === repairPlanDigest(expected)
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${repairPlanDigest(value).slice(0, 26)}`
}

function mirrorValue(raw: LedgerCapacityEntity["raw_granted_quantity"]): string {
  try {
    const parsed =
      typeof raw === "string"
        ? (JSON.parse(raw) as { value?: unknown })
        : raw
    if (parsed && typeof parsed === "object" && typeof parsed.value === "string") {
      return parsed.value
    }
  } catch {
    // The projector has already classified invalid mirrors as manual-required.
  }
  invariant("repair action raw decimal evidence is incomplete")
}

function capacityVersion(value: string | undefined): string {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    invariant("repair action Capacity version evidence is incomplete")
  }
  return value
}

function withoutCapacityVersions(
  manifest: MovementLedgerReconciliationEvidence["physical_manifest"]
): MovementLedgerReconciliationEvidence["physical_manifest"] {
  return {
    ...manifest,
    capacities: manifest.capacities.map(({ version: _version, ...capacity }) =>
      capacity
    ),
  }
}

function issueOrder(
  left: LedgerReconciliationIssue,
  right: LedgerReconciliationIssue
): number {
  return (
    compareRepairPlanKeys(left.code, right.code) ||
    compareRepairPlanKeys(left.capacity_id ?? "", right.capacity_id ?? "") ||
    compareRepairPlanKeys(left.classification, right.classification) ||
    compareRepairPlanKeys(left.detail, right.detail)
  )
}

function capacityOrder(
  left: ProjectedCapacityCounters,
  right: ProjectedCapacityCounters
): number {
  return compareRepairPlanKeys(left.capacity_id, right.capacity_id)
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

export function isRepairIdentityUniqueViolation(error: unknown): boolean {
  return (
    errorField(error, "code") === "23505" &&
    errorField(error, "constraint") === REPAIR_IDENTITY_UNIQUE
  )
}

export class PostgresCapacityRepairPlanStore
  implements CapacityRepairPlanStore
{
  constructor(
    private readonly baseRepository: DAL.RepositoryService,
    private readonly options: RepairStoreOptions = {}
  ) {}

  async dryRunCapacityRepair(
    input: PreparedDryRunCapacityRepairCommand
  ): Promise<DryRunCapacityRepairResult> {
    return await this.withSessionIdentityLock(input, async (run) => {
      try {
        return await run(async (manager) => await this.executeOnce(input, manager))
      } catch (error) {
        if (!isRepairIdentityUniqueViolation(error)) throw error
        return await run(async (manager) => await this.executeOnce(input, manager))
      }
    })
  }

  private async withSessionIdentityLock<T>(
    input: PreparedDryRunCapacityRepairCommand,
    task: (run: RepairTransactionRunner) => Promise<T>
  ): Promise<T> {
    const manager = this.baseRepository.getFreshManager<SqlEntityManager>()
    const knex = manager.getKnex()
    const connection = await knex.client.acquireConnection()
    const applicationName =
      this.options.application_name ??
      `flash-sale-repair-${process.pid}-${input.request_identity_digest.slice(0, 12)}`
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
      const settingsResult = await knex
        .raw(
          `select current_setting('application_name') as application_name,
                  current_setting('statement_timeout') as statement_timeout,
                  current_setting('lock_timeout') as lock_timeout`
        )
        .connection(connection)
      settings = (settingsResult as {
        rows: Array<{
          application_name: string
          statement_timeout: string
          lock_timeout: string
        }>
      }).rows[0]
      if (!settings) invariant("failed to read repair lock session settings")
      await knex
        .raw("select set_config('application_name', ?, false)", [applicationName])
        .connection(connection)
      await knex
        .raw("select set_config('statement_timeout', ?, false)", [
          `${input.statement_timeout_ms}ms`,
        ])
        .connection(connection)
      await knex
        .raw("select set_config('lock_timeout', ?, false)", [
          `${input.statement_timeout_ms}ms`,
        ])
        .connection(connection)
      await knex
        .raw("select pg_advisory_lock(hashtextextended(?, 0))", [
          `capacity-repair-plan:${input.request_identity_digest}`,
        ])
        .connection(connection)
      locked = true
      await this.options.after_session_lock?.()
      // The evidence RR snapshot is created only after the session lock is held.
      const run: RepairTransactionRunner = async <R>(
        transactionTask: (transactionManager: SqlEntityManager) => Promise<R>
      ): Promise<R> => {
        const transaction = await knex.transaction(undefined, {
          isolationLevel: "repeatable read",
          connection,
        })
        manager.setTransactionContext(transaction)
        try {
          const transactionValue = await transactionTask(manager)
          await transaction.commit()
          await transaction.executionPromise
          return transactionValue
        } catch (transactionError) {
          if (!transaction.isCompleted()) {
            try {
              await transaction.rollback(transactionError)
            } catch {
              // A failed ROLLBACK makes this physical session unsafe to reuse.
              quarantine = true
            }
          }
          await transaction.executionPromise.catch(() => undefined)
          throw transactionError
        } finally {
          manager.resetTransactionContext()
        }
      }
      value = await task(run)
    } catch (error) {
      failure = error
    }
    try {
      if (locked) {
        const unlockResult = await knex
          .raw("select pg_advisory_unlock(hashtextextended(?, 0)) as unlocked", [
            `capacity-repair-plan:${input.request_identity_digest}`,
          ])
          .connection(connection)
        const unlocked = (unlockResult as { rows: Array<{ unlocked: boolean }> })
          .rows[0]?.unlocked
        if (unlocked !== true) {
          quarantine = true
          if (failure === undefined) {
            failure = new Error("repair advisory lock was not owned during cleanup")
          }
        }
      }
      if (!settings) {
        quarantine = true
      } else {
        await knex
          .raw("select set_config('application_name', ?, false)", [
            settings.application_name,
          ])
          .connection(connection)
        await knex
          .raw("select set_config('statement_timeout', ?, false)", [
            settings.statement_timeout,
          ])
          .connection(connection)
        await knex
          .raw("select set_config('lock_timeout', ?, false)", [
            settings.lock_timeout,
          ])
          .connection(connection)
      }
    } catch (cleanupError) {
      quarantine = true
      if (failure === undefined) failure = cleanupError
    }
    if (quarantine) {
      ;(connection as { __knex__disposed?: string }).__knex__disposed =
        "capacity repair session cleanup failed"
    }
    delete (connection as { __knexTxId?: string }).__knexTxId
    // Release removes the resource from Tarn's used set; a disposed resource is
    // rejected by Knex validation and destroyed instead of re-entering the pool.
    await knex.client.releaseConnection(connection)
    if (failure !== undefined) throw failure
    return value as T
  }

  private async executeOnce(
    input: PreparedDryRunCapacityRepairCommand,
    manager: SqlEntityManager
  ): Promise<DryRunCapacityRepairResult> {
    let outcome: DryRunCapacityRepairResult | undefined
    const reconciler = new PostgresMovementLedgerReconciliationStore(
      this.baseRepository,
      {
        resultComputed: async (manager, result, complete) => {
          outcome = await this.persistOrReplay(
            manager,
            input,
            result.snapshot_at,
            complete
          )
        },
      },
      "repair_plan"
    )
    await reconciler.reconcileInTransaction(manager, {
      campaign_id: input.campaign_id,
      sample_limit: 100,
      statement_timeout_ms: input.statement_timeout_ms,
      batch_size: input.batch_size,
    })
    if (!outcome) invariant("repair plan transaction produced no outcome")
    return outcome
  }

  private async persistOrReplay(
    manager: SqlEntityManager,
    input: PreparedDryRunCapacityRepairCommand,
    currentSnapshotAt: Date,
    evidence: MovementLedgerReconciliationEvidence
  ): Promise<DryRunCapacityRepairResult> {
    const domain = evidence.full_result
    const manifest = evidence.physical_manifest
    const controls = manifest.controls
    const control =
      controls.length === 1 && controls[0].deleted_at === null
        ? controls[0]
        : null
    const policyIds = new Set(
      manifest.policies
        .filter(
          (policy) =>
            !input.campaign_id || policy.campaign_id === input.campaign_id
        )
        .map((policy) => policy.id)
    )
    const capacities = manifest.capacities.filter((capacity) =>
      policyIds.has(capacity.allocation_policy_id)
    )
    const beforeById = new Map(capacities.map((row) => [row.id, row] as const))
    const issueManifest = [...domain.issues].sort(issueOrder)
    const expectedCapacities = [...domain.expected_capacities].sort(capacityOrder)
    const issueCodes = sortedStrings(issueManifest.map((issue) => issue.code))
    const status: DryRunCapacityRepairResult["status"] =
      domain.status === "not_activated"
        ? "not_activated"
        : domain.status === "healthy"
          ? "no_changes"
          : domain.status === "drift"
            ? "planned"
            : "manual_required"
    const runId = stableId("fsreprun", {
      schema: "capacity-repair-run-id-v1",
      request_identity_digest: input.request_identity_digest,
    })
    const identityId = stableId("fsrepid", {
      schema: "capacity-repair-identity-id-v1",
      request_identity_digest: input.request_identity_digest,
    })

    const identities = (await manager.execute(
      `select id, request_identity_digest, run_id, command_digest,
              evidence_digest, created_at, updated_at, deleted_at
         from flash_sale_capacity_repair_identity
        where request_identity_digest = ? or run_id = ?
        order by id`,
      [input.request_identity_digest, runId]
    )) as RepairIdentityRow[]
    const runs = (await manager.execute(
      `select id, plan_schema_version::text as plan_schema_version,
              request_identity_digest, command_digest, campaign_id,
              activation_id, control_schema_version::text as control_schema_version,
              control_root_digest, status, classification, actor, reason, ticket,
              evidence_digest, issue_codes, issue_count, issue_manifest,
              evidence_manifest, snapshot_at, finished_at, created_at, updated_at,
              deleted_at
         from flash_sale_capacity_repair_run
        where request_identity_digest = ? or id = ?
        order by id`,
      [input.request_identity_digest, runId]
    )) as RepairRunRow[]
    if ((identities.length === 0) !== (runs.length === 0)) {
      invariant("repair identity registry and Run physical history diverged")
    }
    if (identities.length > 1 || runs.length > 1) {
      invariant("repair identity or Run physical history is ambiguous")
    }
    const existingIdentity = identities[0]
    const existingRun = runs[0]
    const planSchemaVersion = existingRun
      ? Number(existingRun.plan_schema_version)
      : 2
    if (planSchemaVersion !== 1 && planSchemaVersion !== 2) {
      invariant("repair Run has an unsupported plan schema version")
    }
    const auditAt = existingRun ? iso(existingRun.snapshot_at) : iso(currentSnapshotAt)

    const issuesByCapacity = new Map<string, LedgerReconciliationIssueCode[]>()
    for (const issue of issueManifest) {
      if (!issue.capacity_id || !SAFE_ACTION_CODES.has(issue.code)) continue
      const codes = issuesByCapacity.get(issue.capacity_id) ?? []
      codes.push(issue.code)
      issuesByCapacity.set(issue.capacity_id, codes)
    }
    const versionedActions: RepairActionRow[] =
      domain.classification === "safe_repair"
        ? expectedCapacities.flatMap((expected) => {
            const before = beforeById.get(expected.capacity_id)
            const actionIssueCodes = sortedStrings(
              issuesByCapacity.get(expected.capacity_id) ?? []
            )
            if (!before || actionIssueCodes.length === 0) return []
            const id = stableId("fsrepact", {
              schema: "capacity-repair-action-id-v1",
              run_id: runId,
              capacity_id: expected.capacity_id,
            })
            const content = {
              id,
              run_id: runId,
              capacity_id: expected.capacity_id,
              before_capacity_version: capacityVersion(before.version),
              before_granted_quantity: before.granted_quantity,
              before_held_quantity: before.held_quantity,
              before_consumed_quantity: before.consumed_quantity,
              before_raw_granted_quantity: mirrorValue(before.raw_granted_quantity),
              before_raw_held_quantity: mirrorValue(before.raw_held_quantity),
              before_raw_consumed_quantity: mirrorValue(before.raw_consumed_quantity),
              expected_granted_quantity: expected.granted_quantity,
              expected_held_quantity: expected.held_quantity,
              expected_consumed_quantity: expected.consumed_quantity,
              expected_raw_granted_quantity: expected.granted_quantity,
              expected_raw_held_quantity: expected.held_quantity,
              expected_raw_consumed_quantity: expected.consumed_quantity,
              issue_codes: actionIssueCodes,
              classification: "safe_repair" as const,
              status: "proposed" as const,
              created_at: auditAt,
              updated_at: auditAt,
              deleted_at: null,
            }
            return [
              {
                ...content,
                evidence_digest: repairPlanDigest({
                  schema: "capacity-repair-action-evidence-v3",
                  ...content,
                }),
              },
            ]
          })
        : []

    // Frozen schema-v1 replay codec. Capacity.version, the Action version and
    // all new schema tags are intentionally absent so historical evidence is
    // validated byte-for-byte instead of being silently upgraded in place.
    const legacyActions = versionedActions.map(
      ({ before_capacity_version: _version, evidence_digest: _digest, ...action }) => ({
        ...action,
        evidence_digest: repairPlanDigest({
          schema: "capacity-repair-action-evidence-v2",
          ...action,
        }),
      })
    )
    const legacyEvidenceManifest = {
      schema: "capacity-repair-evidence-manifest-v2",
      physical: withoutCapacityVersions(manifest),
      projection: {
        status: domain.status,
        classification: domain.classification,
        issues: issueManifest,
        expected_capacities: expectedCapacities,
        subject_counter_derivation: domain.subject_counter_derivation,
      },
    }
    const versionedEvidenceManifest = {
      schema: "capacity-repair-evidence-manifest-v3",
      physical: manifest,
      projection: {
        status: domain.status,
        classification: domain.classification,
        issues: issueManifest,
        expected_capacities: expectedCapacities,
        subject_counter_derivation: domain.subject_counter_derivation,
      },
    }
    const legacyEvidenceDigest = repairPlanDigest({
      schema: "capacity-repair-run-evidence-v2",
      command_digest: input.command_digest,
      scope: input.campaign_id ?? null,
      evidence_manifest: legacyEvidenceManifest,
      run_id: runId,
      actions: legacyActions.map(({ evidence_digest: _digest, ...action }) => action),
    })
    const versionedEvidenceDigest = repairPlanDigest({
      schema: "capacity-repair-run-evidence-v3",
      plan_schema_version: 2,
      command_digest: input.command_digest,
      scope: input.campaign_id ?? null,
      evidence_manifest: versionedEvidenceManifest,
      run_id: runId,
      actions: versionedActions.map(
        ({ evidence_digest: _digest, ...action }) => action
      ),
    })
    const actions = planSchemaVersion === 1 ? legacyActions : versionedActions
    const evidenceManifest =
      planSchemaVersion === 1
        ? legacyEvidenceManifest
        : versionedEvidenceManifest
    const evidenceDigest =
      planSchemaVersion === 1 ? legacyEvidenceDigest : versionedEvidenceDigest
    const expectedIdentity = {
      id: identityId,
      request_identity_digest: input.request_identity_digest,
      run_id: runId,
      command_digest: input.command_digest,
      evidence_digest: evidenceDigest,
      created_at: auditAt,
      updated_at: auditAt,
      deleted_at: null,
    }
    const expectedRun = {
      id: runId,
      plan_schema_version: planSchemaVersion,
      request_identity_digest: input.request_identity_digest,
      command_digest: input.command_digest,
      campaign_id: input.campaign_id ?? null,
      activation_id: control?.activation_id ?? null,
      control_schema_version: control?.schema_version ?? null,
      control_root_digest: control?.checkpoint_digest ?? null,
      status,
      classification: domain.classification,
      actor: input.actor,
      reason: input.reason,
      ticket: input.ticket,
      evidence_digest: evidenceDigest,
      issue_codes: issueCodes,
      issue_count: issueManifest.length,
      issue_manifest: issueManifest,
      evidence_manifest: evidenceManifest,
      snapshot_at: auditAt,
      finished_at: auditAt,
      created_at: auditAt,
      updated_at: auditAt,
      deleted_at: null,
    }

    if (existingIdentity && existingRun) {
      const normalizedIdentity = {
        ...existingIdentity,
        created_at: iso(existingIdentity.created_at),
        updated_at: iso(existingIdentity.updated_at),
      }
      const normalizedRun = {
        ...existingRun,
        plan_schema_version: Number(existingRun.plan_schema_version),
        issue_count: Number(existingRun.issue_count),
        snapshot_at: iso(existingRun.snapshot_at),
        finished_at: iso(existingRun.finished_at),
        created_at: iso(existingRun.created_at),
        updated_at: iso(existingRun.updated_at),
      }
      const comparableRun =
        planSchemaVersion === 1
          ? (({ plan_schema_version: _schema, ...run }) => run)(normalizedRun)
          : normalizedRun
      const comparableExpectedRun =
        planSchemaVersion === 1
          ? (({ plan_schema_version: _schema, ...run }) => run)(expectedRun)
          : expectedRun
      if (
        !same(normalizedIdentity, expectedIdentity) ||
        !same(comparableRun, comparableExpectedRun)
      ) {
        invariant("repair identity or Run replay command/evidence drifted")
      }
      const physicalActions = (await manager.execute(
        `select id, run_id, capacity_id,
                before_capacity_version::text as before_capacity_version,
                before_granted_quantity,
                before_held_quantity, before_consumed_quantity,
                before_raw_granted_quantity, before_raw_held_quantity,
                before_raw_consumed_quantity, expected_granted_quantity,
                expected_held_quantity, expected_consumed_quantity,
                expected_raw_granted_quantity, expected_raw_held_quantity,
                expected_raw_consumed_quantity, issue_codes, classification,
                evidence_digest, status, created_at, updated_at, deleted_at
           from flash_sale_capacity_repair_action
          where run_id = ? order by capacity_id, id`,
        [runId]
      )) as RepairActionRow[]
      const normalizedActions = physicalActions.map((row) => ({
        ...row,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      }))
      if (
        planSchemaVersion === 1 &&
        normalizedActions.some((row) => row.before_capacity_version !== null)
      ) {
        invariant("schema v1 repair Action unexpectedly carries version evidence")
      }
      const comparableActions =
        planSchemaVersion === 1
          ? normalizedActions.map(
              ({ before_capacity_version: _version, ...action }) => action
            )
          : normalizedActions
      const expectedActions = [...actions].sort((left, right) =>
        compareRepairPlanKeys(left.capacity_id, right.capacity_id)
      )
      if (!same(comparableActions, expectedActions)) {
        invariant("repair action physical history drifted")
      }
      return this.result("replay", expectedRun, actions)
    }

    await manager.execute(
      `insert into flash_sale_capacity_repair_run
        (id, plan_schema_version, request_identity_digest, command_digest, campaign_id,
         activation_id, control_schema_version, control_root_digest,
         status, classification, actor, reason, ticket, evidence_digest,
         issue_codes, issue_count, issue_manifest, evidence_manifest,
         snapshot_at, finished_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?::integer, ?, ?, ?, ?, ?, ?, ?, ?::jsonb,
               ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)`,
      [
        expectedRun.id,
        expectedRun.plan_schema_version,
        expectedRun.request_identity_digest,
        expectedRun.command_digest,
        expectedRun.campaign_id,
        expectedRun.activation_id,
        expectedRun.control_schema_version,
        expectedRun.control_root_digest,
        expectedRun.status,
        expectedRun.classification,
        expectedRun.actor,
        expectedRun.reason,
        expectedRun.ticket,
        expectedRun.evidence_digest,
        JSON.stringify(expectedRun.issue_codes),
        expectedRun.issue_count,
        JSON.stringify(expectedRun.issue_manifest),
        JSON.stringify(expectedRun.evidence_manifest),
        auditAt,
        auditAt,
        auditAt,
        auditAt,
      ]
    )
    for (const action of versionedActions) {
      await manager.execute(
        `insert into flash_sale_capacity_repair_action
          (id, run_id, capacity_id, before_capacity_version,
           before_granted_quantity,
           before_held_quantity, before_consumed_quantity,
           before_raw_granted_quantity, before_raw_held_quantity,
           before_raw_consumed_quantity, expected_granted_quantity,
           expected_held_quantity, expected_consumed_quantity,
           expected_raw_granted_quantity, expected_raw_held_quantity,
           expected_raw_consumed_quantity, issue_codes, classification,
           evidence_digest, status, created_at, updated_at)
         values (?, ?, ?, ?::integer, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb,
                 ?, ?, ?, ?, ?)`,
        [
          action.id,
          action.run_id,
          action.capacity_id,
          action.before_capacity_version,
          action.before_granted_quantity,
          action.before_held_quantity,
          action.before_consumed_quantity,
          action.before_raw_granted_quantity,
          action.before_raw_held_quantity,
          action.before_raw_consumed_quantity,
          action.expected_granted_quantity,
          action.expected_held_quantity,
          action.expected_consumed_quantity,
          action.expected_raw_granted_quantity,
          action.expected_raw_held_quantity,
          action.expected_raw_consumed_quantity,
          JSON.stringify(action.issue_codes),
          action.classification,
          action.evidence_digest,
          action.status,
          action.created_at,
          action.updated_at,
        ]
      )
    }
    await manager.execute(
      `insert into flash_sale_capacity_repair_identity
        (id, request_identity_digest, run_id, command_digest, evidence_digest,
         created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        expectedIdentity.id,
        expectedIdentity.request_identity_digest,
        expectedIdentity.run_id,
        expectedIdentity.command_digest,
        expectedIdentity.evidence_digest,
        expectedIdentity.created_at,
        expectedIdentity.updated_at,
      ]
    )
    return this.result("fresh", expectedRun, versionedActions)
  }

  private result(
    disposition: "fresh" | "replay",
    run: Readonly<{
      id: string
      plan_schema_version: number
      status: DryRunCapacityRepairResult["status"]
      classification: DryRunCapacityRepairResult["classification"]
      evidence_digest: string
      snapshot_at: string
    }>,
    actions: readonly (RepairActionRow | LegacyRepairActionRow)[]
  ): DryRunCapacityRepairResult {
    const publicActions: CapacityRepairPlanAction[] = actions.map((row) => ({
      id: row.id,
      capacity_id: row.capacity_id,
      before_capacity_version:
        "before_capacity_version" in row ? row.before_capacity_version : null,
      before_granted_quantity: row.before_granted_quantity,
      before_held_quantity: row.before_held_quantity,
      before_consumed_quantity: row.before_consumed_quantity,
      expected_granted_quantity: row.expected_granted_quantity,
      expected_held_quantity: row.expected_held_quantity,
      expected_consumed_quantity: row.expected_consumed_quantity,
      issue_codes: row.issue_codes,
      classification: row.classification,
      status: row.status,
      evidence_digest: row.evidence_digest,
    }))
    return {
      disposition,
      run_id: run.id,
      plan_schema_version: run.plan_schema_version as 1 | 2,
      status: run.status,
      classification: run.classification,
      evidence_digest: run.evidence_digest,
      snapshot_at: new Date(run.snapshot_at),
      actions: publicActions,
    }
  }
}
