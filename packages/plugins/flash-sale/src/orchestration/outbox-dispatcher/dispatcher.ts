export type ClaimedOutboxEvent = Readonly<{
  id: string
  event_name: string
  schema_version: number
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number
  event_hash: string
  payload: Record<string, unknown>
  occurred_at: Date
  lease_epoch: number
}>

export interface OutboxLanePort<E extends ClaimedOutboxEvent> {
  claim(command: {
    worker_id: string
    limit: number
    lease_seconds: number
    max_attempts: number
  }): Promise<{ events: readonly E[] }>
  mark(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
  }): Promise<{ disposition: string }>
  fail(command: {
    event_id: string
    worker_id: string
    lease_epoch: number
    retry_after_seconds: number
    error_code: string
    permanent: boolean
  }): Promise<{ disposition: string }>
}

export interface OutboxTransport<W> {
  assertReady(manifest: Readonly<Record<string, readonly string[]>>): void
  publish(wire: W): Promise<{ accepted: true; provider: "medusa-redis-event-bus" }>
}

export type OutboxLaneConfig = Readonly<{
  concurrency: number
  lease_seconds: number
  max_attempts: number
  retry_after_seconds: number
  mark_timeout_ms: number
  subscriber_manifest: Readonly<Record<string, readonly string[]>>
}>

export type OutboxLaneResult = Readonly<{
  skipped: boolean
  skip_reason: "overlap" | null
  claimed: number
  accepted: number
  published: number
  retry_scheduled: number
  dead_lettered: number
  fenced: number
  ambiguous: number
  invalid: number
}>

type Outcome =
  | "published" | "retry_scheduled" | "dead_lettered"
  | "accepted_fenced" | "failure_fenced"
  | "accepted_ambiguous" | "failure_ambiguous" | "invalid"

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mark deadline exceeded")), milliseconds)
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

export class OutboxLaneDispatcher<E extends ClaimedOutboxEvent, W> {
  private running = false

  constructor(
    private readonly port: OutboxLanePort<E>,
    private readonly transport: OutboxTransport<W>,
    private readonly normalize: (event: E) => W,
    private readonly config: OutboxLaneConfig,
    private readonly workerId: string,
    private readonly afterAccepted?: (event: E) => Promise<void> | void
  ) {}

  assertReady() {
    this.transport.assertReady(this.config.subscriber_manifest)
  }

  async runTick(limit = this.config.concurrency, preflight = true): Promise<OutboxLaneResult> {
    if (this.running) return this.empty(true, "overlap")
    this.running = true
    try {
      if (preflight) this.assertReady()
      const claimed = await this.port.claim({
        worker_id: this.workerId,
        limit: Math.min(limit, this.config.concurrency),
        lease_seconds: this.config.lease_seconds,
        max_attempts: this.config.max_attempts,
      })
      const settled = await Promise.allSettled(
        claimed.events.map((event) => this.dispatch(event))
      )
      const outcomes = settled.map((item): Outcome =>
        item.status === "fulfilled" ? item.value : "failure_ambiguous"
      )
      return {
        skipped: false,
        skip_reason: null,
        claimed: claimed.events.length,
        accepted: outcomes.filter((value) =>
          ["published", "accepted_fenced", "accepted_ambiguous"].includes(value)
        ).length,
        published: outcomes.filter((value) => value === "published").length,
        retry_scheduled: outcomes.filter((value) => value === "retry_scheduled").length,
        dead_lettered: outcomes.filter((value) => value === "dead_lettered").length,
        fenced: outcomes.filter((value) => value.endsWith("_fenced")).length,
        ambiguous: outcomes.filter((value) => value.endsWith("_ambiguous")).length,
        invalid: outcomes.filter((value) => value === "invalid").length,
      }
    } finally {
      this.running = false
    }
  }

  private async dispatch(event: E): Promise<Outcome> {
    let wire: W
    try {
      wire = this.normalize(event)
    } catch {
      return await this.fail(event, "OUTBOX_ENVELOPE_INVALID", true)
    }
    try {
      const receipt = await this.transport.publish(wire)
      if (receipt.accepted !== true || receipt.provider !== "medusa-redis-event-bus") {
        return await this.fail(event, "EVENT_BUS_ACCEPTANCE_INVALID", false)
      }
    } catch {
      return await this.fail(event, "EVENT_BUS_ACCEPTANCE_FAILED", false)
    }
    try {
      await this.afterAccepted?.(event)
    } catch {
      return "accepted_ambiguous"
    }
    try {
      const marked = await deadline(this.port.mark({
        event_id: event.id,
        worker_id: this.workerId,
        lease_epoch: event.lease_epoch,
      }), this.config.mark_timeout_ms)
      return marked.disposition === "published" ? "published" : "accepted_fenced"
    } catch {
      return "accepted_ambiguous"
    }
  }

  private async fail(event: E, error_code: string, permanent: boolean): Promise<Outcome> {
    try {
      const result = await deadline(this.port.fail({
        event_id: event.id,
        worker_id: this.workerId,
        lease_epoch: event.lease_epoch,
        retry_after_seconds: this.config.retry_after_seconds,
        error_code,
        permanent,
      }), this.config.mark_timeout_ms)
      if (result.disposition === "fenced") return "failure_fenced"
      if (result.disposition === "dead_lettered") return "dead_lettered"
      return permanent ? "invalid" : "retry_scheduled"
    } catch {
      return "failure_ambiguous"
    }
  }

  private empty(skipped: boolean, skip_reason: "overlap"): OutboxLaneResult {
    return { skipped, skip_reason, claimed: 0, accepted: 0, published: 0,
      retry_scheduled: 0, dead_lettered: 0, fenced: 0, ambiguous: 0, invalid: 0 }
  }
}
