import {
  AllocationDomainError,
  AllocationDomainErrorCode,
  AllocationHoldState,
  AllocationPolicyState,
  assertAllocationHoldStateTransition,
  assertAllocationPolicyStateTransition,
  assertPurchaseAttemptStateTransition,
  canTransitionAllocationHoldState,
  canTransitionAllocationPolicyState,
  canTransitionPurchaseAttemptState,
  PurchaseAttemptState,
} from ".."

type StateTransition<S extends string> = readonly [S, S, boolean]

function expectDecisionTable<S extends string>(
  decisions: readonly StateTransition<S>[],
  canTransition: (from: S, to: S) => boolean,
  assertTransition: (from: S, to: S) => void,
  errorCode: AllocationDomainErrorCode
): void {
  for (const [from, to, allowed] of decisions) {
    expect(canTransition(from, to)).toBe(allowed)

    if (allowed) {
      expect(() => assertTransition(from, to)).not.toThrow()
      continue
    }

    expect(() => assertTransition(from, to)).toThrow(
      expect.objectContaining({ code: errorCode })
    )
  }
}

describe("allocation policy state machine", () => {
  it("enforces the complete decision table and stable error code", () => {
    expectDecisionTable(
      [
        [AllocationPolicyState.PREPARED, AllocationPolicyState.PREPARED, true],
        [AllocationPolicyState.PREPARED, AllocationPolicyState.OPEN, true],
        [AllocationPolicyState.PREPARED, AllocationPolicyState.CLOSED, true],
        [AllocationPolicyState.OPEN, AllocationPolicyState.PREPARED, false],
        [AllocationPolicyState.OPEN, AllocationPolicyState.OPEN, true],
        [AllocationPolicyState.OPEN, AllocationPolicyState.CLOSED, true],
        [AllocationPolicyState.CLOSED, AllocationPolicyState.PREPARED, false],
        [AllocationPolicyState.CLOSED, AllocationPolicyState.OPEN, false],
        [AllocationPolicyState.CLOSED, AllocationPolicyState.CLOSED, true],
      ],
      canTransitionAllocationPolicyState,
      assertAllocationPolicyStateTransition,
      AllocationDomainErrorCode.INVALID_ALLOCATION_POLICY_STATE_TRANSITION
    )
  })
})

