import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/framework/utils"
import { AllocationOutboxStatus } from "../../../types"
import {
  ActivateAllocationOutboxCommand,
  AllocationCommandError,
  AllocationCommandErrorCode,
  ClaimedAllocationOutboxEvent,
  AllocationOutboxMutationResult,
  AllocationOutboxStore,
  ClaimAllocationOutboxEventsCommand,
  ClaimAllocationOutboxEventsResult,
  FailAllocationOutboxEventCommand,
  MarkAllocationOutboxPublishedCommand,
  RedriveAllocationOutboxEventCommand,
} from "../application"

type OutboxRow = Omit<
  ClaimedAllocationOutboxEvent,
  | "schema_version"
  | "aggregate_version"
  | "attempt_count"
  | "max_attempts"
  | "lease_epoch"
  | "published_lease_epoch"
  | "redrive_count"
  | "available_at"
  | "occurred_at"
  | "published_at"
  | "lease_until"
  | "dead_lettered_at"
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

const OUTBOX_COLUMNS = `id, event_name, schema_version, aggregate_type,
  aggregate_id, aggregate_version, event_hash, payload, status, available_at,
  occurred_at, published_at, attempt_count, max_attempts, lease_owner,
  lease_until, lease_epoch, published_by, published_lease_epoch,
  last_error_code, dead_lettered_at, redrive_count`

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value)
}

function mapOutbox(row: OutboxRow): ClaimedAllocationOutboxEvent {
  return {
    ...row,
    schema_version: Number(row.schema_version),
    aggregate_version: Number(row.aggregate_version),
    payload:
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as Record<string, unknown>)
        : row.payload,
    available_at: date(row.available_at),
    occurred_at: date(row.occurred_at),
    published_at: nullableDate(row.published_at),
    attempt_count: Number(row.attempt_count),
    max_attempts:
      row.max_attempts === null ? null : Number(row.max_attempts),
    lease_until: nullableDate(row.lease_until),
    lease_epoch: Number(row.lease_epoch),
    published_lease_epoch:
      row.published_lease_epoch === null
        ? null
        : Number(row.published_lease_epoch),
    dead_lettered_at: nullableDate(row.dead_lettered_at),
    redrive_count: Number(row.redrive_count),
  }
}

export class PostgresAllocationOutboxStore implements AllocationOutboxStore {
  constructor(private readonly baseRepository: DAL.RepositoryService) {}

  async activateOutboxRequired(_input: ActivateAllocationOutboxCommand) {
    return await this.transaction(async (manager) => {
      const inserted = (await manager.execute(
        `insert into flash_sale_allocation_outbox_control
          (id, required_after)
         values (?, clock_timestamp())
         on conflict (id) do nothing
         returning required_after`,
        ["allocation-outbox-required"]
      )) as Array<{ required_after: Date | string }>
      if (inserted[0]) {
        return { required_after: date(inserted[0].required_after), replayed: false }
      }
      const rows = (await manager.execute(
        `select required_after from flash_sale_allocation_outbox_control
          where id = ? and deleted_at is null for update`,
        ["allocation-outbox-required"]
      )) as Array<{ required_after: Date | string }>
      if (!rows[0]) {
        throw this.invariant("Allocation outbox activation watermark disappeared")
      }
      return { required_after: date(rows[0].required_after), replayed: true }
    })
  }

