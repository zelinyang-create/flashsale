import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import type { DAL } from "@medusajs/framework/types"
import { CheckoutOutboxStatus } from "../../../types"
import {
  ActivateCheckoutOutboxCommand,
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutOutboxMutationResult,
  CheckoutOutboxStore,
  ClaimedCheckoutOutboxEvent,
  ClaimCheckoutOutboxEventsCommand,
  ClaimCheckoutOutboxEventsResult,
  FailCheckoutOutboxEventCommand,
  MarkCheckoutOutboxPublishedCommand,
  RedriveCheckoutOutboxEventCommand,
} from "../domain"

type Row = Omit<
  ClaimedCheckoutOutboxEvent,
  | "schema_version" | "aggregate_version" | "attempt_count"
  | "max_attempts" | "lease_epoch" | "published_lease_epoch"
  | "redrive_count" | "available_at" | "occurred_at" | "published_at"
  | "lease_until" | "dead_lettered_at"
> & {
  schema_version: number | string
  aggregate_version: number | string
  attempt_count: number | string
  max_attempts: number | string | null
  lease_epoch: number | string
  published_lease_epoch: number | string | null
  redrive_count: number | string
  available_at: Date | string
  occurred_at: Date | string
  published_at: Date | string | null
  lease_until: Date | string | null
  dead_lettered_at: Date | string | null
  payload: Record<string, unknown> | string
}

const COLUMNS = `id, event_name, schema_version, aggregate_type, aggregate_id,
  aggregate_version, event_hash, payload, status, available_at, occurred_at,
  published_at, attempt_count, max_attempts, lease_owner, lease_until,
  lease_epoch, published_by, published_lease_epoch, last_error_code,
  dead_lettered_at, redrive_count`

const date = (value: Date | string) =>
  value instanceof Date ? value : new Date(value)
const nullableDate = (value: Date | string | null) =>
  value === null ? null : date(value)

function map(row: Row): ClaimedCheckoutOutboxEvent {
  return {
    ...row,
    schema_version: Number(row.schema_version),
    aggregate_version: Number(row.aggregate_version),
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    available_at: date(row.available_at),
    occurred_at: date(row.occurred_at),
    published_at: nullableDate(row.published_at),
    attempt_count: Number(row.attempt_count),
    max_attempts: row.max_attempts === null ? null : Number(row.max_attempts),
    lease_until: nullableDate(row.lease_until),
    lease_epoch: Number(row.lease_epoch),
    published_lease_epoch:
      row.published_lease_epoch === null ? null : Number(row.published_lease_epoch),
    dead_lettered_at: nullableDate(row.dead_lettered_at),
    redrive_count: Number(row.redrive_count),
  }
}

export class PostgresCheckoutOutboxStore implements CheckoutOutboxStore {
  constructor(private readonly baseRepository: DAL.RepositoryService) {}

  async activateOutboxRequired(_input: ActivateCheckoutOutboxCommand) {
    return await this.transaction(async (manager) => {
      const inserted = (await manager.execute(
        `insert into flash_sale_checkout_outbox_control (id, required_after)
         values (?, clock_timestamp()) on conflict (id) do nothing
         returning required_after`,
        ["checkout-outbox-required"]
      )) as Array<{ required_after: Date | string }>
      if (inserted[0]) {
        return { required_after: date(inserted[0].required_after), replayed: false }
      }
      const rows = (await manager.execute(
        `select required_after from flash_sale_checkout_outbox_control
          where id = ? and deleted_at is null for update`,
        ["checkout-outbox-required"]
      )) as Array<{ required_after: Date | string }>
      if (!rows[0]) throw this.invariant("Checkout outbox watermark disappeared")
      return { required_after: date(rows[0].required_after), replayed: true }
    })
  }

