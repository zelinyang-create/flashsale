import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"
import { AllocationPolicyState } from "../../../types"

export { AllocationPolicyState }

const ALLOWED_ALLOCATION_POLICY_STATE_TRANSITIONS: Readonly<
  Record<AllocationPolicyState, readonly AllocationPolicyState[]>
> = {
  [AllocationPolicyState.PREPARED]: [
    AllocationPolicyState.OPEN,
    AllocationPolicyState.CLOSED,
  ],
  [AllocationPolicyState.OPEN]: [AllocationPolicyState.CLOSED],
  [AllocationPolicyState.CLOSED]: [],
}

export function canTransitionAllocationPolicyState(
  from: AllocationPolicyState,
  to: AllocationPolicyState
): boolean {
  return (
    from === to ||
    ALLOWED_ALLOCATION_POLICY_STATE_TRANSITIONS[from].includes(to)
  )
}

/**
 * State assignment is retry-safe: assigning the present state is a no-op.
 * A closed policy is irreversible, so re-opening it is rejected.
 */
export function assertAllocationPolicyStateTransition(
  from: AllocationPolicyState,
  to: AllocationPolicyState
): void {
  if (!canTransitionAllocationPolicyState(from, to)) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.INVALID_ALLOCATION_POLICY_STATE_TRANSITION,
      `Allocation policy cannot transition from ${from} to ${to}`
    )
  }
}