describe("purchase attempt state machine", () => {
  it("allows only a held attempt to enter the immutable expired terminal", () => {
    for (const from of Object.values(PurchaseAttemptState)) {
      expect(
        canTransitionPurchaseAttemptState(
          from,
          PurchaseAttemptState.QUOTA_EXPIRED
        )
      ).toBe(
        from === PurchaseAttemptState.QUOTA_HELD ||
          from === PurchaseAttemptState.QUOTA_EXPIRED
      )
      if (from !== PurchaseAttemptState.QUOTA_EXPIRED) {
        expect(
          canTransitionPurchaseAttemptState(
            PurchaseAttemptState.QUOTA_EXPIRED,
            from
          )
        ).toBe(false)
      }
    }
  })

  it("enforces the complete decision table, including terminal conflicts", () => {
    expectDecisionTable(
      [
        [PurchaseAttemptState.PENDING, PurchaseAttemptState.PENDING, true],
        [PurchaseAttemptState.PENDING, PurchaseAttemptState.QUOTA_HELD, true],
        [
          PurchaseAttemptState.PENDING,
          PurchaseAttemptState.QUOTA_REJECTED,
          true,
        ],
        [
          PurchaseAttemptState.PENDING,
          PurchaseAttemptState.QUOTA_CONSUMED,
          false,
        ],
        [
          PurchaseAttemptState.PENDING,
          PurchaseAttemptState.QUOTA_RELEASED,
          false,
        ],
        [PurchaseAttemptState.QUOTA_HELD, PurchaseAttemptState.PENDING, false],
        [
          PurchaseAttemptState.QUOTA_HELD,
          PurchaseAttemptState.QUOTA_HELD,
          true,
        ],
        [
          PurchaseAttemptState.QUOTA_HELD,
          PurchaseAttemptState.QUOTA_REJECTED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_HELD,
          PurchaseAttemptState.QUOTA_CONSUMED,
          true,
        ],
        [
          PurchaseAttemptState.QUOTA_HELD,
          PurchaseAttemptState.QUOTA_RELEASED,
          true,
        ],
        [
          PurchaseAttemptState.QUOTA_REJECTED,
          PurchaseAttemptState.PENDING,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_REJECTED,
          PurchaseAttemptState.QUOTA_HELD,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_REJECTED,
          PurchaseAttemptState.QUOTA_REJECTED,
          true,
        ],
        [
          PurchaseAttemptState.QUOTA_REJECTED,
          PurchaseAttemptState.QUOTA_CONSUMED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_REJECTED,
          PurchaseAttemptState.QUOTA_RELEASED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_CONSUMED,
          PurchaseAttemptState.PENDING,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_CONSUMED,
          PurchaseAttemptState.QUOTA_HELD,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_CONSUMED,
          PurchaseAttemptState.QUOTA_REJECTED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_CONSUMED,
          PurchaseAttemptState.QUOTA_CONSUMED,
          true,
        ],
        [
          PurchaseAttemptState.QUOTA_CONSUMED,
          PurchaseAttemptState.QUOTA_RELEASED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_RELEASED,
          PurchaseAttemptState.PENDING,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_RELEASED,
          PurchaseAttemptState.QUOTA_HELD,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_RELEASED,
          PurchaseAttemptState.QUOTA_REJECTED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_RELEASED,
          PurchaseAttemptState.QUOTA_CONSUMED,
          false,
        ],
        [
          PurchaseAttemptState.QUOTA_RELEASED,
          PurchaseAttemptState.QUOTA_RELEASED,
          true,
        ],
      ],
      canTransitionPurchaseAttemptState,
      assertPurchaseAttemptStateTransition,
      AllocationDomainErrorCode.INVALID_PURCHASE_ATTEMPT_STATE_TRANSITION
    )
  })

  it("fences expiry while a held attempt is committing", () => {
    expect(
      canTransitionPurchaseAttemptState(
        PurchaseAttemptState.QUOTA_HELD,
        PurchaseAttemptState.QUOTA_COMMITTING
      )
    ).toBe(true)
    expect(
      canTransitionPurchaseAttemptState(
        PurchaseAttemptState.QUOTA_COMMITTING,
        PurchaseAttemptState.QUOTA_CONSUMED
      )
    ).toBe(true)
    expect(
      canTransitionPurchaseAttemptState(
        PurchaseAttemptState.QUOTA_COMMITTING,
        PurchaseAttemptState.QUOTA_RELEASED
      )
    ).toBe(true)
    expect(
      canTransitionPurchaseAttemptState(
        PurchaseAttemptState.QUOTA_COMMITTING,
        PurchaseAttemptState.QUOTA_EXPIRED
      )
    ).toBe(false)
    expect(
      canTransitionPurchaseAttemptState(
        PurchaseAttemptState.QUOTA_COMMITTING,
        PurchaseAttemptState.QUOTA_HELD
      )
    ).toBe(false)
  })
})

describe("allocation hold state machine", () => {
  it("allows only a held hold to enter the immutable expired terminal", () => {
    for (const from of Object.values(AllocationHoldState)) {
      expect(
        canTransitionAllocationHoldState(from, AllocationHoldState.EXPIRED)
      ).toBe(
        from === AllocationHoldState.HELD ||
          from === AllocationHoldState.EXPIRED
      )
      if (from !== AllocationHoldState.EXPIRED) {
        expect(
          canTransitionAllocationHoldState(AllocationHoldState.EXPIRED, from)
        ).toBe(false)
      }
    }
  })

  it("enforces the complete decision table and opposing terminal conflicts", () => {
    expectDecisionTable(
      [
        [AllocationHoldState.HELD, AllocationHoldState.HELD, true],
        [AllocationHoldState.HELD, AllocationHoldState.CONSUMED, true],
        [AllocationHoldState.HELD, AllocationHoldState.RELEASED, true],
        [AllocationHoldState.CONSUMED, AllocationHoldState.HELD, false],
        [AllocationHoldState.CONSUMED, AllocationHoldState.CONSUMED, true],
        [AllocationHoldState.CONSUMED, AllocationHoldState.RELEASED, false],
        [AllocationHoldState.RELEASED, AllocationHoldState.HELD, false],
        [AllocationHoldState.RELEASED, AllocationHoldState.CONSUMED, false],
        [AllocationHoldState.RELEASED, AllocationHoldState.RELEASED, true],
      ],
      canTransitionAllocationHoldState,
      assertAllocationHoldStateTransition,
      AllocationDomainErrorCode.INVALID_ALLOCATION_HOLD_STATE_TRANSITION
    )
  })

  it("uses an error type with an inspectable stable code", () => {
    try {
      assertAllocationHoldStateTransition(
        AllocationHoldState.CONSUMED,
        AllocationHoldState.RELEASED
      )
    } catch (error) {
      expect(error).toBeInstanceOf(AllocationDomainError)
      expect((error as AllocationDomainError).code).toBe(
        AllocationDomainErrorCode.INVALID_ALLOCATION_HOLD_STATE_TRANSITION
      )
    }
  })
})
