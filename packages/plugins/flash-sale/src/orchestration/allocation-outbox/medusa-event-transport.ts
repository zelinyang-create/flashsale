import type {
  AllocationEventWireEnvelope,
  CheckoutEventWireEnvelope,
} from "../../shared"
import { compareUtf16CodeUnits } from "../../shared"
import type {
  AllocationEventAcceptanceReceipt,
  AllocationEventTransport,
  MedusaEventBus,
} from "./contracts"

export class AllocationEventTransportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "AllocationEventTransportError"
  }
}

export class MedusaRedisOutboxEventTransport {
  constructor(private readonly eventBus: MedusaEventBus) {}

  assertReady(
    subscriberManifest: Readonly<Record<string, readonly string[]>>
  ): void {
    // Medusa 2.21's Redis provider does not enqueue events without an exact or
    // wildcard subscriber. The registry is a public AbstractEventBus getter,
    // but is not yet part of IEventBusModuleService; a source contract pins it.
    const subscribers = this.eventBus.eventToSubscribersMap
    if (!(subscribers instanceof Map)) {
      throw new AllocationEventTransportError(
        "EVENT_BUS_SUBSCRIBER_REGISTRY_UNAVAILABLE"
      )
    }
    for (const [eventName, expectedIds] of Object.entries(
      subscriberManifest
    )) {
      const registeredIds = (subscribers.get(eventName) ?? [])
        .map((subscriber) => subscriber.id)
        .sort(compareUtf16CodeUnits)
      if (
        new Set(registeredIds).size !== registeredIds.length ||
        registeredIds.length !== expectedIds.length ||
        registeredIds.some((id, index) => id !== expectedIds[index])
      ) {
        throw new AllocationEventTransportError(
          "EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH"
        )
      }
    }
  }

  async publish(
    envelope: AllocationEventWireEnvelope | CheckoutEventWireEnvelope
  ): Promise<AllocationEventAcceptanceReceipt> {
    await this.eventBus.emit({
      name: envelope.event_name,
      data: envelope,
    })
    return Object.freeze({
      accepted: true,
      provider: "medusa-redis-event-bus" as const,
    })
  }
}

export class MedusaRedisAllocationEventTransport
  extends MedusaRedisOutboxEventTransport
  implements AllocationEventTransport {}
