import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import {
  MovementLedgerReconciliationStore,
  PreparedReconcileMovementLedgerCommand,
  ReconcileMovementLedgerResult,
} from "../application"
import {
  LedgerAttemptEntity,
  LedgerCapacityEntity,
  LedgerCheckpointEntity,
  LedgerHoldEntity,
  LedgerMovementEntity,
  LedgerPolicyEntity,
  LedgerProjectionInput,
  LedgerReconciliationIssue,
  LedgerReconciliationIssueCode,
  LedgerReconciliationResult,
  reconcileCapacityLedgerProjection,
} from "../domain"
import {
  ALLOCATION_MOVEMENT_LEDGER_CONTROL_ID,
  MovementCheckpointRow,
  MovementControlRow,
  verifyMovementCheckpointRoot,
} from "./capacity-movement-producer"

type ControlRow = MovementControlRow
type CheckpointRow = MovementCheckpointRow
type CapacityRow = LedgerCapacityEntity

type SnapshotRow = {
  snapshot_at: Date | string
  isolation_level: string
  read_only: string
  statement_timeout: string
}

export type MovementLedgerReconciliationObserver = Readonly<{
  snapshotEstablished?: (manager: SqlEntityManager) => Promise<void>
}>

const DRIFT_CODES = new Set<LedgerReconciliationIssueCode>([
  LedgerReconciliationIssueCode.GRANTED_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.CONSUMED_QUANTITY_DRIFT,
  LedgerReconciliationIssueCode.RAW_GRANTED_MIRROR_DRIFT,
  LedgerReconciliationIssueCode.RAW_MIRROR_DRIFT,
])

async function readBatches<T extends { id: string }>(
  manager: SqlEntityManager,
  selectSql: string,
  batchSize: number
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  for (;;) {
    const cursorClause = cursor === null ? "" : " and source.id > ?"
    const parameters = cursor === null ? [batchSize] : [cursor, batchSize]
    const batch = (await manager.execute(
      `${selectSql}${cursorClause} order by source.id limit ?`,
      parameters
    )) as T[]
    rows.push(...batch)
    if (batch.length < batchSize) return rows
    cursor = batch[batch.length - 1].id
  }
}

function manualIssue(
  code: LedgerReconciliationIssueCode,
  detail: string,
  capacityId: string | null = null
): LedgerReconciliationIssue {
  return {
    code,
    classification: "manual_required",
    capacity_id: capacityId,
    detail,
  }
}

function domainResult(
  snapshotAt: Date,
  input: PreparedReconcileMovementLedgerCommand,
  result: LedgerReconciliationResult
): ReconcileMovementLedgerResult {
  return {
    domain: "movement_ledger",
    snapshot_at: snapshotAt,
    scope: { campaign_id: input.campaign_id ?? null },
    status: result.status,
    classification: result.classification,
    issue_count: result.issues.length,
    issues: result.issues.slice(0, input.sample_limit),
    expected_capacities: result.expected_capacities.slice(
      0,
      input.sample_limit
    ),
    subject_counter_derivation: "not_ledger_derived",
  }
}

function manualResult(
  snapshotAt: Date,
  input: PreparedReconcileMovementLedgerCommand,
  issue: LedgerReconciliationIssue
): ReconcileMovementLedgerResult {
  return domainResult(snapshotAt, input, {
    status: "manual_required",
    classification: "manual_required",
    expected_capacities: [],
    issues: [issue],
    subject_counter_derivation: "not_ledger_derived",
  })
}

