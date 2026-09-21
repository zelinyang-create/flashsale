export enum AllocationPolicyState {
  PREPARED = "prepared",
  OPEN = "open",
  CLOSED = "closed",
}

export enum CapacityState {
  PREPARED = "prepared",
  OPEN = "open",
  CLOSED = "closed",
}

export enum PurchaseAttemptState {
  PENDING = "pending",
  QUOTA_HELD = "quota_held",
  QUOTA_COMMITTING = "quota_committing",
  QUOTA_REJECTED = "quota_rejected",
  QUOTA_CONSUMED = "quota_consumed",
  QUOTA_RELEASED = "quota_released",
  QUOTA_EXPIRED = "quota_expired",
}

export enum AllocationHoldState {
  HELD = "held",
  CONSUMED = "consumed",
  RELEASED = "released",
  EXPIRED = "expired",
}

export enum AllocationOutboxStatus {
  PENDING = "pending",
  PUBLISHING = "publishing",
  PUBLISHED = "published",
  DEAD_LETTER = "dead_letter",
}

export enum CapacityMovementKind {
  HOLD = "hold",
  CONSUME = "consume",
  RELEASE = "release",
  EXPIRE = "expire",
}

export enum CapacityMovementBucket {
  AVAILABLE = "available",
  HELD = "held",
  CONSUMED = "consumed",
}

export enum CapacityMovementCheckpointKind {
  CUTOVER = "cutover",
  PROVISION = "provision",
}

export type CapacityMovementDTO = {
  id: string
  capacity_id: string
  attempt_id: string
  campaign_id: string
  subject_id: string
  campaign_item_id: string
  transition_version: number
  kind: CapacityMovementKind
  from_bucket: CapacityMovementBucket
  to_bucket: CapacityMovementBucket
  quantity: number
  fence_token: string
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type CapacityMovementCheckpointDTO = {
  id: string
  activation_id: string
  capacity_id: string
  campaign_item_id: string
  checkpoint_kind: CapacityMovementCheckpointKind
  shard_no: number
  opening_granted_quantity: number
  opening_available_quantity: number
  opening_held_quantity: number
  opening_consumed_quantity: number
  capacity_version: number
  activated_at: Date
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type CapacityMovementControlDTO = {
  id: string
  activation_id: string
  required_after: Date
  schema_version: number
  checkpoint_digest: string
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type AllocationOutboxEventDTO = {
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
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type AllocationOutboxControlDTO = {
  id: string
  required_after: Date
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export enum AllocationFenceDisposition {
  CANCELLED = "cancelled",
  ENDED = "ended",
}

export type AllocationCampaignFenceDTO = {
  id: string
  campaign_id: string
  disposition: AllocationFenceDisposition
  campaign_version: number
  rules_version: number
  version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type AllocationPolicyDTO = {
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
}

export type CapacityDTO = {
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
}

export type PurchaseAttemptDTO = {
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
}

export type AllocationHoldDTO = {
  id: string
  attempt_id: string
  capacity_id: string
  campaign_item_id: string
  quantity: number
  state: AllocationHoldState
  expires_at: Date
  version: number
  resolved_at: Date | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type SubjectAllocationDTO = {
  id: string
  campaign_id: string
  subject_id: string
  limit_quantity: number
  held_quantity: number
  consumed_quantity: number
  rules_version: number
  version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}
