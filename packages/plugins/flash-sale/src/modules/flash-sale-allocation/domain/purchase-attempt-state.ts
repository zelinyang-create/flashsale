import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"
import { PurchaseAttemptState } from "../../../types"

export { PurchaseAttemptState }

const ALLOWED_PURCHASE_ATTEMPT_STATE_TRANSITIONS: Readonly<
  Record<PurchaseAttemptState, readonly PurchaseAttemptState[]>
> = {
  [PurchaseAttemptState.PENDING]: [
    PurchaseAttemptState.QUOTA_HELD,
    PurchaseAttemptState.QUOTA_REJECTED,
  ],
  [PurchaseAttemptState.QUOTA_HELD]: [
    PurchaseAttemptState.QUOTA_COMMITTING,
    PurchaseAttemptState.QUOTA_CONSUMED,
    PurchaseAttemptState.QUOTA_RELEASED,
    PurchaseAttemptState.QUOTA_EXPIRED,
  ],
  [PurchaseAttemptState.QUOTA_COMMITTING]: [
    PurchaseAttemptState.QUOTA_CONSUMED,
    PurchaseAttemptState.QUOTA_RELEASED,
  ],
  [PurchaseAttemptState.QUOTA_REJECTED]: [],
  [PurchaseAttemptState.QUOTA_CONSUMED]: [],
  [PurchaseAttemptState.QUOTA_RELEASED]: [],
  [PurchaseAttemptState.QUOTA_EXPIRED]: [],
}

export function canTransitionPurchaseAttemptState(
  from: PurchaseAttemptState,
  to: PurchaseAttemptState
): boolean {
  return (
    from === to || ALLOWED_PURCHASE_ATTEMPT_STATE_TRANSITIONS[from].includes(to)
  )
}

/**
 * All terminal results are immutable. Replaying the same result is permitted;
 * trying to settle an attempt to an opposing terminal result is a conflict.
 */
export function assertPurchaseAttemptStateTransition(
  from: PurchaseAttemptState,
  to: PurchaseAttemptState
): void {
  if (!canTransitionPurchaseAttemptState(from, to)) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.INVALID_PURCHASE_ATTEMPT_STATE_TRANSITION,
      `Purchase attempt cannot transition from ${from} to ${to}`
    )
  }
}
