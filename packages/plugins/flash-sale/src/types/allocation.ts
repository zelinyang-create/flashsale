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
