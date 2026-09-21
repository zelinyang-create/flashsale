import {
  AllocationItemInput,
  LedgerIssueClassification,
  LedgerReconciliationIssue,
  LedgerReconciliationStatus,
  NormalizedAllocationItem,
  ProjectedCapacityCounters,
} from "../domain"
import {
  AllocationFenceDisposition,
  AllocationOutboxStatus,
  AllocationPolicyState,
  CapacityState,
  PurchaseAttemptState,
} from "../../../types"

export type ClaimedAllocationOutboxEvent = Readonly<{
  id: string
  event_name: string
  schema_version: number
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number
  event_hash: string
  payload: Record<string, unknown>
  status: AllocationOutboxStatus
  available_at: Date
  occurred_at: Date
  published_at: Date | null
  attempt_count: number
  max_attempts: number | null
  lease_owner: string | null
  lease_until: Date | null
  lease_epoch: number
  published_by: string | null
  published_lease_epoch: number | null
  last_error_code: string | null
  dead_lettered_at: Date | null
  redrive_count: number
}>

export type ActivateAllocationOutboxCommand = Readonly<Record<string, never>>
export type ActivateAllocationOutboxResult = Readonly<{
  required_after: Date
  replayed: boolean
}>

export type ActivateAllocationMovementLedgerCommand = Readonly<
  Record<string, never>
>
export type ActivateAllocationMovementLedgerResult = Readonly<{
  activation_id: string
  required_after: Date
  schema_version: 1 | 2
  checkpoint_count: number
  replayed: boolean
}>
export type ClaimAllocationOutboxEventsCommand = Readonly<{
  worker_id: string
  limit: number
  lease_seconds: number
  max_attempts: number
}>
export type ClaimAllocationOutboxEventsResult = Readonly<{
  events: readonly ClaimedAllocationOutboxEvent[]
}>
export type MarkAllocationOutboxPublishedCommand = Readonly<{
  event_id: string
  worker_id: string
  lease_epoch: number
}>
export type FailAllocationOutboxEventCommand = Readonly<{
  event_id: string
  worker_id: string
  lease_epoch: number
  retry_after_seconds: number
  error_code: string
  permanent: boolean
}>
export type RedriveAllocationOutboxEventCommand = Readonly<{
  event_id: string
  event_hash: string
}>
export type AllocationOutboxMutationResult = Readonly<{
  disposition: "published" | "retried" | "dead_lettered" | "redriven" | "fenced"
  event: ClaimedAllocationOutboxEvent | null
}>

export const ALLOCATION_REQUEST_SCHEMA_VERSION = 1 as const

export type ClaimAttemptCommand = Readonly<{
  campaign_id: string
  subject_id: string
  cart_id: string | null
  idempotency_key_hash: string
  expected_rules_version: number
  items: readonly AllocationItemInput[]
}>

export type ClaimedPurchaseAttempt = Readonly<{
  id: string
  allocation_policy_id: string
  campaign_id: string
  subject_id: string
  cart_id: string | null
  idempotency_key_hash: string
  request_hash: string
  state: PurchaseAttemptState
  rules_version: number
  expires_at: Date
  version: number
  last_error_code: string | null
  terminal_at: Date | null
  settlement_id: string | null
  settlement_started_at: Date | null
  hold_movement_activation_id: string | null
  terminal_movement_activation_id: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}>

export type ClaimAttemptResult = Readonly<{
  attempt: ClaimedPurchaseAttempt
  replayed: boolean
}>

export type HoldQuotaCommand = Readonly<{
  attempt_id: string
  campaign_id: string
  subject_id: string
  cart_id: string | null
  expected_rules_version: number
  items: readonly AllocationItemInput[]
}>

export type ClaimAndHoldQuotaCommand = ClaimAttemptCommand

export type ClaimedAllocationHold = Readonly<{
  id: string
  attempt_id: string
  capacity_id: string
  campaign_item_id: string
  quantity: number
  state: "held" | "consumed" | "released" | "expired"
  expires_at: Date
  version: number
  resolved_at: Date | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}>

