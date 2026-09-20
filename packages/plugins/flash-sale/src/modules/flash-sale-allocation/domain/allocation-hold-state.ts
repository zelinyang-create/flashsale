import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"
import { AllocationHoldState } from "../../../types"

export { AllocationHoldState }

const ALLOWED_ALLOCATION_HOLD_STATE_TRANSITIONS: Readonly<
  Record<AllocationHoldState, readonly AllocationHoldState[]>
> = {
  [AllocationHoldState.HELD]: [
    AllocationHoldState.CONSUMED,
    AllocationHoldState.RELEASED,
    AllocationHoldState.EXPIRED,
  ],
  [AllocationHoldState.CONSUMED]: [],
  [AllocationHoldState.RELEASED]: [],
  [AllocationHoldState.EXPIRED]: [],
}

export function canTransitionAllocationHoldState(
  from: AllocationHoldState,
  to: AllocationHoldState
): boolean {
  return (
    from === to || ALLOWED_ALLOCATION_HOLD_STATE_TRANSITIONS[from].includes(to)
  )
}

/**
 * A hold may be consumed or released exactly once. Its terminal state is
 * replayable but cannot be replaced by the opposite terminal state.
 */
export function assertAllocationHoldStateTransition(
  from: AllocationHoldState,
  to: AllocationHoldState
): void {
  if (!canTransitionAllocationHoldState(from, to)) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.INVALID_ALLOCATION_HOLD_STATE_TRANSITION,
      `Allocation hold cannot transition from ${from} to ${to}`
    )
  }
}
