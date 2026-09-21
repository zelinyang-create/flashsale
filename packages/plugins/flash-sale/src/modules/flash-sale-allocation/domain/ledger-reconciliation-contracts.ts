import {
  AllocationHoldState,
  CapacityMovementBucket,
  CapacityMovementCheckpointKind,
  CapacityMovementKind,
  CapacityState,
  PurchaseAttemptState,
} from "../../../types"

export type LedgerReconciliationStatus =
  | "not_activated"
  | "healthy"
  | "drift"
  | "manual_required"

export type LedgerIssueClassification = "safe_repair" | "manual_required"

export enum LedgerReconciliationIssueCode {
  CONTROL_MISSING_WITH_LEDGER_ROWS = "control_missing_with_ledger_rows",
  UNKNOWN_CONTROL_SCHEMA = "unknown_control_schema",
  CHECKPOINT_ROOT_UNVERIFIED = "checkpoint_root_unverified",
  PHYSICAL_ROW_SET_UNVERIFIED = "physical_row_set_unverified",
  CHECKPOINT_IDENTITY_MISMATCH = "checkpoint_identity_mismatch",
  SOFT_DELETED_EVIDENCE = "soft_deleted_evidence",
  ATTEMPT_BINDING_MISMATCH = "attempt_binding_mismatch",
  LEDGER_FACT_MISMATCH = "ledger_fact_mismatch",
  INVALID_DECIMAL = "invalid_decimal",
  UNSUPPORTED_CHECKPOINT_KIND = "unsupported_checkpoint_kind",
  UNSUPPORTED_MOVEMENT_SCHEMA = "unsupported_movement_schema",
  UNSUPPORTED_MOVEMENT_ROUTE = "unsupported_movement_route",
  UNSUPPORTED_TRANSITION_VERSION = "unsupported_transition_version",
  DUPLICATE_MOVEMENT_IDENTITY = "duplicate_movement_identity",
  CHECKPOINT_CONSERVATION_VIOLATION = "checkpoint_conservation_violation",
  PROJECTED_CONSERVATION_VIOLATION = "projected_conservation_violation",
  GRANTED_QUANTITY_DRIFT = "granted_quantity_drift",
  HELD_QUANTITY_DRIFT = "held_quantity_drift",
  CONSUMED_QUANTITY_DRIFT = "consumed_quantity_drift",
  RAW_GRANTED_MIRROR_DRIFT = "raw_granted_mirror_drift",
  RAW_MIRROR_DRIFT = "raw_mirror_drift",
}

export type LedgerDecimalMirror =
  | Readonly<{ value: unknown; precision: unknown }>
  | string
  | null

export type LedgerControlEntity = Readonly<{
  id: string
  activation_id: string
  schema_version: string
  checkpoint_digest: string
  deleted_at: string | null
}>

export type LedgerCheckpointEntity = Readonly<{
  id: string
  activation_id: string
  capacity_id: string
  campaign_item_id: string
  checkpoint_kind: CapacityMovementCheckpointKind | string
  shard_no: string
  opening_granted_quantity: string
  opening_available_quantity: string
  opening_held_quantity: string
  opening_consumed_quantity: string
  raw_opening_granted_quantity: LedgerDecimalMirror
  raw_opening_available_quantity: LedgerDecimalMirror
  raw_opening_held_quantity: LedgerDecimalMirror
  raw_opening_consumed_quantity: LedgerDecimalMirror
  deleted_at: string | null
}>

export type LedgerMovementEntity = Readonly<{
  id: string
  schema_version: string
  capacity_id: string
  attempt_id: string
  campaign_id: string
  subject_id: string
  campaign_item_id: string
  transition_version: string
  kind: CapacityMovementKind | string
  from_bucket: CapacityMovementBucket | string
  to_bucket: CapacityMovementBucket | string
  quantity: string
  raw_quantity: LedgerDecimalMirror
  deleted_at: string | null
}>

export type LedgerCapacityEntity = Readonly<{
  id: string
  campaign_item_id: string
  shard_no: string
  state: CapacityState | string
  granted_quantity: string
  held_quantity: string
  consumed_quantity: string
  raw_granted_quantity: LedgerDecimalMirror
  raw_held_quantity: LedgerDecimalMirror
  raw_consumed_quantity: LedgerDecimalMirror
  deleted_at: string | null
}>

export type LedgerAttemptEntity = Readonly<{
  id: string
  campaign_id: string
  subject_id: string
  state: PurchaseAttemptState | string
  version: string
  settlement_id: string | null
  hold_movement_activation_id: string | null
  terminal_movement_activation_id: string | null
  deleted_at: string | null
}>

export type LedgerHoldEntity = Readonly<{
  id: string
  attempt_id: string
  capacity_id: string
  campaign_item_id: string
  quantity: string
  raw_quantity: LedgerDecimalMirror
  state: AllocationHoldState | string
  deleted_at: string | null
}>

export type LedgerEvidenceVerification = Readonly<{
  checkpoint_root_verified: boolean
  physical_row_set_verified: boolean
  attempt_bindings_complete: boolean
  hold_facts_complete: boolean
}>

export type LedgerProjectionInput = Readonly<{
  control: LedgerControlEntity | null
  checkpoints: readonly LedgerCheckpointEntity[]
  movements: readonly LedgerMovementEntity[]
  capacities: readonly LedgerCapacityEntity[]
  attempts: readonly LedgerAttemptEntity[]
  holds: readonly LedgerHoldEntity[]
  verification: LedgerEvidenceVerification
  repair_scope: "open" | "paused" | "non_open"
}>

export type ProjectedCapacityCounters = Readonly<{
  capacity_id: string
  campaign_item_id: string
  granted_quantity: string
  available_quantity: string
  held_quantity: string
  consumed_quantity: string
}>

export type LedgerReconciliationIssue = Readonly<{
  code: LedgerReconciliationIssueCode
  classification: LedgerIssueClassification
  capacity_id: string | null
  detail: string
}>

export type LedgerReconciliationResult = Readonly<{
  status: LedgerReconciliationStatus
  classification: LedgerIssueClassification | null
  expected_capacities: readonly ProjectedCapacityCounters[]
  issues: readonly LedgerReconciliationIssue[]
  subject_counter_derivation: "not_ledger_derived"
}>
