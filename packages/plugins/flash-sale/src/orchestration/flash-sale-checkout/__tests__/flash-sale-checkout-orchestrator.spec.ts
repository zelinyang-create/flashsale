import {
  ALLOCATION_REQUEST_SCHEMA_VERSION,
  createCanonicalRequestFingerprint,
} from "../../../modules/flash-sale-allocation"
import { CheckoutExecutionDTO, CheckoutExecutionState } from "../../../types"
import {
  FlashSaleCheckoutOrchestrationErrorCode,
  FlashSaleCheckoutOrchestratorDependencies,
  NativeCommerceOutcome,
  ServerCanonicalFlashSaleCheckoutCommand,
} from "../contracts"
import { FlashSaleCheckoutOrchestrator } from "../flash-sale-checkout-orchestrator"

const COMMAND: ServerCanonicalFlashSaleCheckoutCommand = {
  campaign_id: "campaign-1",
  subject_id: "customer-1",
  cart_id: "cart-1",
  command_id: "a".repeat(64),
  rules_version: 7,
  items: [
    {
      campaign_item_id: "campaign-item-1",
      variant_id: "variant-1",
      quantity: 2,
    },
  ],
}

const REQUEST_HASH = createCanonicalRequestFingerprint({
  schema_version: ALLOCATION_REQUEST_SCHEMA_VERSION,
  campaign_id: COMMAND.campaign_id,
  subject_id: COMMAND.subject_id,
  cart_id: COMMAND.cart_id,
  rules_version: COMMAND.rules_version,
  items: COMMAND.items.map(({ campaign_item_id, quantity }) => ({
    campaign_item_id,
    quantity,
  })),
})

const NOW = new Date("2026-09-20T12:00:00.000Z")

function execution(
  state: CheckoutExecutionState,
  overrides: Partial<CheckoutExecutionDTO> = {}
): CheckoutExecutionDTO {
  return {
    id: "execution-1",
    attempt_id: "attempt-1",
    campaign_id: COMMAND.campaign_id,
    subject_id: COMMAND.subject_id,
    cart_id: COMMAND.cart_id,
    command_id: COMMAND.command_id,
    request_hash: REQUEST_HASH,
    commerce_transaction_id: "commerce-transaction-1",
    commerce_result_hash: null,
    terminal_command_hash: null,
    rules_version: COMMAND.rules_version,
    state,
    order_id: null,
    version: 1,
    attempt_count: 0,
    lease_owner: null,
    lease_until: null,
    lease_epoch: 0,
    completion_authorized_epoch: null,
    completion_authorized_at: null,
    next_reconcile_at: null,
    last_error_code: null,
    commerce_started_at: null,
    commerce_resolved_at: null,
    terminal_at: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  }
}

type HarnessOptions = {
  initial?: CheckoutExecutionDTO
  commerceOutcome?: NativeCommerceOutcome
  activeLease?: boolean
  lockFailure?: "before" | "aborted"
  authorizeFailure?: boolean
  nativeThrow?: boolean
  resultPersistenceFailure?: boolean
  consumeFailure?: boolean
  releaseFailure?: boolean
  allocationRequestHash?: string
  authorizeRaceResult?: CheckoutExecutionDTO
  lockFailureAfterJob?: boolean
  prepareRaceResult?: CheckoutExecutionDTO
}

