import type { ClaimedAllocationOutboxEvent } from "../../modules/flash-sale-allocation/application"
import {
  AllocationEventEnvelopeError,
  AllocationEventWireEnvelope,
  normalizeAllocationEventWireEnvelope,
} from "../../shared"
import type {
  AllocationEventTransport,
  AllocationOutboxDispatchResult,
  AllocationOutboxDispatcherConfig,
  AllocationOutboxDispatcherHooks,
  AllocationOutboxPort,
} from "./contracts"

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("mark deadline exceeded")),
      milliseconds
    )
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function wire(event: ClaimedAllocationOutboxEvent): AllocationEventWireEnvelope {
  const value = {
    event_id: event.id,
    event_name: event.event_name,
    schema_version: event.schema_version,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    aggregate_version: event.aggregate_version,
    event_hash: event.event_hash,
    occurred_at: event.occurred_at.toISOString(),
    payload: event.payload,
  }
  return normalizeAllocationEventWireEnvelope(value)
}

type EventOutcome =
  | "published"
  | "retry_scheduled"
  | "dead_lettered"
  | "accepted_fenced"
  | "failure_fenced"
  | "accepted_ambiguous"
  | "failure_ambiguous"
  | "invalid"

export class AllocationOutboxDispatcher {
  private running = false

  constructor(
    private readonly allocation: AllocationOutboxPort,
    private readonly transport: AllocationEventTransport,
    private readonly config: AllocationOutboxDispatcherConfig,
    private readonly workerId: string,
    private readonly hooks: AllocationOutboxDispatcherHooks = {}
  ) {}

  async runTick(): Promise<AllocationOutboxDispatchResult> {
    if (this.running) return this.empty(true, "overlap")
    this.running = true
    try {
      this.transport.assertReady(this.config.subscriber_manifest)
      const claimed = await this.allocation.claimAllocationOutboxEvents({
        worker_id: this.workerId,
        limit: this.config.concurrency,
        lease_seconds: this.config.lease_seconds,
        max_attempts: this.config.max_attempts,
      })
      const settled = await Promise.allSettled(
        claimed.events.map((event) => this.dispatchEvent(event))
      )
      const outcomes = settled.map((result): EventOutcome =>
        result.status === "fulfilled" ? result.value : "failure_ambiguous"
      )
      return {
        skipped: false,
        skip_reason: null,
        claimed: claimed.events.length,
        accepted: outcomes.filter((value) =>
          ["published", "accepted_fenced", "accepted_ambiguous"].includes(
            value
          )
        ).length,
        published: outcomes.filter((value) => value === "published").length,
        retry_scheduled: outcomes.filter(
          (value) => value === "retry_scheduled"
        ).length,
        dead_lettered: outcomes.filter(
          (value) => value === "dead_lettered"
        ).length,
        fenced: outcomes.filter((value) => value.endsWith("_fenced")).length,
        ambiguous: outcomes.filter((value) =>
          value.endsWith("_ambiguous")
        ).length,
        invalid: outcomes.filter((value) => value === "invalid").length,
      }
    } finally {
      this.running = false
    }
  }

  private async dispatchEvent(
    event: ClaimedAllocationOutboxEvent
  ): Promise<EventOutcome> {
    let envelope: AllocationEventWireEnvelope
    try {
      envelope = wire(event)
    } catch (error) {
      if (!(error instanceof AllocationEventEnvelopeError)) throw error
      return await this.fail(event, "OUTBOX_ENVELOPE_INVALID", true)
    }

    try {
      // Redis EventBus reconnects indefinitely. We deliberately do not impose
      // a Promise timeout: timing out cannot cancel BullMQ's underlying add and
      // therefore cannot prove that the queue did not accept the event. The
      // process overlap guard bounds this to one in-flight tick per dispatcher;
      // another process may take over after the database lease expires.
      const receipt = await this.transport.publish(envelope)
      if (
        receipt.accepted !== true ||
        receipt.provider !== "medusa-redis-event-bus"
      ) {
        return await this.fail(event, "EVENT_BUS_ACCEPTANCE_INVALID", false)
      }
    } catch {
      return await this.fail(event, "EVENT_BUS_ACCEPTANCE_FAILED", false)
    }

    // From this point onward the message may be durable in Redis. Any failure,
    // including a timeout, must leave PUBLISHING for fenced lease takeover.
    try {
      await this.hooks.after_event_bus_accept_before_mark?.(event)
    } catch {
      return "accepted_ambiguous"
    }
    try {
      const marked = await withDeadline(
        this.allocation.markAllocationOutboxPublished({
          event_id: event.id,
          worker_id: this.workerId,
          lease_epoch: event.lease_epoch,
        }),
        this.config.mark_timeout_ms
      )
      return marked.disposition === "published"
        ? "published"
        : "accepted_fenced"
    } catch {
      return "accepted_ambiguous"
    }
  }

  private async fail(
    event: ClaimedAllocationOutboxEvent,
    errorCode: string,
    permanent: boolean
  ): Promise<EventOutcome> {
    try {
      const failed = await withDeadline(
        this.allocation.failAllocationOutboxEvent({
          event_id: event.id,
          worker_id: this.workerId,
          lease_epoch: event.lease_epoch,
          retry_after_seconds: this.config.retry_after_seconds,
          error_code: errorCode,
          permanent,
        }),
        this.config.mark_timeout_ms
      )
      if (failed.disposition === "fenced") return "failure_fenced"
      if (failed.disposition === "dead_lettered") return "dead_lettered"
      return permanent ? "invalid" : "retry_scheduled"
    } catch {
      return "failure_ambiguous"
    }
  }

  private empty(
    skipped: boolean,
    reason: "disabled" | "overlap"
  ): AllocationOutboxDispatchResult {
    return {
      skipped,
      skip_reason: reason,
      claimed: 0,
      accepted: 0,
      published: 0,
      retry_scheduled: 0,
      dead_lettered: 0,
      fenced: 0,
      ambiguous: 0,
      invalid: 0,
    }
  }
}
