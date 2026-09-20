import {
  ActivateAllocationOutboxHandler,
  AllocationCommandErrorCode,
  ClaimAllocationOutboxEventsHandler,
  FailAllocationOutboxEventHandler,
  MarkAllocationOutboxPublishedHandler,
  RedriveAllocationOutboxEventHandler,
} from "../index"

const store = {
  activateOutboxRequired: jest.fn(),
  claimOutboxEvents: jest.fn(),
  markOutboxPublished: jest.fn(),
  failOutboxEvent: jest.fn(),
  redriveOutboxEvent: jest.fn(),
}

describe("allocation outbox exact commands", () => {
  beforeEach(() => jest.clearAllMocks())

  it("accepts exact bounded server-side commands", async () => {
    store.activateOutboxRequired.mockResolvedValue({
      required_after: new Date(0),
      replayed: false,
    })
    store.claimOutboxEvents.mockResolvedValue({ events: [] })
    await new ActivateAllocationOutboxHandler(store).execute({})
    await new ClaimAllocationOutboxEventsHandler(store).execute({
      worker_id: "worker-1",
      limit: 10,
      lease_seconds: 30,
      max_attempts: 5,
    })
    expect(store.activateOutboxRequired).toHaveBeenCalledWith({})
    expect(store.claimOutboxEvents).toHaveBeenCalledTimes(1)
  })

  it("passes a bounded retry delay and sanitized error code exactly", async () => {
    store.failOutboxEvent.mockResolvedValue({
      disposition: "retried",
      event: null,
    })
    const command = {
      event_id: "event-1",
      worker_id: "worker-1",
      lease_epoch: 2,
      retry_after_seconds: 30,
      error_code: "BROKER_UNAVAILABLE",
      permanent: false,
    } as const
    await new FailAllocationOutboxEventHandler(store).execute(command)
    expect(store.failOutboxEvent).toHaveBeenCalledWith(command)
  })

  it.each([
    () =>
      new ActivateAllocationOutboxHandler(store).execute({ extra: true } as never),
    () =>
      new ClaimAllocationOutboxEventsHandler(store).execute({
        worker_id: " worker ",
        limit: 101,
        lease_seconds: 0,
        max_attempts: 0,
      }),
    () =>
      new MarkAllocationOutboxPublishedHandler(store).execute({
        event_id: "event",
        worker_id: "worker",
        lease_epoch: 0,
      }),
    () =>
      new FailAllocationOutboxEventHandler(store).execute({
        event_id: "event",
        worker_id: "worker",
        lease_epoch: 1,
        retry_after_seconds: 1,
        error_code: "raw exception text",
        permanent: false,
      }),
    () =>
      new RedriveAllocationOutboxEventHandler(store).execute({
        event_id: "event",
        event_hash: "A".repeat(64),
      }),
  ])("rejects malformed, extra, or unsafe command input", async (execute) => {
    await expect(execute()).rejects.toMatchObject({
      code: AllocationCommandErrorCode.INVALID_COMMAND,
    })
  })

  it("rejects enumerable accessors without invoking them", async () => {
    let limitReads = 0
    const claim = {
      worker_id: "worker-1",
      lease_seconds: 30,
      max_attempts: 5,
    } as Record<string, unknown>
    Object.defineProperty(claim, "limit", {
      enumerable: true,
      get: () => ++limitReads,
    })
    await expect(
      new ClaimAllocationOutboxEventsHandler(store).execute(claim as never)
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
    expect(limitReads).toBe(0)

    let epochReads = 0
    const mark = { event_id: "event-1", worker_id: "worker-1" } as Record<
      string,
      unknown
    >
    Object.defineProperty(mark, "lease_epoch", {
      enumerable: true,
      get: () => ++epochReads,
    })
    await expect(
      new MarkAllocationOutboxPublishedHandler(store).execute(mark as never)
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
    expect(epochReads).toBe(0)

    let hashReads = 0
    const redrive = { event_id: "event-1" } as Record<string, unknown>
    Object.defineProperty(redrive, "event_hash", {
      enumerable: true,
      get: () => `${++hashReads}`.padStart(64, "0"),
    })
    await expect(
      new RedriveAllocationOutboxEventHandler(store).execute(redrive as never)
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
    expect(hashReads).toBe(0)

    const setterOnly = {
      event_id: "event-1",
      worker_id: "worker-1",
    } as Record<string, unknown>
    Object.defineProperty(setterOnly, "lease_epoch", {
      enumerable: true,
      set: () => undefined,
    })
    await expect(
      new MarkAllocationOutboxPublishedHandler(store).execute(
        setterOnly as never
      )
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
    expect(store.claimOutboxEvents).not.toHaveBeenCalled()
    expect(store.markOutboxPublished).not.toHaveBeenCalled()
    expect(store.redriveOutboxEvent).not.toHaveBeenCalled()
  })

  it("rejects inherited fields and snapshots proxy data descriptors once", async () => {
    const inherited = Object.create({ worker_id: "worker-1" }) as Record<
      string,
      unknown
    >
    Object.assign(inherited, {
      limit: 10,
      lease_seconds: 30,
      max_attempts: 5,
    })
    await expect(
      new ClaimAllocationOutboxEventsHandler(store).execute(inherited as never)
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })

    store.claimOutboxEvents.mockResolvedValue({ events: [] })
    const target = {
      worker_id: "worker-1",
      limit: 10,
      lease_seconds: 30,
      max_attempts: 5,
    }
    const descriptorReads = new Map<PropertyKey, number>()
    const proxy = new Proxy(target, {
      get: () => {
        throw new Error("command properties must not be read through proxy get")
      },
      getOwnPropertyDescriptor: (object, key) => {
        descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1)
        return Object.getOwnPropertyDescriptor(object, key)
      },
    })
    await new ClaimAllocationOutboxEventsHandler(store).execute(proxy)
    expect([...descriptorReads.values()]).toEqual([1, 1, 1, 1])
    const normalized = store.claimOutboxEvents.mock.calls[0][0]
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(normalized).toEqual(target)
  })
})