function verifyPhysicalRootCoverage(
  capacities: readonly CapacityRow[],
  checkpoints: readonly CheckpointRow[]
): LedgerReconciliationIssue | null {
  if (
    capacities.some((capacity) => capacity.deleted_at !== null) ||
    checkpoints.some((checkpoint) => checkpoint.deleted_at !== null)
  ) {
    return manualIssue(
      LedgerReconciliationIssueCode.SOFT_DELETED_EVIDENCE,
      "physical Capacity/Checkpoint root contains deleted or orphan rows"
    )
  }
  if (capacities.length !== checkpoints.length) {
    return manualIssue(
      LedgerReconciliationIssueCode.PHYSICAL_ROW_SET_UNVERIFIED,
      "physical Capacity and Checkpoint counts differ"
    )
  }
  const capacityById = new Map(capacities.map((row) => [row.id, row] as const))
  const seen = new Set<string>()
  for (const checkpoint of checkpoints) {
    const capacity = capacityById.get(checkpoint.capacity_id)
    if (
      !capacity ||
      seen.has(checkpoint.capacity_id) ||
      checkpoint.campaign_item_id !== capacity.campaign_item_id ||
      String(checkpoint.shard_no) !== capacity.shard_no
    ) {
      return manualIssue(
        LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
        "Checkpoint root is not a physical identity bijection",
        checkpoint.capacity_id
      )
    }
    seen.add(checkpoint.capacity_id)
  }
  return null
}

function repairScope(
  policies: readonly LedgerPolicyEntity[],
  capacities: readonly CapacityRow[]
): "open" | "non_open" {
  return policies.some((row) => row.state === "open") ||
    capacities.some((row) => row.state === "open")
    ? "open"
    : "non_open"
}

function scopedInput(
  input: PreparedReconcileMovementLedgerCommand,
  all: LedgerProjectionInput,
  capacities: readonly CapacityRow[],
  policies: readonly LedgerPolicyEntity[]
): LedgerProjectionInput {
  if (!input.campaign_id) return all
  const scopedPolicyIds = new Set(
    policies
      .filter((row) => row.campaign_id === input.campaign_id)
      .map((row) => row.id)
  )
  const capacityIds = new Set(
    capacities
      .filter((row) => scopedPolicyIds.has(row.allocation_policy_id))
      .map((row) => row.id)
  )
  const attemptIds = new Set(
    all.attempts
      .filter((row) => row.campaign_id === input.campaign_id)
      .map((row) => row.id)
  )
  const scopedCapacities = all.capacities.filter((row) => capacityIds.has(row.id))
  return {
    ...all,
    policies: all.policies.filter((row) => scopedPolicyIds.has(row.id)),
    checkpoints: all.checkpoints.filter((row) => capacityIds.has(row.capacity_id)),
    movements: all.movements.filter(
      (row) => capacityIds.has(row.capacity_id) || attemptIds.has(row.attempt_id)
    ),
    capacities: scopedCapacities,
    attempts: all.attempts.filter((row) => attemptIds.has(row.id)),
    holds: all.holds.filter(
      (row) => capacityIds.has(row.capacity_id) || attemptIds.has(row.attempt_id)
    ),
    repair_scope: repairScope(
      all.policies.filter((row) => scopedPolicyIds.has(row.id)),
      scopedCapacities
    ),
  }
}

