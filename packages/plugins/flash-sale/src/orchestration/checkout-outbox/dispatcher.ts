import type { ClaimedCheckoutOutboxEvent } from "../../modules/flash-sale-checkout"
import {
  CheckoutEventWireEnvelope,
  normalizeCheckoutEventWireEnvelope,
} from "../../shared"
import { OutboxLaneDispatcher } from "../outbox-dispatcher"
import type {
  CheckoutEventTransport,
  CheckoutOutboxDispatchResult,
  CheckoutOutboxDispatcherConfig,
  CheckoutOutboxDispatcherHooks,
  CheckoutOutboxPort,
} from "./contracts"

function wire(event: ClaimedCheckoutOutboxEvent): CheckoutEventWireEnvelope {
  return normalizeCheckoutEventWireEnvelope({
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

export class CheckoutOutboxDispatcher {
  private readonly lane: OutboxLaneDispatcher<
    ClaimedCheckoutOutboxEvent,
    CheckoutEventWireEnvelope
  >
  constructor(
    checkout: CheckoutOutboxPort,
    transport: CheckoutEventTransport,
    config: CheckoutOutboxDispatcherConfig,
    workerId: string,
    hooks: CheckoutOutboxDispatcherHooks = {}
  ) {
    this.lane = new OutboxLaneDispatcher(
      {
        claim: (command) => checkout.claimCheckoutOutboxEvents(command),
        mark: (command) => checkout.markCheckoutOutboxPublished(command),
        fail: (command) => checkout.failCheckoutOutboxEvent(command),
      },
      transport,
      wire,
      config,
      workerId,
      hooks.after_event_bus_accept_before_mark
    )
  }
  assertReady() { this.lane.assertReady() }
  async runTick(limit?: number, preflight = true): Promise<CheckoutOutboxDispatchResult> {
    return await this.lane.runTick(limit, preflight)
  }
}
