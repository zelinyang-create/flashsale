import {
  CheckoutExecutionDTO,
  CheckoutExecutionItemDTO,
  CheckoutOutboxStatus,
} from "../../../types"

export type CheckoutSnapshotItemInput = Readonly<{
  campaign_item_id: string
  variant_id: string
  quantity: number
}>

export type CartSnapshotItemInput = Readonly<{
  variant_id: string
  quantity: number
}>

export type PrepareExecutionCommand = Readonly<{
  attempt_id: string
  campaign_id: string
  subject_id: string
  cart_id: string
  command_id: string
  request_hash: string
  rules_version: number
  items: readonly CheckoutSnapshotItemInput[]
}>

export type ClaimCommerceLeaseCommand = Readonly<{
  execution_id: string
  worker_id: string
  lease_seconds: number
}>

export type AuthorizeCartCompletionCommand = Readonly<{
  execution_id: string
  worker_id: string
  lease_epoch: number
}>

export type ReadCartCompletionAuthorizationCommand = Readonly<{
  cart_id: string
  subject_id: string
  campaign_id: string
  commerce_transaction_id: string
  rules_version: number
  items: readonly CartSnapshotItemInput[]
}>

export type FindExecutionForCartCommand = Readonly<{
  cart_id: string
}>

export type CommerceResultFenceCommand = Readonly<{
  execution_id: string
  expected_version: number
  worker_id: string
  lease_epoch: number
  commerce_transaction_id: string
}>

export type RecordCommerceSucceededCommand = CommerceResultFenceCommand &
  Readonly<{
    order_id: string
  }>

export type RecordCommerceDefinitiveFailureCommand =
  CommerceResultFenceCommand &
    Readonly<{
      error_code: string
    }>

export type RecordCommerceUnknownCommand = CommerceResultFenceCommand &
  Readonly<{
    error_code: string
    reconcile_after_seconds: number
  }>

export type CompleteExecutionCommand = Readonly<{
  execution_id: string
  expected_version: number
  commerce_transaction_id: string
  order_id: string
}>

export type CancelExecutionCommand = Readonly<{
  execution_id: string
  expected_version: number
  commerce_transaction_id: string
}>

export type ReadExecutionReplayCommand = Readonly<{
  command_id: string
  cart_id: string
  subject_id: string
  request_hash: string
}>

export type CheckoutExecutionSnapshot = Readonly<{
  execution: CheckoutExecutionDTO
  items: readonly CheckoutExecutionItemDTO[]
}>

export type PrepareExecutionResult = CheckoutExecutionSnapshot &
  Readonly<{ replayed: boolean }>

export type ClaimCommerceLeaseResult = CheckoutExecutionSnapshot &
  Readonly<{ replayed: boolean }>

export type AuthorizeCartCompletionResult = CheckoutExecutionSnapshot &
  Readonly<{ replayed: boolean }>

export type TransitionExecutionResult = CheckoutExecutionSnapshot &
  Readonly<{ replayed: boolean }>

export type ClaimedCheckoutOutboxEvent = Readonly<{
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
}>

export type ActivateCheckoutOutboxCommand = Readonly<Record<string, never>>
export type ActivateCheckoutOutboxResult = Readonly<{
  required_after: Date
  replayed: boolean
}>
export type ClaimCheckoutOutboxEventsCommand = Readonly<{
  worker_id: string
  limit: number
  lease_seconds: number
  max_attempts: number
}>
export type ClaimCheckoutOutboxEventsResult = Readonly<{
  events: readonly ClaimedCheckoutOutboxEvent[]
}>
export type MarkCheckoutOutboxPublishedCommand = Readonly<{
  event_id: string
  worker_id: string
  lease_epoch: number
}>
export type FailCheckoutOutboxEventCommand = Readonly<{
  event_id: string
  worker_id: string
  lease_epoch: number
  retry_after_seconds: number
  error_code: string
  permanent: boolean
}>
export type RedriveCheckoutOutboxEventCommand = Readonly<{
  event_id: string
  event_hash: string
}>
export type CheckoutOutboxMutationResult = Readonly<{
  disposition: "published" | "retried" | "dead_lettered" | "redriven" | "fenced"
  event: ClaimedCheckoutOutboxEvent | null
}>