function makeHarness(options: HarnessOptions = {}) {
  const events: string[] = []
  let current = options.initial ?? null
  let leaseEpoch = current?.lease_epoch ?? 0

  const snapshot = () => {
    if (!current) {
      throw new Error("test harness has no execution")
    }
    return { execution: current, items: [] }
  }
  const transition = (next: CheckoutExecutionDTO) => {
    current = next
    return { ...snapshot(), replayed: false }
  }
  const advance = (
    state: CheckoutExecutionState,
    overrides: Partial<CheckoutExecutionDTO> = {}
  ) =>
    transition(
      execution(state, {
        ...current,
        version: (current?.version ?? 0) + 1,
        state,
        ...overrides,
      })
    )

  const dependencies: FlashSaleCheckoutOrchestratorDependencies = {
    campaign: {
      assertCheckoutEligible: jest.fn(async () => {
        events.push("campaign")
      }),
    },
    allocation: {
      claimAndHoldQuota: jest.fn(async () => {
        events.push("hold")
        return {
          status: "held" as const,
          attempt: {
            id: "attempt-1",
            request_hash: options.allocationRequestHash ?? REQUEST_HASH,
            state: "quota_held",
          },
          replayed: false,
        }
      }),
      beginQuotaSettlement: jest.fn(async () => {
        events.push("begin")
      }),
      authorizeQuotaSettlement: jest.fn(async () => {
        events.push("authorize-allocation")
      }),
      consumeQuotaSettlement: jest.fn(async () => {
        events.push("consume")
        if (options.consumeFailure) {
          throw new Error("consume unavailable")
        }
      }),
      releaseQuotaSettlement: jest.fn(async () => {
        events.push("release")
        if (options.releaseFailure) {
          throw new Error("release unavailable")
        }
      }),
    },
    checkout: {
      readExecutionReplay: jest.fn(async () => {
        events.push("read")
        return current ? snapshot() : null
      }),
      prepareExecution: jest.fn(async () => {
        events.push("prepare")
        const prepared = transition(
          options.prepareRaceResult ??
            execution(CheckoutExecutionState.PREPARED)
        )
        return options.prepareRaceResult
          ? { ...prepared, replayed: true }
          : prepared
      }),
      claimCommerceLease: jest.fn(async ({ worker_id }) => {
        events.push("claim")
        if (options.activeLease) {
          throw Object.assign(new Error("lease active"), {
            code: "COMMERCE_LEASE_ACTIVE",
          })
        }
        leaseEpoch += 1
        return advance(CheckoutExecutionState.COMMERCE_PENDING, {
          lease_owner: worker_id,
          lease_epoch: leaseEpoch,
          attempt_count: (current?.attempt_count ?? 0) + 1,
          commerce_started_at: NOW,
        })
      }),
      authorizeCartCompletion: jest.fn(async ({ lease_epoch }) => {
        events.push("authorize-execution")
        if (options.authorizeFailure) {
          if (options.authorizeRaceResult) {
            current = options.authorizeRaceResult
          }
          throw Object.assign(new Error("lease fenced"), {
            code: "COMMERCE_LEASE_FENCED",
          })
        }
        return advance(CheckoutExecutionState.COMMERCE_PENDING, {
          completion_authorized_epoch: lease_epoch,
          completion_authorized_at: NOW,
        })
      }),
      recordCommerceSucceeded: jest.fn(async ({ order_id }) => {
        events.push("record-success")
        if (options.resultPersistenceFailure) {
          throw new Error("write unavailable")
        }
        return advance(CheckoutExecutionState.COMMERCE_SUCCEEDED, {
          order_id,
          lease_owner: null,
          lease_until: null,
          commerce_resolved_at: NOW,
        })
      }),
      recordCommerceDefinitiveFailure: jest.fn(async ({ error_code }) => {
        events.push("record-definitive")
        if (options.resultPersistenceFailure) {
          throw new Error("write unavailable")
        }
        return advance(CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED, {
          last_error_code: error_code,
          lease_owner: null,
          lease_until: null,
          commerce_resolved_at: NOW,
        })
      }),
      recordCommerceUnknown: jest.fn(async ({ error_code }) => {
        events.push("record-unknown")
        if (options.resultPersistenceFailure) {
          throw new Error("write unavailable")
        }
        return advance(CheckoutExecutionState.COMMERCE_UNKNOWN, {
          last_error_code: error_code,
          lease_owner: null,
          lease_until: null,
          next_reconcile_at: NOW,
        })
      }),
      completeExecution: jest.fn(async () => {
        events.push("complete")
        return advance(CheckoutExecutionState.COMPLETED, {
          terminal_at: NOW,
        })
      }),
      cancelExecution: jest.fn(async () => {
        events.push("cancel")
        return advance(CheckoutExecutionState.CANCELED, {
          terminal_at: NOW,
        })
      }),
    },
    cartLock: {
      execute: jest.fn(async (_key, job) => {
        if (options.lockFailure === "before") {
          events.push("lock-wait")
          throw new Error("lock timeout")
        }
        events.push("lock-enter")
        const controller = new AbortController()
        if (options.lockFailure === "aborted") {
          controller.abort()
        }
        try {
          const result = await job({
            signal: controller.signal,
            parent_step_idempotency_key: "opaque-lock-scope-key",
          })
          if (options.lockFailureAfterJob) {
            throw new Error("lock release failed")
          }
          return result
        } finally {
          events.push("lock-exit")
        }
      }),
    },
    commerce: {
      complete: jest.fn(async () => {
        events.push("commerce")
        if (options.nativeThrow) {
          throw new Error("native outcome lost")
        }
        const defaultOutcome: NativeCommerceOutcome = {
          kind: "succeeded",
          order_id: "order-1",
        }
        return options.commerceOutcome ?? defaultOutcome
      }),
    },
  }

  const orchestrator = new FlashSaleCheckoutOrchestrator(dependencies, {
    workerIdFactory: () => "worker-1",
    lease_seconds: 30,
    lock_timeout_seconds: 5,
    lock_expire_seconds: 60,
    unknown_reconcile_after_seconds: 45,
  })

  return { dependencies, events, getCurrent: () => current, orchestrator }
}

