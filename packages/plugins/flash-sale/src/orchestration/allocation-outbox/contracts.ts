import type { IEventBusModuleService } from "@medusajs/framework/types"
import type {
  AllocationOutboxMutationResult,
  ClaimAllocationOutboxEventsResult,
  ClaimedAllocationOutboxEvent,
} from "../../modules/flash-sale-allocation/application"
import type { AllocationEventWireEnvelope } from "../../shared"

export interface AllocationOutboxPort {
  claimAllocationOutboxEvents(command: {
    worker_id: string
    limit: number
    lease_seconds: number
    max_attempts: number
  }): Promise<ClaimAllocationOutboxEventsResult>
  markAllocationOutboxPublished(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
  }): Promise<AllocationOutboxMutationResult>
  failAllocationOutboxEvent(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
    retry_after_seconds: number
    error_code: string
    permanent: boolean
  }): Promise<AllocationOutboxMutationResult>
}

export type AllocationEventAcceptanceReceipt = Readonly<{
  accepted: true
  provider: "medusa-redis-event-bus"
}>

export interface AllocationEventTransport {
  assertReady(
    subscriberManifest: Readonly<Record<string, readonly string[]>>
  ): void
  publish(
    envelope: AllocationEventWireEnvelope
  ): Promise<AllocationEventAcceptanceReceipt>
}

export type AllocationOutboxDispatcherConfig = Readonly<{
  enabled: true
  concurrency: number
  lease_seconds: number
  max_attempts: number
  retry_after_seconds: number
  mark_timeout_ms: number
  safety_margin_ms: number
  subscriber_manifest: Readonly<Record<string, readonly string[]>>
}>

export type AllocationOutboxDispatchResult = Readonly<{
  skipped: boolean
  skip_reason: "disabled" | "overlap" | null
  claimed: number
  accepted: number
  published: number
  retry_scheduled: number
  dead_lettered: number
  fenced: number
  ambiguous: number
  invalid: number
}>

export type AllocationOutboxDispatcherHooks = Readonly<{
  after_event_bus_accept_before_mark?: (
    event: ClaimedAllocationOutboxEvent
  ) => Promise<void> | void
}>

export type MedusaEventBus = Pick<IEventBusModuleService, "emit"> &
  Readonly<{
    eventToSubscribersMap?: Map<
      string | symbol,
      readonly Readonly<{ id: string }>[]
    >
  }>
