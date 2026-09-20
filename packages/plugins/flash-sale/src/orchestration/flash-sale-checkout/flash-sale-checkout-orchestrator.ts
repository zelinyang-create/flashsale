import { CheckoutExecutionState } from "../../types"
import {
  ALLOCATION_REQUEST_SCHEMA_VERSION,
  createCanonicalRequestFingerprint,
} from "../../modules/flash-sale-allocation"
import {
  CheckoutExecutionSnapshot,
  CheckoutTransitionResult,
  FlashSaleCheckoutOrchestrationError,
  FlashSaleCheckoutOrchestrationErrorCode,
  FlashSaleCheckoutOrchestratorDependencies,
  FlashSaleCheckoutOrchestratorOptions,
  FlashSaleCheckoutResult,
  NativeCommerceOutcome,
  ServerCanonicalFlashSaleCheckoutCommand,
} from "./contracts"
import {
  prepareCommerceLeaseSeconds,
  prepareOrchestratorSeconds,
  prepareServerCanonicalFlashSaleCheckoutCommand,
  prepareWorkerId,
} from "./validation"

const UNEXPECTED_NATIVE_ERROR = "NATIVE_COMMERCE_RESULT_UNKNOWN"

class PreCommerceAuthorizationFailure extends Error {
  constructor(readonly cause: unknown) {
    super("Checkout authorization failed before native Commerce was invoked")
    this.name = "PreCommerceAuthorizationFailure"
  }
}

/**
 * Private imperative orchestration kernel.
 *
 * The Workflow SDK is deliberately not used here: its graph constructor does
 * not provide a safe try/catch boundary that can hold an ILockingModule.execute
 * callback across reauthorization, native Commerce, and result persistence.
 * Production adapters may wrap this class, but must not split its cart-lock
 * callback into independently scheduled workflow steps.
 */
export class FlashSaleCheckoutOrchestrator {
  private readonly options: Omit<
    FlashSaleCheckoutOrchestratorOptions,
    "workerIdFactory"
  > &
    Pick<FlashSaleCheckoutOrchestratorOptions, "workerIdFactory">

  constructor(
    private readonly dependencies: FlashSaleCheckoutOrchestratorDependencies,
    options: FlashSaleCheckoutOrchestratorOptions
  ) {
    this.options = {
      workerIdFactory: options.workerIdFactory,
      lease_seconds: prepareCommerceLeaseSeconds(options.lease_seconds),
      lock_timeout_seconds: prepareOrchestratorSeconds(
        options.lock_timeout_seconds,
        "lock_timeout_seconds"
      ),
      lock_expire_seconds: prepareOrchestratorSeconds(
        options.lock_expire_seconds,
        "lock_expire_seconds"
      ),
      unknown_reconcile_after_seconds: prepareOrchestratorSeconds(
        options.unknown_reconcile_after_seconds,
        "unknown_reconcile_after_seconds"
      ),
    }
  }

  async run(
    rawCommand: ServerCanonicalFlashSaleCheckoutCommand
  ): Promise<FlashSaleCheckoutResult> {
    const command = prepareServerCanonicalFlashSaleCheckoutCommand(rawCommand)
    const requestHash = createCanonicalRequestFingerprint({
      schema_version: ALLOCATION_REQUEST_SCHEMA_VERSION,
      campaign_id: command.campaign_id,
      subject_id: command.subject_id,
      cart_id: command.cart_id,
      rules_version: command.rules_version,
      items: command.items.map((item) => ({
        campaign_item_id: item.campaign_item_id,
        quantity: item.quantity,
      })),
    })
    let replayed = false
    let snapshot = await this.dependencies.checkout.readExecutionReplay({
      command_id: command.command_id,
      cart_id: command.cart_id,
      subject_id: command.subject_id,
      request_hash: requestHash,
    })

    if (snapshot) {
      replayed = true
      const terminal = await this.settlePersisted(snapshot, true)
      if (terminal) {
        return terminal
      }
    } else {
      await this.dependencies.campaign.assertCheckoutEligible({
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        cart_id: command.cart_id,
        rules_version: command.rules_version,
        items: command.items,
      })
      const allocation = await this.dependencies.allocation.claimAndHoldQuota({
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        cart_id: command.cart_id,
        idempotency_key_hash: command.command_id,
        expected_rules_version: command.rules_version,
        items: command.items.map((item) => ({
          campaign_item_id: item.campaign_item_id,
          quantity: item.quantity,
        })),
      })
      if (allocation.attempt.request_hash !== requestHash) {
        throw new FlashSaleCheckoutOrchestrationError(
          FlashSaleCheckoutOrchestrationErrorCode.INVALID_PERSISTED_STATE,
          "Allocation returned a request fingerprint that differs from the trusted snapshot"
        )
      }
      if (allocation.status === "rejected") {
        return {
          status: "quota_rejected",
          attempt_id: allocation.attempt.id,
          error_code: allocation.error_code,
          replayed: allocation.replayed,
        }
      }
      const prepared = await this.dependencies.checkout.prepareExecution({
        attempt_id: allocation.attempt.id,
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        cart_id: command.cart_id,
        command_id: command.command_id,
        request_hash: requestHash,
        rules_version: command.rules_version,
        items: command.items,
      })
      snapshot = prepared
      replayed = prepared.replayed || allocation.replayed
      const raced = await this.settlePersisted(snapshot, replayed)
      if (raced) {
        return raced
      }
    }

    const execution = snapshot.execution
    const workerId = prepareWorkerId(this.options.workerIdFactory())
    await this.dependencies.allocation.beginQuotaSettlement({
      attempt_id: execution.attempt_id,
      settlement_id: execution.id,
    })
    let lease: CheckoutTransitionResult
    try {
      lease = await this.dependencies.checkout.claimCommerceLease({
        execution_id: execution.id,
        worker_id: workerId,
        lease_seconds: this.options.lease_seconds,
      })
    } catch (error) {
      if (this.errorCode(error) === "COMMERCE_LEASE_ACTIVE") {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "ACTIVE_LEASE",
          replayed,
        }
      }
      throw error
    }