  async claimOutboxEvents(
    input: ClaimAllocationOutboxEventsCommand
  ): Promise<ClaimAllocationOutboxEventsResult> {
    return await this.transaction(async (manager) => {
      const candidates = (await manager.execute(
        `select ${OUTBOX_COLUMNS}
           from flash_sale_allocation_outbox_event candidate
          where candidate.deleted_at is null
            and ((candidate.status = ? and candidate.available_at <= clock_timestamp())
              or (candidate.status = ? and candidate.lease_until <= clock_timestamp()))
            and not exists (
              select 1 from flash_sale_allocation_outbox_event prior
               where prior.deleted_at is null
                 and prior.aggregate_type = candidate.aggregate_type
                 and prior.aggregate_id = candidate.aggregate_id
                 and prior.aggregate_version < candidate.aggregate_version
                 and prior.status <> ?)
          order by candidate.available_at, candidate.occurred_at, candidate.id
          limit ? for update skip locked`,
        [
          AllocationOutboxStatus.PENDING,
          AllocationOutboxStatus.PUBLISHING,
          AllocationOutboxStatus.PUBLISHED,
          input.limit,
        ]
      )) as OutboxRow[]
      if (candidates.length === 0) return { events: [] }

      const now = await this.databaseNow(manager)
      const claimed: ClaimedAllocationOutboxEvent[] = []
      for (const candidate of candidates) {
        if (claimed.length >= input.limit) break
        const current = mapOutbox(candidate)
        const eligible =
          (current.status === AllocationOutboxStatus.PENDING &&
            current.available_at.getTime() <= now.getTime()) ||
          (current.status === AllocationOutboxStatus.PUBLISHING &&
            current.lease_until !== null &&
            current.lease_until.getTime() <= now.getTime())
        if (!eligible) continue
        if (
          current.max_attempts !== null &&
          current.max_attempts !== input.max_attempts
        ) {
          throw this.invariant("Outbox max_attempts changed after first claim")
        }
        const maxAttempts = current.max_attempts ?? input.max_attempts
        if (current.attempt_count >= maxAttempts) {
          await manager.execute(
            `update flash_sale_allocation_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    dead_lettered_at = ?::timestamptz,
                    last_error_code = ?, updated_at = ?::timestamptz
              where id = ? and status = ? and lease_epoch = ?`,
            [
              AllocationOutboxStatus.DEAD_LETTER,
              now,
              "DELIVERY_ATTEMPTS_EXHAUSTED",
              now,
              current.id,
              current.status,
              current.lease_epoch,
            ]
          )
          continue
        }
        const rows = (await manager.execute(
          `update flash_sale_allocation_outbox_event
              set status = ?, lease_owner = ?,
                  lease_until = ?::timestamptz + (? * interval '1 second'),
                  lease_epoch = lease_epoch + 1,
                  attempt_count = attempt_count + 1,
                  max_attempts = coalesce(max_attempts, ?),
                  last_error_code = null, updated_at = ?::timestamptz
            where id = ? and status = ? and lease_epoch = ?
            returning ${OUTBOX_COLUMNS}`,
          [
            AllocationOutboxStatus.PUBLISHING,
            input.worker_id,
            now,
            input.lease_seconds,
            input.max_attempts,
            now,
            current.id,
            current.status,
            current.lease_epoch,
          ]
        )) as OutboxRow[]
        if (!rows[0]) throw this.invariant("Outbox claim CAS failed while locked")
        claimed.push(mapOutbox(rows[0]))
      }
      return { events: claimed }
    })
  }