export type HoldQuotaResult =
  | Readonly<{
      status: "held"
      attempt: ClaimedPurchaseAttempt
      holds: readonly ClaimedAllocationHold[]
      replayed: boolean
    }>
  | Readonly<{
      status: "rejected"
      attempt: ClaimedPurchaseAttempt
      error_code: AllocationCommandErrorCode
      replayed: boolean
    }>

export type HoldQuotaPersistenceInput = Readonly<{
  attempt_id: string
  campaign_id: string
  subject_id: string
  cart_id: string | null
  request_hash: string
  expected_rules_version: number
  items: readonly NormalizedAllocationItem[]
}>

export type CancelHeldQuotaCommand = Readonly<{
  attempt_id: string
}>

export type ExpireQuotaCommand = Readonly<{
  attempt_id: string
}>

export type SettlementQuotaCommand = Readonly<{
  attempt_id: string
  settlement_id: string
}>

export type SettleQuotaResult = Readonly<{
  attempt: ClaimedPurchaseAttempt
  holds: readonly ClaimedAllocationHold[]
  replayed: boolean
}>

export type ExpireDueQuotaCommand = Readonly<{
  limit: number
}>

export type ExpireDueQuotaResult = Readonly<{
  scanned: number
  expired: number
  conflicted: number
  failed: number
  failures: readonly Readonly<{
    attempt_id: string
    error_code:
      | AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION
      | AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE
  }>[]
  attempt_ids: readonly string[]
}>

export const DEFAULT_RECONCILIATION_SAMPLE_LIMIT = 20
export const MAX_RECONCILIATION_SAMPLE_LIMIT = 100

export type ReconcileAllocationCommand = Readonly<{
  campaign_id?: string
  sample_limit?: number
}>

export enum AllocationInvariantIssueCode {
  CAPACITY_HELD_MISMATCH = "CAPACITY_HELD_MISMATCH",
  CAPACITY_CONSUMED_MISMATCH = "CAPACITY_CONSUMED_MISMATCH",
  CAPACITY_BALANCE_EXCEEDED = "CAPACITY_BALANCE_EXCEEDED",
  CAPACITY_RAW_GRANTED_MISMATCH = "CAPACITY_RAW_GRANTED_MISMATCH",
  CAPACITY_RAW_HELD_MISMATCH = "CAPACITY_RAW_HELD_MISMATCH",
  CAPACITY_RAW_CONSUMED_MISMATCH = "CAPACITY_RAW_CONSUMED_MISMATCH",
  SUBJECT_HELD_MISMATCH = "SUBJECT_HELD_MISMATCH",
  SUBJECT_CONSUMED_MISMATCH = "SUBJECT_CONSUMED_MISMATCH",
  SUBJECT_BALANCE_EXCEEDED = "SUBJECT_BALANCE_EXCEEDED",
  SUBJECT_RAW_LIMIT_MISMATCH = "SUBJECT_RAW_LIMIT_MISMATCH",
  SUBJECT_RAW_HELD_MISMATCH = "SUBJECT_RAW_HELD_MISMATCH",
  SUBJECT_RAW_CONSUMED_MISMATCH = "SUBJECT_RAW_CONSUMED_MISMATCH",
  SUBJECT_ALLOCATION_MISSING = "SUBJECT_ALLOCATION_MISSING",
  ATTEMPT_HOLD_MISSING = "ATTEMPT_HOLD_MISSING",
  ATTEMPT_UNEXPECTED_HOLD = "ATTEMPT_UNEXPECTED_HOLD",
  ATTEMPT_HOLD_STATE_MISMATCH = "ATTEMPT_HOLD_STATE_MISMATCH",
  ATTEMPT_POLICY_IDENTITY_MISMATCH = "ATTEMPT_POLICY_IDENTITY_MISMATCH",
  HOLD_ATTEMPT_ORPHAN_OR_DELETED = "HOLD_ATTEMPT_ORPHAN_OR_DELETED",
  HOLD_CAPACITY_ORPHAN_OR_DELETED = "HOLD_CAPACITY_ORPHAN_OR_DELETED",
  HOLD_CAPACITY_IDENTITY_MISMATCH = "HOLD_CAPACITY_IDENTITY_MISMATCH",
  HOLD_EXPIRY_MISMATCH = "HOLD_EXPIRY_MISMATCH",
  HOLD_RAW_QUANTITY_MISMATCH = "HOLD_RAW_QUANTITY_MISMATCH",
  CAPACITY_POLICY_ORPHAN_OR_DELETED = "CAPACITY_POLICY_ORPHAN_OR_DELETED",
  POLICY_CAPACITY_MISSING = "POLICY_CAPACITY_MISSING",
  POLICY_CAPACITY_STATE_MISMATCH = "POLICY_CAPACITY_STATE_MISMATCH",
  POLICY_CAPACITY_RULES_VERSION_MISMATCH = "POLICY_CAPACITY_RULES_VERSION_MISMATCH",
  FENCED_POLICY_ACTIVE = "FENCED_POLICY_ACTIVE",
  FENCED_CAPACITY_ACTIVE = "FENCED_CAPACITY_ACTIVE",
  OUTBOX_CURRENT_EVENT_MISSING = "OUTBOX_CURRENT_EVENT_MISSING",
  OUTBOX_CURRENT_EVENT_NAME_MISMATCH = "OUTBOX_CURRENT_EVENT_NAME_MISMATCH",
}

