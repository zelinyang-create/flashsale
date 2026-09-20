import { CheckoutExecutionDTO, CheckoutExecutionItemDTO } from "../../types"

export type FlashSaleCheckoutItem = Readonly<{
  campaign_item_id: string
  variant_id: string
  quantity: number
}>

/**
 * Server-canonical command assembled after the trusted route has resolved the
 * customer, campaign, cart, and item mapping. A future HTTP route must never
 * spread or forward an untrusted request body into this command.
 */
export type ServerCanonicalFlashSaleCheckoutCommand = Readonly<{
  campaign_id: string
  subject_id: string
  cart_id: string
  command_id: string
  rules_version: number
  items: readonly FlashSaleCheckoutItem[]
}>

export type CheckoutExecutionSnapshot = Readonly<{
  execution: CheckoutExecutionDTO
  items: readonly CheckoutExecutionItemDTO[]
}>

export type CheckoutTransitionResult = CheckoutExecutionSnapshot &
  Readonly<{ replayed: boolean }>

export type CampaignCheckoutPort = Readonly<{
  assertCheckoutEligible(
    command: Readonly<{
      campaign_id: string
      subject_id: string
      cart_id: string
      rules_version: number
      items: readonly FlashSaleCheckoutItem[]
    }>
  ): Promise<void>
}>

export type AllocationAttemptSnapshot = Readonly<{
  id: string
  request_hash: string
  state: string
}>

export type AllocationCheckoutPort = Readonly<{
  claimAndHoldQuota(command: {
    campaign_id: string
    subject_id: string
    cart_id: string
    idempotency_key_hash: string
    expected_rules_version: number
    items: readonly Readonly<{
      campaign_item_id: string
      quantity: number
    }>[]
  }): Promise<
    | Readonly<{
        status: "held"
        attempt: AllocationAttemptSnapshot
        replayed: boolean
      }>
    | Readonly<{
        status: "rejected"
        attempt: AllocationAttemptSnapshot
        error_code: string
        replayed: boolean
      }>
  >
  beginQuotaSettlement(command: {
    attempt_id: string
    settlement_id: string
  }): Promise<unknown>
  authorizeQuotaSettlement(command: {
    attempt_id: string
    settlement_id: string
  }): Promise<unknown>
  consumeQuotaSettlement(command: {
    attempt_id: string
    settlement_id: string
  }): Promise<unknown>
  releaseQuotaSettlement(command: {
    attempt_id: string
    settlement_id: string
  }): Promise<unknown>
}>

export type CheckoutExecutionPort = Readonly<{
  readExecutionReplay(command: {
    command_id: string
    cart_id: string
    subject_id: string
    request_hash: string
  }): Promise<CheckoutExecutionSnapshot | null>
  prepareExecution(command: {
    attempt_id: string
    campaign_id: string
    subject_id: string
    cart_id: string
    command_id: string
    request_hash: string
    rules_version: number
    items: readonly FlashSaleCheckoutItem[]
  }): Promise<CheckoutTransitionResult>
  claimCommerceLease(command: {
    execution_id: string
    worker_id: string
    lease_seconds: number
  }): Promise<CheckoutTransitionResult>
  authorizeCartCompletion(command: {
    execution_id: string
    worker_id: string
    lease_epoch: number
  }): Promise<CheckoutTransitionResult>
  recordCommerceSucceeded(command: {
    execution_id: string
    expected_version: number
    worker_id: string
    lease_epoch: number
    commerce_transaction_id: string
    order_id: string
  }): Promise<CheckoutTransitionResult>
  recordCommerceDefinitiveFailure(command: {
    execution_id: string
    expected_version: number
    worker_id: string
    lease_epoch: number
    commerce_transaction_id: string
    error_code: string
  }): Promise<CheckoutTransitionResult>
  recordCommerceUnknown(command: {
    execution_id: string
    expected_version: number
    worker_id: string
    lease_epoch: number
    commerce_transaction_id: string
    error_code: string
    reconcile_after_seconds: number
  }): Promise<CheckoutTransitionResult>
  completeExecution(command: {
    execution_id: string
    expected_version: number
    commerce_transaction_id: string
    order_id: string
  }): Promise<CheckoutTransitionResult>
  cancelExecution(command: {
    execution_id: string
    expected_version: number
    commerce_transaction_id: string
  }): Promise<CheckoutTransitionResult>
}>

export type CartLockScope = Readonly<{
  signal?: AbortSignal
  parent_step_idempotency_key: string
}>

export type CartLockPort = Readonly<{
  execute<T>(
    key: string,
    job: (scope: CartLockScope) => Promise<T>,
    options: Readonly<{ timeout: number; expire: number }>
  ): Promise<T>
}>

export type NativeCommerceOutcome =
  | Readonly<{ kind: "succeeded"; order_id: string }>
  | Readonly<{ kind: "definitive_failure"; error_code: string }>
  | Readonly<{ kind: "unknown"; error_code: string }>

export type NativeCommercePort = Readonly<{
  complete(command: {
    cart_id: string
    commerce_transaction_id: string
    parent_step_idempotency_key: string
    signal?: AbortSignal
  }): Promise<NativeCommerceOutcome>
}>

export type FlashSaleCheckoutResult =
  | Readonly<{
      status: "completed"
      execution_id: string
      order_id: string
      replayed: boolean
    }>
  | Readonly<{
      status: "canceled"
      execution_id: string
      error_code: string
      replayed: boolean
    }>
  | Readonly<{
      status: "unknown"
      execution_id: string
      error_code: string
      replayed: boolean
    }>
  | Readonly<{
      status: "manual_review"
      execution_id: string
      error_code: string | null
      replayed: boolean
    }>
  | Readonly<{
      status: "quota_rejected"
      attempt_id: string
      error_code: string
      replayed: boolean
    }>
  | Readonly<{
      status: "in_progress"
      execution_id: string
      reason:
        | "ACTIVE_LEASE"
        | "LOCK_WAIT"
        | "LEASE_LOST"
        | "RESULT_PERSISTENCE"
        | "SETTLEMENT_RETRY"
      replayed: boolean
    }>

export type FlashSaleCheckoutOrchestratorDependencies = Readonly<{
  campaign: CampaignCheckoutPort
  allocation: AllocationCheckoutPort
  checkout: CheckoutExecutionPort
  cartLock: CartLockPort
  commerce: NativeCommercePort
}>

export type FlashSaleCheckoutOrchestratorOptions = Readonly<{
  workerIdFactory: () => string
  lease_seconds: number
  lock_timeout_seconds: number
  lock_expire_seconds: number
  unknown_reconcile_after_seconds: number
}>

export enum FlashSaleCheckoutOrchestrationErrorCode {
  INVALID_COMMAND = "INVALID_COMMAND",
  LOCK_LOST_BEFORE_COMMERCE = "LOCK_LOST_BEFORE_COMMERCE",
  COMMERCE_RESULT_PERSISTENCE_FAILED = "COMMERCE_RESULT_PERSISTENCE_FAILED",
  INVALID_PERSISTED_STATE = "INVALID_PERSISTED_STATE",
}

export class FlashSaleCheckoutOrchestrationError extends Error {
  constructor(
    readonly code: FlashSaleCheckoutOrchestrationErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "FlashSaleCheckoutOrchestrationError"
  }
}
