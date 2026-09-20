import { AllocationItemInput, NormalizedAllocationItem } from "../domain"
import {
  AllocationFenceDisposition,
  AllocationPolicyState,
  CapacityState,
  PurchaseAttemptState,
} from "../../../types"

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

export interface AllocationStore
  extends AllocationQuotaStore,
    AllocationControlStore {}

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
}

export class AllocationCommandError extends Error {
  constructor(readonly code: AllocationCommandErrorCode, message: string) {
    super(message)
    this.name = "AllocationCommandError"
  }
}
