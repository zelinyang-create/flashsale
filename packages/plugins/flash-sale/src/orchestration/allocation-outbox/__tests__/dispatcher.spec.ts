import {
  AllocationOutboxStatus,
} from "../../../types"
import type { ClaimedAllocationOutboxEvent } from "../../../modules/flash-sale-allocation/application"
import {
  ALLOCATION_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_OUTBOX_SCHEMA_VERSION,
  AllocationOutboxEventName,
  hashAllocationEventIdentity,
} from "../../../shared"
import type {
  AllocationEventTransport,
  AllocationOutboxDispatcherConfig,
  AllocationOutboxPort,
} from "../contracts"
import { AllocationOutboxDispatcher } from "../dispatcher"

function event(id: string): ClaimedAllocationOutboxEvent {
  const identity = {
    event_name: AllocationOutboxEventName.QUOTA_HELD,
    schema_version: ALLOCATION_OUTBOX_SCHEMA_VERSION,
    aggregate_type: ALLOCATION_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: `attempt-${id}`,
    aggregate_version: 2,
    payload: {
      attempt_id: `attempt-${id}`,
      campaign_id: "campaign-1",
      rules_version: 1,
      state: "quota_held",
      items: [{ campaign_item_id: "item-1", quantity: 1 }],
    },
  } as const
  return {
    id,
    ...identity,
    event_hash: hashAllocationEventIdentity(identity),
    status: AllocationOutboxStatus.PUBLISHING,
    available_at: new Date(0),
    occurred_at: new Date("2026-09-20T20:00:00.000Z"),
    published_at: null,
    attempt_count: 1,
    max_attempts: 3,
    lease_owner: "worker-1",
    lease_until: new Date(Date.now() + 30_000),
    lease_epoch: 1,
    published_by: null,
    published_lease_epoch: null,
    last_error_code: null,
    dead_lettered_at: null,
    redrive_count: 0,
  }
}

const config: AllocationOutboxDispatcherConfig = {
  enabled: true,
  concurrency: 2,
  lease_seconds: 30,
  max_attempts: 3,
  retry_after_seconds: 5,
  mark_timeout_ms: 100,
  safety_margin_ms: 100,
  subscriber_manifest: {
    [AllocationOutboxEventName.QUOTA_HELD]: ["allocation-consumer-v1"],
  },
}

function fixtures(events = [event("event-1")]) {
  const allocation: jest.Mocked<AllocationOutboxPort> = {
    claimAllocationOutboxEvents: jest.fn().mockResolvedValue({ events }),
    markAllocationOutboxPublished: jest.fn().mockResolvedValue({
      disposition: "published",
      event: events[0],
    }),
    failAllocationOutboxEvent: jest.fn().mockResolvedValue({
      disposition: "retried",
      event: events[0],
    }),
  }
  const transport: jest.Mocked<AllocationEventTransport> = {
    assertReady: jest.fn(),
    publish: jest.fn().mockResolvedValue({
      accepted: true,
      provider: "medusa-redis-event-bus",
    }),
  }
  return { allocation, transport }
}