  async claimOutboxEvents(
    input: ClaimCheckoutOutboxEventsCommand
  ): Promise<ClaimCheckoutOutboxEventsResult> {
    return await this.transaction(async (manager) => {
      const candidates = (await manager.execute(
        `select ${COLUMNS} from flash_sale_checkout_outbox_event candidate
          where candidate.deleted_at is null
            and ((candidate.status = ? and candidate.available_at <= clock_timestamp())
              or (candidate.status = ? and candidate.lease_until <= clock_timestamp()))
            and not exists (
              select 1 from flash_sale_checkout_outbox_event prior
               where prior.deleted_at is null
                 and prior.aggregate_type = candidate.aggregate_type
                 and prior.aggregate_id = candidate.aggregate_id
                 and prior.aggregate_version < candidate.aggregate_version
                 and prior.status <> ?)
          order by candidate.available_at, candidate.occurred_at, candidate.id
          limit ? for update skip locked`,
        [CheckoutOutboxStatus.PENDING, CheckoutOutboxStatus.PUBLISHING,
          CheckoutOutboxStatus.PUBLISHED, input.limit]
      )) as Row[]
      if (!candidates.length) return { events: [] }
      const now = await this.now(manager)
      const events: ClaimedCheckoutOutboxEvent[] = []
      for (const row of candidates) {
        const current = map(row)
        const eligible =
          (current.status === CheckoutOutboxStatus.PENDING &&
            current.available_at.getTime() <= now.getTime()) ||
          (current.status === CheckoutOutboxStatus.PUBLISHING &&
            !!current.lease_until && current.lease_until.getTime() <= now.getTime())
        if (!eligible) continue
        if (current.max_attempts !== null && current.max_attempts !== input.max_attempts) {
          throw this.invariant("Checkout outbox max_attempts changed after first claim")
        }
        const max = current.max_attempts ?? input.max_attempts
        if (current.attempt_count >= max) {
          await manager.execute(
            `update flash_sale_checkout_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    dead_lettered_at = ?::timestamptz,
                    last_error_code = ?, updated_at = ?::timestamptz
              where id = ? and status = ? and lease_epoch = ?`,
            [CheckoutOutboxStatus.DEAD_LETTER, now,
              "DELIVERY_ATTEMPTS_EXHAUSTED", now, current.id,
              current.status, current.lease_epoch]
          )
          continue
        }
        const claimed = (await manager.execute(
          `update flash_sale_checkout_outbox_event
              set status = ?, lease_owner = ?,
                  lease_until = ?::timestamptz + (? * interval '1 second'),
                  lease_epoch = lease_epoch + 1,
                  attempt_count = attempt_count + 1,
                  max_attempts = coalesce(max_attempts, ?),
                  last_error_code = null, updated_at = ?::timestamptz
            where id = ? and status = ? and lease_epoch = ?
            returning ${COLUMNS}`,
          [CheckoutOutboxStatus.PUBLISHING, input.worker_id, now,
            input.lease_seconds, input.max_attempts, now, current.id,
            current.status, current.lease_epoch]
        )) as Row[]
        if (!claimed[0]) throw this.invariant("Checkout outbox claim CAS failed")
        events.push(map(claimed[0]))
      }
      return { events }
    })
  }