export type AllocationInvariantSample = Readonly<{
  code: AllocationInvariantIssueCode
  entity_type: "policy" | "capacity" | "attempt" | "hold" | "subject"
  entity_id: string
}>

export enum AllocationReconciliationSkipReason {
  ALREADY_RUNNING = "ALREADY_RUNNING",
}

export type ReconcileAllocationResult = Readonly<{
  snapshot_at: Date
  healthy: boolean
  skipped: boolean
  skip_reason: AllocationReconciliationSkipReason | null
  issue_count: number
  counts: Readonly<Partial<Record<AllocationInvariantIssueCode, number>>>
  samples: readonly AllocationInvariantSample[]
}>

export type ProvisionAllocationItem = Readonly<{
  campaign_item_id: string
  quota: number
}>

export type ProvisionAllocationCommand = Readonly<{
  campaign_id: string
  rules_version: number
  configuration_hash: string
  starts_at: string
  ends_at: string
  hold_ttl_seconds: number
  per_subject_limit: number
  items: readonly ProvisionAllocationItem[]
}>

export type ProvisionAllocationPersistenceInput = ProvisionAllocationCommand

export type ProvisionedAllocationPolicy = Readonly<{
  id: string
  campaign_id: string
  rules_version: number
  configuration_hash: string
  state: AllocationPolicyState
  starts_at: Date
  ends_at: Date
  hold_ttl_seconds: number
  per_subject_limit: number
  version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}>

export type ProvisionedCapacity = Readonly<{
  id: string
  allocation_policy_id: string
  campaign_item_id: string
  shard_no: number
  state: CapacityState
  granted_quantity: number
  held_quantity: number
  consumed_quantity: number
  rules_version: number
  version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}>

export type AllocationControlResult = Readonly<{
  policy: ProvisionedAllocationPolicy
  capacities: readonly ProvisionedCapacity[]
  replayed: boolean
}>

export type TransitionAllocationCommand = Readonly<{
  policy_id: string
  expected_rules_version: number
  expected_version: number
}>

export type FenceAndCloseCampaignAllocationCommand = Readonly<{
  campaign_id: string
  disposition: AllocationFenceDisposition
  campaign_version: number
  rules_version: number
}>

export type AllocationCampaignFenceRecord = Readonly<{
  id: string
  campaign_id: string
  disposition: AllocationFenceDisposition
  campaign_version: number
  rules_version: number
  version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}>

export type AllocationCampaignFenceResult = Readonly<{
  fence: AllocationCampaignFenceRecord
  closed_policies: readonly ProvisionedAllocationPolicy[]
  closed_capacities: readonly ProvisionedCapacity[]
  replayed: boolean
}>

