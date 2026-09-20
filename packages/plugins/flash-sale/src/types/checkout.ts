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