describe("FlashSaleCheckoutOrchestrator", () => {
  it("runs the fresh success path in the fenced order and settles after unlocking", async () => {
    const { dependencies, events, orchestrator } = makeHarness()

    await expect(orchestrator.run(COMMAND)).resolves.toEqual({
      status: "completed",
      execution_id: "execution-1",
      order_id: "order-1",
      replayed: false,
    })
    expect(events).toEqual([
      "read",
      "campaign",
      "hold",
      "prepare",
      "begin",
      "claim",
      "lock-enter",
      "authorize-execution",
      "authorize-allocation",
      "commerce",
      "record-success",
      "lock-exit",
      "consume",
      "complete",
    ])
    expect(dependencies.commerce.complete).toHaveBeenCalledWith({
      cart_id: COMMAND.cart_id,
      commerce_transaction_id: "commerce-transaction-1",
      parent_step_idempotency_key: "opaque-lock-scope-key",
      signal: expect.any(AbortSignal),
    })
    expect(dependencies.checkout.recordCommerceSucceeded).toHaveBeenCalledWith({
      execution_id: "execution-1",
      expected_version: 3,
      worker_id: "worker-1",
      lease_epoch: 1,
      commerce_transaction_id: "commerce-transaction-1",
      order_id: "order-1",
    })
    expect(dependencies.cartLock.execute).toHaveBeenCalledWith(
      COMMAND.cart_id,
      expect.any(Function),
      { timeout: 5, expire: 60 }
    )
  })

  it("keeps COMMERCE_SUCCEEDED replayable when quota settlement fails", async () => {
    const harness = makeHarness({ consumeFailure: true })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toEqual({
      status: "in_progress",
      execution_id: "execution-1",
      reason: "SETTLEMENT_RETRY",
      replayed: false,
    })
    expect(harness.getCurrent()?.state).toBe(
      CheckoutExecutionState.COMMERCE_SUCCEEDED
    )
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
    expect(harness.dependencies.checkout.cancelExecution).not.toHaveBeenCalled()
  })

  it("replay-first settles COMMERCE_SUCCEEDED without invoking Commerce", async () => {
    const harness = makeHarness({
      initial: execution(CheckoutExecutionState.COMMERCE_SUCCEEDED, {
        order_id: "order-1",
        version: 4,
      }),
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toEqual({
      status: "completed",
      execution_id: "execution-1",
      order_id: "order-1",
      replayed: true,
    })
    expect(harness.events).toEqual(["read", "consume", "complete"])
  })

  it("settles a terminal prepare replay won after the initial replay read", async () => {
    const harness = makeHarness({
      prepareRaceResult: execution(CheckoutExecutionState.COMPLETED, {
        order_id: "racing-order",
      }),
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toEqual({
      status: "completed",
      execution_id: "execution-1",
      order_id: "racing-order",
      replayed: true,
    })
    expect(
      harness.dependencies.allocation.beginQuotaSettlement
    ).not.toHaveBeenCalled()
    expect(harness.dependencies.commerce.complete).not.toHaveBeenCalled()
  })

  it("releases quota and cancels only after a definitive result is persisted", async () => {
    const harness = makeHarness({
      commerceOutcome: {
        kind: "definitive_failure",
        error_code: "INSUFFICIENT_INVENTORY",
      },
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toEqual({
      status: "canceled",
      execution_id: "execution-1",
      error_code: "INSUFFICIENT_INVENTORY",
      replayed: false,
    })
    expect(harness.events.indexOf("lock-exit")).toBeLessThan(
      harness.events.indexOf("release")
    )
    expect(harness.events.slice(-2)).toEqual(["release", "cancel"])
  })

  it("persists unknown outcomes without releasing quota or retrying Commerce", async () => {
    const harness = makeHarness({
      commerceOutcome: { kind: "unknown", error_code: "PAYMENT_TIMEOUT" },
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "unknown",
      error_code: "PAYMENT_TIMEOUT",
    })
    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "unknown",
      error_code: "PAYMENT_TIMEOUT",
      replayed: true,
    })
    expect(harness.dependencies.commerce.complete).toHaveBeenCalledTimes(1)
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.consumeQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it("keeps quota committing when the native guard detects cart mutation after hold", async () => {
    const harness = makeHarness({
      commerceOutcome: {
        kind: "unknown",
        error_code: "CART_SNAPSHOT_CHANGED",
      },
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "unknown",
      error_code: "CART_SNAPSHOT_CHANGED",
    })
    expect(
      harness.dependencies.checkout.recordCommerceUnknown
    ).toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.consumeQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it("classifies an unexpected native exception as unknown", async () => {
    const harness = makeHarness({ nativeThrow: true })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "unknown",
      error_code: "NATIVE_COMMERCE_RESULT_UNKNOWN",
    })
    expect(
      harness.dependencies.checkout.recordCommerceUnknown
    ).toHaveBeenCalledWith(
      expect.objectContaining({ reconcile_after_seconds: 45 })
    )
  })

  it("reports lock wait as pending and leaves committing quota untouched", async () => {
    const harness = makeHarness({ lockFailure: "before" })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "in_progress",
      reason: "LOCK_WAIT",
    })
    expect(harness.dependencies.commerce.complete).not.toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it.each(["aborted", "authorize"] as const)(
    "reports %s pre-commerce fence loss as pending without releasing quota",
    async (failure) => {
      const harness = makeHarness(
        failure === "aborted"
          ? { lockFailure: "aborted" }
          : { authorizeFailure: true }
      )

      await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
        status: "in_progress",
        reason: "LEASE_LOST",
      })
      expect(harness.dependencies.commerce.complete).not.toHaveBeenCalled()
      expect(
        harness.dependencies.allocation.releaseQuotaSettlement
      ).not.toHaveBeenCalled()
      expect(harness.getCurrent()?.state).toBe(
        CheckoutExecutionState.COMMERCE_PENDING
      )
    }
  )

  it("returns ACTIVE_LEASE without entering the cart lock", async () => {
    const harness = makeHarness({ activeLease: true })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "in_progress",
      reason: "ACTIVE_LEASE",
    })
    expect(harness.dependencies.cartLock.execute).not.toHaveBeenCalled()
  })

  it("fences a same-cart contender while the owner is inside native Commerce", async () => {
    const harness = makeHarness()
    let commerceEntered!: () => void
    let finishCommerce!: (outcome: NativeCommerceOutcome) => void
    const entered = new Promise<void>((resolve) => {
      commerceEntered = resolve
    })
    const outcome = new Promise<NativeCommerceOutcome>((resolve) => {
      finishCommerce = resolve
    })
    jest
      .mocked(harness.dependencies.commerce.complete)
      .mockImplementationOnce(async () => {
        commerceEntered()
        return await outcome
      })

    const owner = harness.orchestrator.run(COMMAND)
    await entered
    jest
      .mocked(harness.dependencies.checkout.claimCommerceLease)
      .mockRejectedValueOnce(
        Object.assign(new Error("lease active"), {
          code: "COMMERCE_LEASE_ACTIVE",
        })
      )

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "in_progress",
      reason: "ACTIVE_LEASE",
      replayed: true,
    })
    expect(harness.dependencies.commerce.complete).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.cartLock.execute).toHaveBeenCalledTimes(1)

    finishCommerce({ kind: "succeeded", order_id: "order-1" })
    await expect(owner).resolves.toMatchObject({
      status: "completed",
      order_id: "order-1",
    })
  })

  it("settles a competing worker result observed during lock reauthorization", async () => {
    const harness = makeHarness({
      authorizeFailure: true,
      authorizeRaceResult: execution(
        CheckoutExecutionState.COMMERCE_SUCCEEDED,
        { order_id: "winner-order", version: 9 }
      ),
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "completed",
      order_id: "winner-order",
      replayed: true,
    })
    expect(harness.dependencies.commerce.complete).not.toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it("recovers a persisted result when cart-lock cleanup rejects", async () => {
    const harness = makeHarness({ lockFailureAfterJob: true })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "completed",
      order_id: "order-1",
      replayed: true,
    })
    expect(harness.dependencies.commerce.complete).toHaveBeenCalledTimes(1)
    expect(
      harness.dependencies.checkout.readExecutionReplay
    ).toHaveBeenCalledTimes(2)
  })

  it("takes over an existing pending execution without repeating campaign or hold", async () => {
    const harness = makeHarness({
      initial: execution(CheckoutExecutionState.COMMERCE_PENDING, {
        lease_epoch: 3,
        version: 8,
        lease_owner: "expired-worker",
      }),
    })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "completed",
      replayed: true,
    })
    expect(harness.events.slice(0, 3)).toEqual(["read", "begin", "claim"])
    expect(
      harness.dependencies.campaign.assertCheckoutEligible
    ).not.toHaveBeenCalled()
    expect(
      harness.dependencies.allocation.claimAndHoldQuota
    ).not.toHaveBeenCalled()
    expect(harness.dependencies.commerce.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_step_idempotency_key: "opaque-lock-scope-key",
      })
    )
  })

  it("does not release committing quota when Commerce result persistence fails", async () => {
    const harness = makeHarness({ resultPersistenceFailure: true })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: "in_progress",
      reason: "RESULT_PERSISTENCE",
    })
    expect(harness.dependencies.commerce.complete).toHaveBeenCalledTimes(1)
    expect(
      harness.dependencies.allocation.releaseQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "completed",
      initial: execution(CheckoutExecutionState.COMPLETED, {
        order_id: "order-1",
      }),
      status: "completed",
    },
    {
      label: "canceled",
      initial: execution(CheckoutExecutionState.CANCELED, {
        last_error_code: "INSUFFICIENT_INVENTORY",
      }),
      status: "canceled",
    },
  ] as const)("returns stable $label terminal replay", async (testCase) => {
    const harness = makeHarness({ initial: testCase.initial })

    await expect(harness.orchestrator.run(COMMAND)).resolves.toMatchObject({
      status: testCase.status,
      replayed: true,
    })
    expect(harness.events).toEqual(["read"])
  })

  it("rejects allocation snapshots whose fingerprint differs from the trusted command", async () => {
    const harness = makeHarness({ allocationRequestHash: "b".repeat(64) })

    await expect(harness.orchestrator.run(COMMAND)).rejects.toMatchObject({
      code: FlashSaleCheckoutOrchestrationErrorCode.INVALID_PERSISTED_STATE,
    })
    expect(
      harness.dependencies.checkout.prepareExecution
    ).not.toHaveBeenCalled()
  })

  it("rejects non-exact, accessor, raw-key, and overlong lease inputs", async () => {
    const harness = makeHarness()
    await expect(
      harness.orchestrator.run({
        ...COMMAND,
        attempt_id: "client-value",
      } as never)
    ).rejects.toMatchObject({
      code: FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND,
    })

    const accessor = { ...COMMAND }
    Object.defineProperty(accessor, "cart_id", {
      enumerable: true,
      get: () => COMMAND.cart_id,
    })
    await expect(harness.orchestrator.run(accessor)).rejects.toMatchObject({
      code: FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND,
    })
    await expect(
      harness.orchestrator.run({ ...COMMAND, command_id: "raw-key" })
    ).rejects.toMatchObject({
      code: FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND,
    })
    expect(
      () =>
        new FlashSaleCheckoutOrchestrator(harness.dependencies, {
          workerIdFactory: () => "worker-1",
          lease_seconds: 121,
          lock_timeout_seconds: 5,
          lock_expire_seconds: 60,
          unknown_reconcile_after_seconds: 45,
        })
    ).toThrow(
      expect.objectContaining({
        code: FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND,
      })
    )
  })
})