export type ClaimAttemptPersistenceInput = Readonly<{
  campaign_id: string
  subject_id: string
  cart_id: string | null
  idempotency_key_hash: string
  request_hash: string
  expected_rules_version: number
  items: readonly NormalizedAllocationItem[]
}>

export interface AllocationAttemptStore {
  claimAttempt(input: ClaimAttemptPersistenceInput): Promise<ClaimAttemptResult>
}

export interface AllocationQuotaStore extends AllocationAttemptStore {
  holdQuota(input: HoldQuotaPersistenceInput): Promise<HoldQuotaResult>
  claimAndHoldQuota(
    input: ClaimAttemptPersistenceInput
  ): Promise<HoldQuotaResult>
  cancelHeldQuota(input: CancelHeldQuotaCommand): Promise<SettleQuotaResult>
  beginQuotaSettlement(
    input: SettlementQuotaCommand
  ): Promise<SettleQuotaResult>
  authorizeQuotaSettlement(
    input: SettlementQuotaCommand
  ): Promise<SettleQuotaResult>
  consumeQuotaSettlement(
    input: SettlementQuotaCommand
  ): Promise<SettleQuotaResult>
  releaseQuotaSettlement(
    input: SettlementQuotaCommand
  ): Promise<SettleQuotaResult>
  expireQuota(input: ExpireQuotaCommand): Promise<SettleQuotaResult>
  expireDueQuota(input: ExpireDueQuotaCommand): Promise<ExpireDueQuotaResult>
}

export interface AllocationControlStore {
  provisionAllocation(
    input: ProvisionAllocationPersistenceInput
  ): Promise<AllocationControlResult>
  openAllocation(
    input: TransitionAllocationCommand
  ): Promise<AllocationControlResult>
  closeAllocation(
    input: TransitionAllocationCommand
  ): Promise<AllocationControlResult>
  fenceAndCloseCampaignAllocation(
    input: FenceAndCloseCampaignAllocationCommand
  ): Promise<AllocationCampaignFenceResult>
}

export interface AllocationReconciliationStore {
  reconcileAllocation(
    input: Required<Pick<ReconcileAllocationCommand, "sample_limit">> &
      Pick<ReconcileAllocationCommand, "campaign_id">
  ): Promise<ReconcileAllocationResult>
}

export const DEFAULT_MOVEMENT_LEDGER_SAMPLE_LIMIT = 20
export const MAX_MOVEMENT_LEDGER_SAMPLE_LIMIT = 100
export const DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS = 5_000
export const MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS = 30_000
export const DEFAULT_MOVEMENT_LEDGER_BATCH_SIZE = 500
export const MAX_MOVEMENT_LEDGER_BATCH_SIZE = 5_000

export type ReconcileMovementLedgerCommand = Readonly<{
  campaign_id?: string
  sample_limit?: number
  statement_timeout_ms?: number
  batch_size?: number
}>

export type PreparedReconcileMovementLedgerCommand = Readonly<{
  campaign_id?: string
  sample_limit: number
  statement_timeout_ms: number
  batch_size: number
}>

export type ReconcileMovementLedgerResult = Readonly<{
  domain: "movement_ledger"
  snapshot_at: Date
  scope: Readonly<{ campaign_id: string | null }>
  status: LedgerReconciliationStatus
  classification: LedgerIssueClassification | null
  issue_count: number
  issues: readonly LedgerReconciliationIssue[]
  expected_capacities: readonly ProjectedCapacityCounters[]
  subject_counter_derivation: "not_ledger_derived"
}>

export interface MovementLedgerReconciliationStore {
  reconcileMovementLedger(
    input: PreparedReconcileMovementLedgerCommand
  ): Promise<ReconcileMovementLedgerResult>
}

export type DryRunCapacityRepairCommand = Readonly<{
  request_id?: string
  idempotency_key?: string
  campaign_id?: string
  actor: string
  reason: string
  ticket: string
  statement_timeout_ms?: number
  batch_size?: number
}>