  async markOutboxPublished(
    input: MarkCheckoutOutboxPublishedCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lock(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = map(row)
      if (current.status === CheckoutOutboxStatus.PUBLISHED) {
        return current.published_by === input.worker_id &&
          current.published_lease_epoch === input.lease_epoch
          ? { disposition: "published", event: current }
          : { disposition: "fenced", event: null }
      }
      const now = await this.now(manager)
      if (!this.owner(current, input.worker_id, input.lease_epoch, now)) {
        return { disposition: "fenced", event: null }
      }
      const rows = (await manager.execute(
        `update flash_sale_checkout_outbox_event
            set status = ?, published_at = ?::timestamptz,
                published_by = ?, published_lease_epoch = ?,
                lease_owner = null, lease_until = null, last_error_code = null,
                updated_at = ?::timestamptz
          where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
          returning ${COLUMNS}`,
        [CheckoutOutboxStatus.PUBLISHED, now, input.worker_id,
          input.lease_epoch, now, current.id, CheckoutOutboxStatus.PUBLISHING,
          input.worker_id, input.lease_epoch]
      )) as Row[]
      return rows[0]
        ? { disposition: "published", event: map(rows[0]) }
        : { disposition: "fenced", event: null }
    })
  }

  async failOutboxEvent(
    input: FailCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lock(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = map(row)
      const now = await this.now(manager)
      if (!this.owner(current, input.worker_id, input.lease_epoch, now)) {
        return { disposition: "fenced", event: null }
      }
      const dead = input.permanent ||
        (current.max_attempts !== null && current.attempt_count >= current.max_attempts)
      const rows = (await manager.execute(
        dead
          ? `update flash_sale_checkout_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    dead_lettered_at = ?::timestamptz, last_error_code = ?,
                    updated_at = ?::timestamptz
              where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
              returning ${COLUMNS}`
          : `update flash_sale_checkout_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    available_at = ?::timestamptz + (? * interval '1 second'),
                    last_error_code = ?, updated_at = ?::timestamptz
              where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
              returning ${COLUMNS}`,
        dead
          ? [CheckoutOutboxStatus.DEAD_LETTER, now, input.error_code, now,
              current.id, CheckoutOutboxStatus.PUBLISHING, input.worker_id,
              input.lease_epoch]
          : [CheckoutOutboxStatus.PENDING, now, input.retry_after_seconds,
              input.error_code, now, current.id, CheckoutOutboxStatus.PUBLISHING,
              input.worker_id, input.lease_epoch]
      )) as Row[]
      if (!rows[0]) return { disposition: "fenced", event: null }
      return { disposition: dead ? "dead_lettered" : "retried", event: map(rows[0]) }
    })
  }

  async redriveOutboxEvent(
    input: RedriveCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lock(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = map(row)
      if (current.event_hash !== input.event_hash ||
          current.status !== CheckoutOutboxStatus.DEAD_LETTER) {
        throw new CheckoutCommandError(
          CheckoutCommandErrorCode.OUTBOX_STATE_CONFLICT,
          "Checkout outbox event cannot be redriven"
        )
      }
      const now = await this.now(manager)
      const rows = (await manager.execute(
        `update flash_sale_checkout_outbox_event
            set status = ?, available_at = ?::timestamptz,
                dead_lettered_at = null, last_error_code = null,
                attempt_count = 0, max_attempts = null,
                redrive_count = redrive_count + 1,
                updated_at = ?::timestamptz
          where id = ? and status = ? and event_hash = ?
          returning ${COLUMNS}`,
        [CheckoutOutboxStatus.PENDING, now, now, current.id,
          CheckoutOutboxStatus.DEAD_LETTER, input.event_hash]
      )) as Row[]
      if (!rows[0]) throw this.invariant("Checkout outbox redrive CAS failed")
      return { disposition: "redriven", event: map(rows[0]) }
    })
  }

  private async lock(manager: SqlEntityManager, id: string) {
    const rows = (await manager.execute(
      `select ${COLUMNS} from flash_sale_checkout_outbox_event
        where id = ? and deleted_at is null for update`, [id]
    )) as Row[]
    return rows[0]
  }

  private owner(
    event: ClaimedCheckoutOutboxEvent,
    worker: string,
    epoch: number,
    now: Date
  ) {
    return event.status === CheckoutOutboxStatus.PUBLISHING &&
      event.lease_owner === worker && event.lease_epoch === epoch &&
      !!event.lease_until && event.lease_until.getTime() > now.getTime()
  }

  private async now(manager: SqlEntityManager) {
    const rows = (await manager.execute(
      "select clock_timestamp() as fresh_now"
    )) as Array<{ fresh_now: Date | string }>
    return date(rows[0].fresh_now)
  }

  private async transaction<T>(operation: (manager: SqlEntityManager) => Promise<T>) {
    return await this.baseRepository.transaction<SqlEntityManager>(async (manager) => {
      await manager.execute("set local transaction isolation level read committed")
      await manager.execute("set local lock_timeout = '3s'")
      return await operation(manager)
    })
  }

  private notFound() {
    return new CheckoutCommandError(
      CheckoutCommandErrorCode.OUTBOX_EVENT_NOT_FOUND,
      "Checkout outbox event does not exist"
    )
  }

  private invariant(message: string) {
    return new CheckoutCommandError(
      CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
      message
    )
  }
}
