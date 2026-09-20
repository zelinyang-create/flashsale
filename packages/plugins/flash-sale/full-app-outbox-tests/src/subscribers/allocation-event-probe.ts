import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import {
  ALLOCATION_OUTBOX_EVENT_NAMES,
  AllocationEventWireEnvelope,
} from "../../../src/shared"
import AllocationEventProbeModuleService, {
  ALLOCATION_EVENT_PROBE_CONSUMER,
  ALLOCATION_EVENT_PROBE_MODULE,
} from "../modules/allocation-event-probe/service"

export default async function allocationEventProbeSubscriber({
  event,
  container,
}: SubscriberArgs<AllocationEventWireEnvelope>) {
  const probe = container.resolve<AllocationEventProbeModuleService>(
    ALLOCATION_EVENT_PROBE_MODULE
  )
  await probe.applyAllocationEvent(event.name, event.data)
}

export const config: SubscriberConfig = {
  event: [...ALLOCATION_OUTBOX_EVENT_NAMES],
  context: { subscriberId: ALLOCATION_EVENT_PROBE_CONSUMER },
}