    let lockEntered = false
    let commerceInvoked = false
    let lockedResult: CheckoutTransitionResult
    try {
      lockedResult = await this.dependencies.cartLock.execute(
        command.cart_id,
        async (scope) => {
          lockEntered = true
          const { signal } = scope
          if (signal?.aborted) {
            throw new PreCommerceAuthorizationFailure(
              new FlashSaleCheckoutOrchestrationError(
                FlashSaleCheckoutOrchestrationErrorCode.LOCK_LOST_BEFORE_COMMERCE,
                "Cart lock was lost before checkout reauthorization"
              )
            )
          }

          let authorized: CheckoutTransitionResult
          try {
            authorized =
              await this.dependencies.checkout.authorizeCartCompletion({
                execution_id: execution.id,
                worker_id: workerId,
                lease_epoch: lease.execution.lease_epoch,
              })
            await this.dependencies.allocation.authorizeQuotaSettlement({
              attempt_id: execution.attempt_id,
              settlement_id: execution.id,
            })
          } catch (error) {
            const latest = await this.dependencies.checkout.readExecutionReplay(
              {
                command_id: command.command_id,
                cart_id: command.cart_id,
                subject_id: command.subject_id,
                request_hash: requestHash,
              }
            )
            if (
              latest &&
              latest.execution.id === execution.id &&
              latest.execution.state !== CheckoutExecutionState.PREPARED &&
              latest.execution.state !== CheckoutExecutionState.COMMERCE_PENDING
            ) {
              return { ...latest, replayed: true }
            }
            throw new PreCommerceAuthorizationFailure(error)
          }

          if (signal?.aborted) {
            throw new PreCommerceAuthorizationFailure(
              new FlashSaleCheckoutOrchestrationError(
                FlashSaleCheckoutOrchestrationErrorCode.LOCK_LOST_BEFORE_COMMERCE,
                "Cart lock was lost after authorization and before Commerce"
              )
            )
          }
          commerceInvoked = true
          let outcome: NativeCommerceOutcome
          try {
            outcome = await this.dependencies.commerce.complete({
              cart_id: command.cart_id,
              commerce_transaction_id: execution.commerce_transaction_id,
              parent_step_idempotency_key: scope.parent_step_idempotency_key,
              signal,
            })
          } catch {
            outcome = {
              kind: "unknown",
              error_code: UNEXPECTED_NATIVE_ERROR,
            }
          }

          try {
            return await this.recordCommerceOutcome(
              authorized,
              workerId,
              outcome
            )
          } catch (error) {
            throw new FlashSaleCheckoutOrchestrationError(
              FlashSaleCheckoutOrchestrationErrorCode.COMMERCE_RESULT_PERSISTENCE_FAILED,
              "Native Commerce was invoked but its result could not be persisted",
              error
            )
          }
        },
        {
          timeout: this.options.lock_timeout_seconds,
          expire: this.options.lock_expire_seconds,
        }
      )
    } catch (error) {
      if (lockEntered && !commerceInvoked) {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "LEASE_LOST",
          replayed,
        }
      }
      if (!lockEntered) {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "LOCK_WAIT",
          replayed,
        }
      }
      if (
        error instanceof FlashSaleCheckoutOrchestrationError &&
        error.code ===
          FlashSaleCheckoutOrchestrationErrorCode.COMMERCE_RESULT_PERSISTENCE_FAILED
      ) {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "RESULT_PERSISTENCE",
          replayed,
        }
      }
      if (commerceInvoked) {
        const latest = await this.dependencies.checkout.readExecutionReplay({
          command_id: command.command_id,
          cart_id: command.cart_id,
          subject_id: command.subject_id,
          request_hash: requestHash,
        })
        if (latest && latest.execution.id === execution.id) {
          const terminal = await this.settlePersisted(latest, true)
          if (terminal) {
            return terminal
          }
        }
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "RESULT_PERSISTENCE",
          replayed,
        }
      }
      throw error
    }

    const terminal = await this.settlePersisted(
      lockedResult,
      replayed || lockedResult.replayed
    )
    if (!terminal) {
      throw new FlashSaleCheckoutOrchestrationError(
        FlashSaleCheckoutOrchestrationErrorCode.INVALID_PERSISTED_STATE,
        `Commerce returned without a replayable result state: ${lockedResult.execution.state}`
      )
    }
    return terminal
  }

  private async recordCommerceOutcome(
    authorized: CheckoutTransitionResult,
    workerId: string,
    outcome: NativeCommerceOutcome
  ): Promise<CheckoutTransitionResult> {
    const fence = {
      execution_id: authorized.execution.id,
      expected_version: authorized.execution.version,
      worker_id: workerId,
      lease_epoch: authorized.execution.lease_epoch,
      commerce_transaction_id: authorized.execution.commerce_transaction_id,
    }
    if (outcome.kind === "succeeded") {
      return await this.dependencies.checkout.recordCommerceSucceeded({
        ...fence,
        order_id: outcome.order_id,
      })
    }
    if (outcome.kind === "definitive_failure") {
      return await this.dependencies.checkout.recordCommerceDefinitiveFailure({
        ...fence,
        error_code: outcome.error_code,
      })
    }
    return await this.dependencies.checkout.recordCommerceUnknown({
      ...fence,
      error_code: outcome.error_code,
      reconcile_after_seconds: this.options.unknown_reconcile_after_seconds,
    })
  }

  private async settlePersisted(
    snapshot: CheckoutExecutionSnapshot,
    replayed: boolean
  ): Promise<FlashSaleCheckoutResult | null> {
    const execution = snapshot.execution
    if (execution.state === CheckoutExecutionState.COMMERCE_SUCCEEDED) {
      if (!execution.order_id) {
        return this.invalidPersistedState(
          "COMMERCE_SUCCEEDED execution has no order binding"
        )
      }
      let completed: CheckoutTransitionResult
      try {
        await this.dependencies.allocation.consumeQuotaSettlement({
          attempt_id: execution.attempt_id,
          settlement_id: execution.id,
        })
        completed = await this.dependencies.checkout.completeExecution({
          execution_id: execution.id,
          expected_version: execution.version,
          commerce_transaction_id: execution.commerce_transaction_id,
          order_id: execution.order_id,
        })
      } catch {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "SETTLEMENT_RETRY",
          replayed,
        }
      }
      return {
        status: "completed",
        execution_id: execution.id,
        order_id: execution.order_id,
        replayed: replayed || completed.replayed,
      }
    }
    if (execution.state === CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED) {
      if (!execution.last_error_code) {
        return this.invalidPersistedState(
          "Definitive Commerce failure has no error code"
        )
      }
      let canceled: CheckoutTransitionResult
      try {
        await this.dependencies.allocation.releaseQuotaSettlement({
          attempt_id: execution.attempt_id,
          settlement_id: execution.id,
        })
        canceled = await this.dependencies.checkout.cancelExecution({
          execution_id: execution.id,
          expected_version: execution.version,
          commerce_transaction_id: execution.commerce_transaction_id,
        })
      } catch {
        return {
          status: "in_progress",
          execution_id: execution.id,
          reason: "SETTLEMENT_RETRY",
          replayed,
        }
      }
      return {
        status: "canceled",
        execution_id: execution.id,
        error_code: execution.last_error_code,
        replayed: replayed || canceled.replayed,
      }
    }
    if (execution.state === CheckoutExecutionState.COMMERCE_UNKNOWN) {
      if (!execution.last_error_code) {
        return this.invalidPersistedState("Unknown Commerce result has no code")
      }
      return {
        status: "unknown",
        execution_id: execution.id,
        error_code: execution.last_error_code,
        replayed,
      }
    }
    if (execution.state === CheckoutExecutionState.COMPLETED) {
      if (!execution.order_id) {
        return this.invalidPersistedState(
          "Completed checkout execution has no order binding"
        )
      }
      return {
        status: "completed",
        execution_id: execution.id,
        order_id: execution.order_id,
        replayed,
      }
    }
    if (execution.state === CheckoutExecutionState.CANCELED) {
      if (!execution.last_error_code) {
        return this.invalidPersistedState(
          "Canceled checkout execution has no error code"
        )
      }
      return {
        status: "canceled",
        execution_id: execution.id,
        error_code: execution.last_error_code,
        replayed,
      }
    }
    if (execution.state === CheckoutExecutionState.MANUAL_REVIEW) {
      return {
        status: "manual_review",
        execution_id: execution.id,
        error_code: execution.last_error_code,
        replayed,
      }
    }
    if (
      execution.state === CheckoutExecutionState.PREPARED ||
      execution.state === CheckoutExecutionState.COMMERCE_PENDING
    ) {
      return null
    }
    return this.invalidPersistedState(
      `Unsupported checkout execution state: ${execution.state}`
    )
  }

  private invalidPersistedState(message: string): never {
    throw new FlashSaleCheckoutOrchestrationError(
      FlashSaleCheckoutOrchestrationErrorCode.INVALID_PERSISTED_STATE,
      message
    )
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
      return typeof error.code === "string" ? error.code : undefined
    }
    return undefined
  }
}