  async markOutboxPublished(
    input: MarkAllocationOutboxPublishedCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lockEvent(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = mapOutbox(row)
      if (current.status === AllocationOutboxStatus.PUBLISHED) {
        return current.published_by === input.worker_id &&
          current.published_lease_epoch === input.lease_epoch
          ? { disposition: "published", event: current }
          : { disposition: "fenced", event: null }
      }
      const now = await this.databaseNow(manager)
      if (!this.isActiveOwner(current, input.worker_id, input.lease_epoch, now)) {
        return { disposition: "fenced", event: null }
      }
      const rows = (await manager.execute(
        `update flash_sale_allocation_outbox_event
            set status = ?, published_at = ?::timestamptz,
                published_by = ?, published_lease_epoch = ?,
                lease_owner = null, lease_until = null,
                last_error_code = null, updated_at = ?::timestamptz
          where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
          returning ${OUTBOX_COLUMNS}`,
        [
          AllocationOutboxStatus.PUBLISHED,
          now,
          input.worker_id,
          input.lease_epoch,
          now,
          current.id,
          AllocationOutboxStatus.PUBLISHING,
          input.worker_id,
          input.lease_epoch,
        ]
      )) as OutboxRow[]
      if (!rows[0]) return { disposition: "fenced", event: null }
      return { disposition: "published", event: mapOutbox(rows[0]) }
    })
  }

  async failOutboxEvent(
    input: FailAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lockEvent(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = mapOutbox(row)
      const now = await this.databaseNow(manager)
      if (!this.isActiveOwner(current, input.worker_id, input.lease_epoch, now)) {
        return { disposition: "fenced", event: null }
      }
      const dead =
        input.permanent ||
        (current.max_attempts !== null &&
          current.attempt_count >= current.max_attempts)
      const rows = (await manager.execute(
        dead
          ? `update flash_sale_allocation_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    dead_lettered_at = ?::timestamptz,
                    last_error_code = ?, updated_at = ?::timestamptz
              where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
              returning ${OUTBOX_COLUMNS}`
          : `update flash_sale_allocation_outbox_event
                set status = ?, lease_owner = null, lease_until = null,
                    available_at = ?::timestamptz + (? * interval '1 second'),
                    last_error_code = ?, updated_at = ?::timestamptz
              where id = ? and status = ? and lease_owner = ? and lease_epoch = ?
              returning ${OUTBOX_COLUMNS}`,
        dead
          ? [
              AllocationOutboxStatus.DEAD_LETTER,
              now,
              input.error_code,
              now,
              current.id,
              AllocationOutboxStatus.PUBLISHING,
              input.worker_id,
              input.lease_epoch,
            ]
          : [
              AllocationOutboxStatus.PENDING,
              now,
              input.retry_after_seconds,
              input.error_code,
              now,
              current.id,
              AllocationOutboxStatus.PUBLISHING,
              input.worker_id,
              input.lease_epoch,
            ]
      )) as OutboxRow[]
      if (!rows[0]) return { disposition: "fenced", event: null }
      return {
        disposition: dead ? "dead_lettered" : "retried",
        event: mapOutbox(rows[0]),
      }
    })
  }

  async redriveOutboxEvent(
    input: RedriveAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.transaction(async (manager) => {
      const row = await this.lockEvent(manager, input.event_id)
      if (!row) throw this.notFound()
      const current = mapOutbox(row)
      if (current.event_hash !== input.event_hash) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.OUTBOX_STATE_CONFLICT,
          "Outbox event hash does not match redrive command"
        )
      }
      if (current.status !== AllocationOutboxStatus.DEAD_LETTER) {
        throw new AllocationCommandError(
          AllocationCommandErrorCode.OUTBOX_STATE_CONFLICT,
          `Outbox event cannot be redriven from ${current.status}`
        )
      }
      const now = await this.databaseNow(manager)
      const rows = (await manager.execute(
        `update flash_sale_allocation_outbox_event
            set status = ?, available_at = ?::timestamptz,
                dead_lettered_at = null, last_error_code = null,
                attempt_count = 0, max_attempts = null,
                redrive_count = redrive_count + 1,
                updated_at = ?::timestamptz
          where id = ? and status = ? and event_hash = ?
          returning ${OUTBOX_COLUMNS}`,
        [
          AllocationOutboxStatus.PENDING,
          now,
          now,
          current.id,
          AllocationOutboxStatus.DEAD_LETTER,
          input.event_hash,
        ]
      )) as OutboxRow[]
      if (!rows[0]) throw this.invariant("Outbox redrive CAS failed while locked")
      return { disposition: "redriven", event: mapOutbox(rows[0]) }
    })
  }

  private async lockEvent(manager: SqlEntityManager, eventId: string) {
    const rows = (await manager.execute(
      `select ${OUTBOX_COLUMNS} from flash_sale_allocation_outbox_event
        where id = ? and deleted_at is null for update`,
      [eventId]
    )) as OutboxRow[]
    return rows[0]
  }

  private isActiveOwner(
    event: ClaimedAllocationOutboxEvent,
    workerId: string,
    leaseEpoch: number,
    now: Date
  ): boolean {
    return (
      event.status === AllocationOutboxStatus.PUBLISHING &&
      event.lease_owner === workerId &&
      event.lease_epoch === leaseEpoch &&
      event.lease_until !== null &&
      event.lease_until.getTime() > now.getTime()
    )
  }

  private async databaseNow(manager: SqlEntityManager): Promise<Date> {
    const rows = (await manager.execute(
      "select clock_timestamp() as fresh_now"
    )) as Array<{ fresh_now: Date | string }>
    return date(rows[0].fresh_now)
  }

  private async transaction<T>(
    operation: (manager: SqlEntityManager) => Promise<T>
  ): Promise<T> {
    return await this.baseRepository.transaction<SqlEntityManager>(
      async (manager) => {
        await manager.execute("set local transaction isolation level read committed")
        await manager.execute("set local lock_timeout = '3s'")
        return await operation(manager)
      }
    )
  }

  private notFound() {
    return new AllocationCommandError(
      AllocationCommandErrorCode.OUTBOX_EVENT_NOT_FOUND,
      "Allocation outbox event does not exist"
    )
  }

  private invariant(message: string) {
    return new AllocationCommandError(
      AllocationCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
      message
    )
  }
}