describe("allocation outbox dispatcher", () => {
  it("claims at most concurrency, publishes outside claim, then marks exact epoch", async () => {
    const { allocation, transport } = fixtures()
    const result = await new AllocationOutboxDispatcher(
      allocation,
      transport,
      config,
      "worker-1"
    ).runTick()
    expect(allocation.claimAllocationOutboxEvents).toHaveBeenCalledWith({
      worker_id: "worker-1",
      limit: 2,
      lease_seconds: 30,
      max_attempts: 3,
    })
    expect(transport.publish).toHaveBeenCalledTimes(1)
    expect(allocation.markAllocationOutboxPublished).toHaveBeenCalledWith({
      event_id: "event-1",
      worker_id: "worker-1",
      lease_epoch: 1,
    })
    expect(allocation.failAllocationOutboxEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ accepted: 1, published: 1 })
  })

  it("publishes a detached deeply frozen envelope despite synchronous mutation", async () => {
    const source = event("event-immutable")
    const { allocation, transport } = fixtures([source])
    transport.publish.mockImplementation(async (envelope) => {
      const sourcePayload = source.payload as unknown as Record<string, unknown>
      const sourceItems = sourcePayload.items as Record<string, unknown>[]
      sourcePayload.state = "quota_consumed"
      sourceItems[0].quantity = 9

      const wireItems = envelope.payload.items as readonly Record<
        string,
        unknown
      >[]
      expect(envelope.payload).not.toBe(source.payload)
      expect(envelope.payload.state).toBe("quota_held")
      expect(wireItems[0].quantity).toBe(1)
      expect(Object.isFrozen(envelope)).toBe(true)
      expect(Object.isFrozen(envelope.payload)).toBe(true)
      expect(Object.isFrozen(envelope.payload.items)).toBe(true)
      expect(Object.isFrozen(wireItems[0])).toBe(true)
      expect(Reflect.set(envelope.payload, "state", "quota_released")).toBe(
        false
      )
      return { accepted: true, provider: "medusa-redis-event-bus" }
    })

    await expect(
      new AllocationOutboxDispatcher(
        allocation,
        transport,
        config,
        "worker-1"
      ).runTick()
    ).resolves.toMatchObject({ accepted: 1, published: 1 })
  })

  it("leaves PUBLISHING after acceptance when failpoint or mark fails", async () => {
    const first = fixtures()
    const crashed = new AllocationOutboxDispatcher(
      first.allocation,
      first.transport,
      config,
      "worker-1",
      {
        after_event_bus_accept_before_mark: () => {
          throw new Error("simulated crash")
        },
      }
    )
    await expect(crashed.runTick()).resolves.toMatchObject({ ambiguous: 1 })
    expect(first.allocation.markAllocationOutboxPublished).not.toHaveBeenCalled()
    expect(first.allocation.failAllocationOutboxEvent).not.toHaveBeenCalled()

    const second = fixtures()
    second.allocation.markAllocationOutboxPublished.mockRejectedValue(
      new Error("database unavailable")
    )
    await expect(
      new AllocationOutboxDispatcher(
        second.allocation,
        second.transport,
        config,
        "worker-1"
      ).runTick()
    ).resolves.toMatchObject({ accepted: 1, ambiguous: 1 })
    expect(second.allocation.failAllocationOutboxEvent).not.toHaveBeenCalled()
  })

  it("schedules retry only when no acceptance receipt exists", async () => {
    const { allocation, transport } = fixtures()
    transport.publish.mockRejectedValue(new Error("redis unavailable"))
    const result = await new AllocationOutboxDispatcher(
      allocation,
      transport,
      config,
      "worker-1"
    ).runTick()
    expect(allocation.markAllocationOutboxPublished).not.toHaveBeenCalled()
    expect(allocation.failAllocationOutboxEvent).toHaveBeenCalledWith({
      event_id: "event-1",
      worker_id: "worker-1",
      lease_epoch: 1,
      retry_after_seconds: 5,
      error_code: "EVENT_BUS_ACCEPTANCE_FAILED",
      permanent: false,
    })
    expect(result.retry_scheduled).toBe(1)
  })

  it("checks the subscriber manifest before claiming and isolates poison events", async () => {
    const guarded = fixtures()
    guarded.transport.assertReady.mockImplementation(() => {
      throw new Error("missing subscriber")
    })
    await expect(
      new AllocationOutboxDispatcher(
        guarded.allocation,
        guarded.transport,
        config,
        "worker-1"
      ).runTick()
    ).rejects.toThrow("missing subscriber")
    expect(guarded.allocation.claimAllocationOutboxEvents).not.toHaveBeenCalled()

    const poisonedEvent = { ...event("event-bad"), event_hash: "0".repeat(64) }
    const isolated = fixtures([poisonedEvent, event("event-good")])
    isolated.allocation.failAllocationOutboxEvent.mockResolvedValue({
      disposition: "dead_lettered",
      event: poisonedEvent,
    })
    const result = await new AllocationOutboxDispatcher(
      isolated.allocation,
      isolated.transport,
      config,
      "worker-1"
    ).runTick()
    expect(result).toMatchObject({ claimed: 2, published: 1, dead_lettered: 1 })
  })

  it("rejects overlapping ticks in one process without weakening DB fencing", async () => {
    const { allocation, transport } = fixtures()
    let release!: () => void
    transport.publish.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ accepted: true, provider: "medusa-redis-event-bus" })
      })
    )
    const dispatcher = new AllocationOutboxDispatcher(
      allocation,
      transport,
      config,
      "worker-1"
    )
    const active = dispatcher.runTick()
    await Promise.resolve()
    await expect(dispatcher.runTick()).resolves.toMatchObject({
      skipped: true,
      skip_reason: "overlap",
    })
    release()
    await active
  })
})
