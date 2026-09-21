import type { IEventBusModuleService } from "@medusajs/framework/types"
import type {
  CheckoutOutboxMutationResult,
  ClaimedCheckoutOutboxEvent,
  ClaimCheckoutOutboxEventsResult,
} from "../../modules/flash-sale-checkout"
import type { CheckoutEventWireEnvelope } from "../../shared"
import type { OutboxLaneConfig, OutboxLaneResult } from "../outbox-dispatcher"

export interface CheckoutOutboxPort {
  claimCheckoutOutboxEvents(command: {
    worker_id: string
    limit: number
    lease_seconds: number
    max_attempts: number
  }): Promise<ClaimCheckoutOutboxEventsResult>
  markCheckoutOutboxPublished(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
  }): Promise<CheckoutOutboxMutationResult>
  failCheckoutOutboxEvent(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
    retry_after_seconds: number
    error_code: string
    permanent: boolean
  }): Promise<CheckoutOutboxMutationResult>
}

export interface CheckoutEventTransport {
  assertReady(manifest: Readonly<Record<string, readonly string[]>>): void
  publish(envelope: CheckoutEventWireEnvelope): Promise<{
    accepted: true
    provider: "medusa-redis-event-bus"
  }>
}

export type CheckoutOutboxDispatcherConfig = OutboxLaneConfig
export type CheckoutOutboxDispatchResult = OutboxLaneResult
export type CheckoutOutboxDispatcherHooks = Readonly<{
  after_event_bus_accept_before_mark?: (
    event: ClaimedCheckoutOutboxEvent
  ) => Promise<void> | void
}>
export type CheckoutMedusaEventBus = Pick<IEventBusModuleService, "emit">
