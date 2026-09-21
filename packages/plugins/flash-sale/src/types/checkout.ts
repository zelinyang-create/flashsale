export enum CheckoutExecutionState {
  PREPARED = "prepared",
  COMMERCE_PENDING = "commerce_pending",
  COMMERCE_SUCCEEDED = "commerce_succeeded",
  COMMERCE_DEFINITIVE_FAILED = "commerce_definitive_failed",
  COMMERCE_UNKNOWN = "commerce_unknown",
  COMPLETED = "completed",
  CANCELED = "canceled",
  MANUAL_REVIEW = "manual_review",
}

export enum CheckoutOutboxStatus {
  PENDING = "pending",
  PUBLISHING = "publishing",
  PUBLISHED = "published",
  DEAD_LETTER = "dead_letter",
}

export type CheckoutExecutionDTO = {
  id: string
  attempt_id: string
  campaign_id: string
  subject_id: string
  cart_id: string
  command_id: string
  request_hash: string
  commerce_transaction_id: string
  commerce_result_hash: string | null
  terminal_command_hash: string | null
  rules_version: number
  state: CheckoutExecutionState
  order_id: string | null
  version: number
  business_version: number
  outbox_stream_started: boolean
  business_changed_at: Date | null
  attempt_count: number
  lease_owner: string | null
  lease_until: Date | null
  lease_epoch: number
  completion_authorized_epoch: number | null
  completion_authorized_at: Date | null
  next_reconcile_at: Date | null
  last_error_code: string | null
  commerce_started_at: Date | null
  commerce_resolved_at: Date | null
  terminal_at: Date | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type CheckoutOutboxEventDTO = {
  id: string
  event_name: string
  schema_version: number
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number
  event_hash: string
  payload: Record<string, unknown>
  status: CheckoutOutboxStatus
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

export type CheckoutOutboxControlDTO = {
  id: string
  required_after: Date
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type CheckoutExecutionItemDTO = {
  id: string
  execution_id: string
  campaign_item_id: string
  variant_id: string
  quantity: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}
