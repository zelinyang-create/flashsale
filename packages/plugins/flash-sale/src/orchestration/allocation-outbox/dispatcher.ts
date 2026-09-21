import type { ClaimedAllocationOutboxEvent } from "../../modules/flash-sale-allocation/application"
import {
  AllocationEventWireEnvelope,
  normalizeAllocationEventWireEnvelope,
} from "../../shared"
import { OutboxLaneDispatcher } from "../outbox-dispatcher"
import type {
  AllocationEventTransport,
  AllocationOutboxDispatchResult,
  AllocationOutboxDispatcherConfig,
  AllocationOutboxDispatcherHooks,
  AllocationOutboxPort,
} from "./contracts"

function wire(event: ClaimedAllocationOutboxEvent): AllocationEventWireEnvelope {
  return normalizeAllocationEventWireEnvelope({
    event_id: event.id,
    event_name: event.event_name,
    schema_version: event.schema_version,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    aggregate_version: event.aggregate_version,
    event_hash: event.event_hash,
    occurred_at: event.occurred_at.toISOString(),
    payload: event.payload,
  })
}

export class AllocationOutboxDispatcher {
  private readonly lane: OutboxLaneDispatcher<
    ClaimedAllocationOutboxEvent,
    AllocationEventWireEnvelope
  >

  constructor(
    allocation: AllocationOutboxPort,
    transport: AllocationEventTransport,
    config: AllocationOutboxDispatcherConfig,
    workerId: string,
    hooks: AllocationOutboxDispatcherHooks = {}
  ) {
    this.lane = new OutboxLaneDispatcher(
      {
        claim: (command) => allocation.claimAllocationOutboxEvents(command),
        mark: (command) => allocation.markAllocationOutboxPublished(command),
        fail: (command) => allocation.failAllocationOutboxEvent(command),
      },
      transport,
      wire,
      config,
      workerId,
      hooks.after_event_bus_accept_before_mark
    )
  }

  assertReady() {
    this.lane.assertReady()
  }

  async runTick(
    limit?: number,
    preflight = true
  ): Promise<AllocationOutboxDispatchResult> {
    return await this.lane.runTick(limit, preflight)
  }
}
