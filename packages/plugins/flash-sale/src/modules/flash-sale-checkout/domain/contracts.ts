import { CheckoutExecutionDTO, CheckoutExecutionItemDTO } from "../../../types"

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
