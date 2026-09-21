import { FairOutboxCoordinator } from "../dispatch-allocation-outbox"

const result = (claimed: number) => ({
  skipped: false as const,
  skip_reason: null,
  claimed,
  accepted: claimed,
  published: claimed,
  retry_scheduled: 0,
  dead_lettered: 0,
  fenced: 0,
  ambiguous: 0,
  invalid: 0,
})

function lane() {
  return {
    assertReady: jest.fn(),
    runTick: jest.fn(async (limit: number) => result(limit)),
  }
}

describe("fair outbox coordinator", () => {
  it("globally preflights every enabled lane before any claim", async () => {
    const allocation = lane()
    const checkout = lane()
    checkout.assertReady.mockImplementation(() => { throw new Error("bad manifest") })
    const coordinator = new FairOutboxCoordinator(
      allocation as any, checkout as any, 2
    )
    await expect(coordinator.runTick()).rejects.toThrow("bad manifest")
    expect(allocation.runTick).not.toHaveBeenCalled()
    expect(checkout.runTick).not.toHaveBeenCalled()
  })

  it("keeps the allocation-only compatibility entry point inside global preflight", async () => {
    const allocation = lane()
    const checkout = lane()
    checkout.assertReady.mockImplementation(() => { throw new Error("checkout registry drift") })
    const coordinator = new FairOutboxCoordinator(
      allocation as any, checkout as any, 2
    )

    await expect(coordinator.runAllocationOnlyTick()).rejects.toThrow(
      "checkout registry drift"
    )
    expect(allocation.runTick).not.toHaveBeenCalled()
    expect(checkout.runTick).not.toHaveBeenCalled()
  })

  it("isolates a lane claim failure after successful global preflight", async () => {
    const allocation = lane()
    const checkout = lane()
    allocation.runTick.mockRejectedValueOnce(new Error("allocation DB unavailable"))
    const coordinator = new FairOutboxCoordinator(
      allocation as any, checkout as any, 2
    )
    await expect(coordinator.runTick()).resolves.toMatchObject({
      lane_errors: ["allocation"],
      checkout: { claimed: 1, published: 1 },
    })
    expect(checkout.runTick).toHaveBeenCalledWith(1, false)
  })

  it("enforces the global concurrency budget across overlapping ticks", async () => {
    const allocation = lane()
    const checkout = lane()
    let release: (() => void) | undefined
    allocation.runTick.mockImplementationOnce(
      (limit: number) => new Promise((resolve) => {
        release = () => resolve(result(limit))
      })
    )
    const coordinator = new FairOutboxCoordinator(
      allocation as any, checkout as any, 1
    )

    const first = coordinator.runTick()
    await Promise.resolve()
    await expect(coordinator.runTick()).resolves.toMatchObject({
      skipped: true,
      allocation: { skipped: true, skip_reason: "overlap" },
      checkout: { skipped: true, skip_reason: "overlap" },
    })
    expect(checkout.runTick).not.toHaveBeenCalled()

    release!()
    await expect(first).resolves.toMatchObject({ skipped: false })
  })

  it("shares the overlap guard with the allocation-only compatibility entry point", async () => {
    const allocation = lane()
    const checkout = lane()
    const coordinator = new FairOutboxCoordinator(
      allocation as any, checkout as any, 1
    )
    await coordinator.runTick()

    let releaseCheckout: (() => void) | undefined
    checkout.runTick.mockImplementationOnce(
      (limit: number) => new Promise((resolve) => {
        releaseCheckout = () => resolve(result(limit))
      })
    )
    const checkoutTick = coordinator.runTick()
    await Promise.resolve()
    await expect(coordinator.runAllocationOnlyTick()).resolves.toMatchObject({
      skipped: true,
      skip_reason: "overlap",
      claimed: 0,
    })
    expect(allocation.runTick).toHaveBeenCalledTimes(1)
    releaseCheckout!()
    await checkoutTick

    let releaseAllocation: (() => void) | undefined
    allocation.runTick.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseAllocation = () => resolve(result(1))
      })
    )
    const allocationOnlyTick = coordinator.runAllocationOnlyTick()
    await Promise.resolve()
    await expect(coordinator.runTick()).resolves.toMatchObject({
      skipped: true,
      allocation: { skipped: true, skip_reason: "overlap", claimed: 0 },
      checkout: { skipped: true, skip_reason: "overlap", claimed: 0 },
    })
    releaseAllocation!()
    await allocationOnlyTick
  })
})