export type PreparedDryRunCapacityRepairCommand = Readonly<{
  request_identity_digest: string
  command_digest: string
  campaign_id?: string
  actor: string
  reason: string
  ticket: string
  statement_timeout_ms: number
  batch_size: number
}>

export type CapacityRepairPlanAction = Readonly<{
  id: string
  capacity_id: string
  before_capacity_version: string | null
  before_granted_quantity: string
  before_held_quantity: string
  before_consumed_quantity: string
  expected_granted_quantity: string
  expected_held_quantity: string
  expected_consumed_quantity: string
  issue_codes: readonly string[]
  classification: "safe_repair"
  status: "proposed"
  evidence_digest: string
}>

export type DryRunCapacityRepairResult = Readonly<{
  disposition: "fresh" | "replay"
  run_id: string
  plan_schema_version: 1 | 2
  status: "not_activated" | "no_changes" | "planned" | "manual_required"
  classification: LedgerIssueClassification | null
  evidence_digest: string
  snapshot_at: Date
  actions: readonly CapacityRepairPlanAction[]
}>

export interface CapacityRepairPlanStore {
  dryRunCapacityRepair(
    input: PreparedDryRunCapacityRepairCommand
  ): Promise<DryRunCapacityRepairResult>
}

export const MAX_CAPACITY_REPAIR_APPLY_ACTIONS = 100

export type ApplyCapacityRepairCommand = Readonly<{
  request_id?: string
  idempotency_key?: string
  plan_run_id: string
  expected_plan_evidence_digest: string
  action_ids: readonly string[]
  requester: string
  reason: string
  ticket: string
  approval_credential: string
  approval_reference: string
  statement_timeout_ms?: number
}>

export type RepairApprovalVerificationRequest = Readonly<{
  credential: string
  reference: string
}>

// Every field is supplied by the trusted verifier, never copied from the
// caller command. The verifier must enforce a fixed algorithm/key allowlist,
// issuer/audience/tenant/purpose/permission policy, signature and revocation;
// it must reject alg=none and remote jku/x5u key discovery. Command preparation
// adds defense-in-depth binding and freshness checks only.
export type VerifiedRepairApproval = Readonly<{
  approver: string
  issuer: string
  audience: string
  tenant: string
  jti: string
  issued_at: Date
  not_before: Date
  expires_at: Date
  roles: readonly string[]
  purpose: "capacity_repair_apply"
  permission_version: string
  approval_reference: string
  plan_schema_version: 2
  campaign_id: string
  plan_run_id: string
  plan_evidence_digest: string
  ordered_action_set_digest: string
}>

export interface RepairApprovalVerifier {
  verify(
    input: RepairApprovalVerificationRequest
  ): Promise<VerifiedRepairApproval>
}

export type PreparedApplyCapacityRepairCommand = Readonly<{
  request_identity_digest: string
  command_digest: string
  plan_run_id: string
  plan_schema_version: 2
  campaign_id: string
  expected_plan_evidence_digest: string
  ordered_action_ids: readonly string[]
  ordered_action_set_digest: string
  requester: string
  reason: string
  ticket: string
  statement_timeout_ms: number
  approval_token_digest: string
  approval_claims_digest: string
  approval_reference_digest: string
  approver: string
  approval_issuer: string
  approval_audience: string
  approval_tenant: string
  approval_jti_digest: string
  approval_permission_version: string
  approval_issued_at: string
  approval_not_before: string
  approval_expires_at: string
  approval_roles: readonly string[]
  approval_purpose: "capacity_repair_apply"
}>

export type AppliedCapacityRepairAction = Readonly<{
  id: string
  plan_action_id: string
  capacity_id: string
  before_capacity_version: string
  after_capacity_version: string
  before_held_quantity: string
  before_consumed_quantity: string
  after_held_quantity: string
  after_consumed_quantity: string
  evidence_digest: string
}>

export type ApplyCapacityRepairResult = Readonly<{
  disposition: "fresh" | "replay"
  apply_run_id: string
  plan_run_id: string
  result_digest: string
  outbox_event_id: string
  actions: readonly AppliedCapacityRepairAction[]
}>