export class PostgresMovementLedgerReconciliationStore
  implements MovementLedgerReconciliationStore
{
  constructor(
    private readonly baseRepository: DAL.RepositoryService,
    private readonly observer?: MovementLedgerReconciliationObserver
  ) {}

  async reconcileMovementLedger(
    input: PreparedReconcileMovementLedgerCommand
  ): Promise<ReconcileMovementLedgerResult> {
    return await this.baseRepository.transaction<SqlEntityManager>(
      async (manager) => {
        await manager.execute(
          "set transaction isolation level repeatable read read only"
        )
        await manager.execute(
          `set local statement_timeout = '${input.statement_timeout_ms}ms'`
        )
        const snapshots = (await manager.execute(
          `select transaction_timestamp() as snapshot_at,
                  current_setting('transaction_isolation') as isolation_level,
                  current_setting('transaction_read_only') as read_only,
                  current_setting('statement_timeout') as statement_timeout`
        )) as SnapshotRow[]
        const snapshot = snapshots[0]
        if (
          !snapshot ||
          snapshot.isolation_level !== "repeatable read" ||
          snapshot.read_only !== "on"
        ) {
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            "Movement Ledger reconciliation requires a read-only repeatable-read snapshot"
          )
        }
        const snapshotAt = new Date(snapshot.snapshot_at)
        await this.observer?.snapshotEstablished?.(manager)

        const controls = await readBatches<ControlRow>(
          manager,
          `select source.id, source.activation_id, source.required_after,
                  source.schema_version::text as schema_version,
                  source.checkpoint_digest, source.deleted_at
             from flash_sale_capacity_movement_control source
            where true`,
          input.batch_size
        )
        const checkpoints = await readBatches<CheckpointRow>(
          manager,
          `select source.id, source.activation_id, source.capacity_id,
                  source.campaign_item_id, source.checkpoint_kind,
                  source.shard_no::text as shard_no,
                  source.opening_granted_quantity::text as opening_granted_quantity,
                  source.opening_available_quantity::text as opening_available_quantity,
                  source.opening_held_quantity::text as opening_held_quantity,
                  source.opening_consumed_quantity::text as opening_consumed_quantity,
                  source.capacity_version::text as capacity_version,
                  source.activated_at,
                  source.raw_opening_granted_quantity::text as raw_opening_granted_quantity,
                  source.raw_opening_available_quantity::text as raw_opening_available_quantity,
                  source.raw_opening_held_quantity::text as raw_opening_held_quantity,
                  source.raw_opening_consumed_quantity::text as raw_opening_consumed_quantity,
                  source.deleted_at
             from flash_sale_capacity_movement_checkpoint source
            where true`,
          input.batch_size
        )
        const movements = await readBatches<LedgerMovementEntity>(
          manager,
          `select source.id, '1'::text as schema_version, source.capacity_id,
                  source.attempt_id, source.campaign_id, source.subject_id,
                  source.campaign_item_id,
                  source.transition_version::text as transition_version,
                  source.kind, source.from_bucket, source.to_bucket,
                  source.quantity::text as quantity,
                  source.raw_quantity::text as raw_quantity,
                  source.fence_token, source.deleted_at
             from flash_sale_capacity_movement source
            where true`,
          input.batch_size
        )
        const policies = await readBatches<LedgerPolicyEntity>(
          manager,
          `select source.id, source.campaign_id, source.state, source.deleted_at
             from flash_sale_allocation_policy source
            where true`,
          input.batch_size
        )
        const capacities = await readBatches<CapacityRow>(
          manager,
          `select source.id, source.allocation_policy_id,
                  source.campaign_item_id, source.shard_no::text as shard_no,
                  source.state,
                  source.granted_quantity::text as granted_quantity,
                  source.held_quantity::text as held_quantity,
                  source.consumed_quantity::text as consumed_quantity,
                  source.raw_granted_quantity::text as raw_granted_quantity,
                  source.raw_held_quantity::text as raw_held_quantity,
                  source.raw_consumed_quantity::text as raw_consumed_quantity,
                  source.deleted_at
             from flash_sale_capacity source
            where true`,
          input.batch_size
        )
        const attempts = await readBatches<LedgerAttemptEntity>(
          manager,
          `select source.id, source.allocation_policy_id,
                  source.campaign_id, source.subject_id,
                  source.state, source.version::text as version,
                  source.settlement_id,
                  source.hold_movement_activation_id,
                  source.terminal_movement_activation_id,
                  source.deleted_at
             from flash_sale_purchase_attempt source
            where true`,
          input.batch_size
        )
        const holds = await readBatches<LedgerHoldEntity>(
          manager,
          `select source.id, source.attempt_id, source.capacity_id,
                  source.campaign_item_id, source.quantity::text as quantity,
                  source.raw_quantity::text as raw_quantity,
                  source.state, source.deleted_at
             from flash_sale_allocation_hold source
            where true`,
          input.batch_size
        )
        const checkpointEntities: LedgerCheckpointEntity[] = checkpoints.map(
          (row) => ({
            id: row.id,
            activation_id: row.activation_id,
            capacity_id: row.capacity_id,
            campaign_item_id: row.campaign_item_id,
            checkpoint_kind: row.checkpoint_kind,
            shard_no: String(row.shard_no),
            opening_granted_quantity: String(row.opening_granted_quantity),
            opening_available_quantity: String(row.opening_available_quantity),
            opening_held_quantity: String(row.opening_held_quantity),
            opening_consumed_quantity: String(row.opening_consumed_quantity),
            raw_opening_granted_quantity:
              row.raw_opening_granted_quantity,
            raw_opening_available_quantity:
              row.raw_opening_available_quantity,
            raw_opening_held_quantity: row.raw_opening_held_quantity,
            raw_opening_consumed_quantity:
              row.raw_opening_consumed_quantity,
            deleted_at: row.deleted_at
              ? new Date(row.deleted_at).toISOString()
              : null,
          })
        )
        const baseInput: LedgerProjectionInput = {
          control: null,
          checkpoints: checkpointEntities,
          movements,
          policies,
          capacities,
          attempts,
          holds,
          verification: {
            checkpoint_root_verified: true,
            physical_row_set_verified: true,
            attempt_bindings_complete: true,
            hold_facts_complete: true,
          },
          repair_scope: repairScope(policies, capacities),
        }
        const requestedScopePolicyIds = new Set(
          policies
            .filter((policy) => policy.campaign_id === input.campaign_id)
            .map((policy) => policy.id)
        )
        const scopeExists =
          !input.campaign_id ||
          capacities.some((capacity) =>
            requestedScopePolicyIds.has(capacity.allocation_policy_id)
          )

        if (controls.length === 0) {
          const unactivated = reconcileCapacityLedgerProjection(baseInput)
          if (unactivated.status === "manual_required") {
            return domainResult(snapshotAt, input, unactivated)
          }
          if (!scopeExists) {
            return manualResult(
              snapshotAt,
              input,
              manualIssue(
                LedgerReconciliationIssueCode.SCOPE_NOT_FOUND,
                `campaign scope ${input.campaign_id} has no physical Policy`
              )
            )
          }
          return domainResult(snapshotAt, input, unactivated)
        }
        if (
          controls.length !== 1 ||
          controls[0].id !== ALLOCATION_MOVEMENT_LEDGER_CONTROL_ID ||
          controls[0].deleted_at !== null
        ) {
          return manualResult(
            snapshotAt,
            input,
            manualIssue(
              controls.some((row) => row.deleted_at !== null)
                ? LedgerReconciliationIssueCode.SOFT_DELETED_EVIDENCE
                : LedgerReconciliationIssueCode.CHECKPOINT_ROOT_UNVERIFIED,
              "Movement Ledger Control is not one live canonical singleton"
            )
          )
        }
        const control = controls[0]
        if (control.schema_version !== "1" && control.schema_version !== "2") {
          return manualResult(
            snapshotAt,
            input,
            manualIssue(
              LedgerReconciliationIssueCode.UNKNOWN_CONTROL_SCHEMA,
              `unknown Control root schema ${control.schema_version}`
            )
          )
        }
        const coverageIssue = verifyPhysicalRootCoverage(capacities, checkpoints)
        if (coverageIssue) return manualResult(snapshotAt, input, coverageIssue)
        try {
          verifyMovementCheckpointRoot(checkpoints, control)
        } catch {
          return manualResult(
            snapshotAt,
            input,
            manualIssue(
              LedgerReconciliationIssueCode.CHECKPOINT_ROOT_UNVERIFIED,
              "Checkpoint canonical root verification failed"
            )
          )
        }
        const all: LedgerProjectionInput = {
          ...baseInput,
          control: {
            id: control.id,
            activation_id: control.activation_id,
            schema_version: control.schema_version,
            checkpoint_digest: control.checkpoint_digest,
            deleted_at: control.deleted_at
              ? new Date(control.deleted_at).toISOString()
              : null,
          },
        }
        const global = reconcileCapacityLedgerProjection(all)
        const globalIntegrityIssues = global.issues.filter(
          (issue) => !DRIFT_CODES.has(issue.code)
        )
        if (globalIntegrityIssues.length > 0) {
          return domainResult(snapshotAt, input, {
            status: "manual_required",
            classification: "manual_required",
            expected_capacities: [],
            issues: globalIntegrityIssues,
            subject_counter_derivation: "not_ledger_derived",
          })
        }
        if (!scopeExists) {
          return manualResult(
            snapshotAt,
            input,
            manualIssue(
              LedgerReconciliationIssueCode.SCOPE_NOT_FOUND,
              `campaign scope ${input.campaign_id} has no physical Policy`
            )
          )
        }
        const scoped = input.campaign_id
          ? reconcileCapacityLedgerProjection(
              scopedInput(input, all, capacities, policies)
            )
          : global
        return domainResult(snapshotAt, input, scoped)
      }
    )
  }
}