export interface CheckoutOutboxStore {
  activateOutboxRequired(
    input: ActivateCheckoutOutboxCommand
  ): Promise<ActivateCheckoutOutboxResult>
  claimOutboxEvents(
    input: ClaimCheckoutOutboxEventsCommand
  ): Promise<ClaimCheckoutOutboxEventsResult>
  markOutboxPublished(
    input: MarkCheckoutOutboxPublishedCommand
  ): Promise<CheckoutOutboxMutationResult>
  failOutboxEvent(
    input: FailCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult>
  redriveOutboxEvent(
    input: RedriveCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult>
}

export type ReconcileCheckoutOutboxCommand = Readonly<{
  execution_id?: string
  sample_limit?: number
}>
export type CheckoutOutboxIssueCode =
  | "OUTBOX_STREAM_MISSING"
  | "OUTBOX_CURRENT_EVENT_MISSING"
  | "OUTBOX_EVENT_DRIFT"
  | "OUTBOX_VERSION_GAP"
  | "OUTBOX_EVENT_AHEAD"
  | "OUTBOX_TRANSITION_DRIFT"
export type ReconcileCheckoutOutboxResult = Readonly<{
  snapshot_at: Date
  healthy: boolean
  issue_count: number
  counts: Readonly<Partial<Record<CheckoutOutboxIssueCode, number>>>
  samples: readonly Readonly<{
    code: CheckoutOutboxIssueCode
    execution_id: string
  }>[]
}>
export interface CheckoutOutboxReconciliationStore {
  reconcileCheckoutOutbox(input: {
    execution_id?: string
    sample_limit: number
  }): Promise<ReconcileCheckoutOutboxResult>
}

export enum CheckoutCommandErrorCode {
  INVALID_COMMAND = "INVALID_COMMAND",
  INVALID_REQUEST_HASH = "INVALID_REQUEST_HASH",
  EXECUTION_NOT_FOUND = "EXECUTION_NOT_FOUND",
  EXECUTION_IDENTITY_CONFLICT = "EXECUTION_IDENTITY_CONFLICT",
  EXECUTION_SNAPSHOT_CONFLICT = "EXECUTION_SNAPSHOT_CONFLICT",
  EXECUTION_STATE_CONFLICT = "EXECUTION_STATE_CONFLICT",
  COMMERCE_LEASE_ACTIVE = "COMMERCE_LEASE_ACTIVE",
  COMMERCE_LEASE_REQUIRED = "COMMERCE_LEASE_REQUIRED",
  COMMERCE_LEASE_FENCE_REJECTED = "COMMERCE_LEASE_FENCE_REJECTED",
  COMMERCE_RESULT_FENCE_REJECTED = "COMMERCE_RESULT_FENCE_REJECTED",
  COMMERCE_TRANSACTION_CONFLICT = "COMMERCE_TRANSACTION_CONFLICT",
  ORDER_BINDING_CONFLICT = "ORDER_BINDING_CONFLICT",
  OUTBOX_EVENT_NOT_FOUND = "OUTBOX_EVENT_NOT_FOUND",
  OUTBOX_STATE_CONFLICT = "OUTBOX_STATE_CONFLICT",
  OUTBOX_INVARIANT_VIOLATION = "OUTBOX_INVARIANT_VIOLATION",
}

export class CheckoutCommandError extends Error {
  constructor(readonly code: CheckoutCommandErrorCode, message: string) {
    super(message)
    this.name = "CheckoutCommandError"
  }
}

export interface CheckoutExecutionStore {
  prepareExecution(
    command: PrepareExecutionCommand
  ): Promise<PrepareExecutionResult>
  claimCommerceLease(
    command: ClaimCommerceLeaseCommand
  ): Promise<ClaimCommerceLeaseResult>
  authorizeCartCompletion(
    command: AuthorizeCartCompletionCommand
  ): Promise<AuthorizeCartCompletionResult>
  readCartCompletionAuthorization(
    command: ReadCartCompletionAuthorizationCommand
  ): Promise<AuthorizeCartCompletionResult>
  findExecutionForCart(
    command: FindExecutionForCartCommand
  ): Promise<CheckoutExecutionSnapshot | null>
  recordCommerceSucceeded(
    command: RecordCommerceSucceededCommand
  ): Promise<TransitionExecutionResult>
  recordCommerceDefinitiveFailure(
    command: RecordCommerceDefinitiveFailureCommand
  ): Promise<TransitionExecutionResult>
  recordCommerceUnknown(
    command: RecordCommerceUnknownCommand
  ): Promise<TransitionExecutionResult>
  completeExecution(
    command: CompleteExecutionCommand
  ): Promise<TransitionExecutionResult>
  cancelExecution(
    command: CancelExecutionCommand
  ): Promise<TransitionExecutionResult>
  readExecutionReplay(
    command: ReadExecutionReplayCommand
  ): Promise<CheckoutExecutionSnapshot | null>
}