export interface CapacityRepairApplyStore {
  applyCapacityRepair(
    input: PreparedApplyCapacityRepairCommand
  ): Promise<ApplyCapacityRepairResult>
}

export interface AllocationStore
  extends AllocationQuotaStore,
    AllocationControlStore {}

export interface AllocationOutboxStore {
  activateOutboxRequired(
    input: ActivateAllocationOutboxCommand
  ): Promise<ActivateAllocationOutboxResult>
  claimOutboxEvents(
    input: ClaimAllocationOutboxEventsCommand
  ): Promise<ClaimAllocationOutboxEventsResult>
  markOutboxPublished(
    input: MarkAllocationOutboxPublishedCommand
  ): Promise<AllocationOutboxMutationResult>
  failOutboxEvent(
    input: FailAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult>
  redriveOutboxEvent(
    input: RedriveAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult>
}

export interface AllocationMovementLedgerStore {
  activateMovementLedger(
    input: ActivateAllocationMovementLedgerCommand
  ): Promise<ActivateAllocationMovementLedgerResult>
}

export enum AllocationCommandErrorCode {
  INVALID_COMMAND = "INVALID_COMMAND",
  INVALID_IDEMPOTENCY_KEY_HASH = "INVALID_IDEMPOTENCY_KEY_HASH",
  FLASH_SALE_NOT_ACTIVE = "FLASH_SALE_NOT_ACTIVE",
  STALE_RULES_VERSION = "STALE_RULES_VERSION",
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
  CART_ATTEMPT_CONFLICT = "CART_ATTEMPT_CONFLICT",
  CAPACITY_EXHAUSTED = "CAPACITY_EXHAUSTED",
  PURCHASE_LIMIT_EXCEEDED = "PURCHASE_LIMIT_EXCEEDED",
  HOLD_EXPIRED = "HOLD_EXPIRED",
  HOLD_NOT_EXPIRED = "HOLD_NOT_EXPIRED",
  ATTEMPT_NOT_FOUND = "ATTEMPT_NOT_FOUND",
  ATTEMPT_STATE_CONFLICT = "ATTEMPT_STATE_CONFLICT",
  ALLOCATION_POLICY_NOT_FOUND = "ALLOCATION_POLICY_NOT_FOUND",
  ALLOCATION_POLICY_STATE_CONFLICT = "ALLOCATION_POLICY_STATE_CONFLICT",
  ACTIVE_POLICY_CONFLICT = "ACTIVE_POLICY_CONFLICT",
  ALLOCATION_CAMPAIGN_FENCED = "ALLOCATION_CAMPAIGN_FENCED",
  ALLOCATION_CAMPAIGN_FENCE_CONFLICT = "ALLOCATION_CAMPAIGN_FENCE_CONFLICT",
  LOCK_TIMEOUT_RETRYABLE = "LOCK_TIMEOUT_RETRYABLE",
  ALLOCATION_INVARIANT_VIOLATION = "ALLOCATION_INVARIANT_VIOLATION",
  OUTBOX_EVENT_NOT_FOUND = "OUTBOX_EVENT_NOT_FOUND",
  OUTBOX_STATE_CONFLICT = "OUTBOX_STATE_CONFLICT",
  OUTBOX_INVARIANT_VIOLATION = "OUTBOX_INVARIANT_VIOLATION",
  MOVEMENT_LEDGER_INVARIANT_VIOLATION = "MOVEMENT_LEDGER_INVARIANT_VIOLATION",
  REPAIR_PLAN_INVARIANT_VIOLATION = "REPAIR_PLAN_INVARIANT_VIOLATION",
  REPAIR_APPROVAL_INVALID = "REPAIR_APPROVAL_INVALID",
  REPAIR_APPLY_CONFLICT = "REPAIR_APPLY_CONFLICT",
  REPAIR_APPLY_INVARIANT_VIOLATION = "REPAIR_APPLY_INVARIANT_VIOLATION",
}

export class AllocationCommandError extends Error {
  constructor(readonly code: AllocationCommandErrorCode, message: string) {
    super(message)
    this.name = "AllocationCommandError"
  }
}
