import { createHash } from "crypto"
import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import type { DAL } from "@medusajs/framework/types"
import { MedusaService } from "@medusajs/framework/utils"
import {
  AllocationEventWireEnvelope,
  validateAllocationEventWireEnvelope,
} from "../../../../src/shared"
import {
  AllocationEventProbeCursor,
  AllocationEventProbeEffect,
  AllocationEventProbeInbox,
} from "./models"

export const ALLOCATION_EVENT_PROBE_MODULE = "allocationEventProbe"
export const ALLOCATION_EVENT_PROBE_CONSUMER = "allocation-event-probe-v1"

export class AllocationEventProbeError extends Error {
  constructor(
    readonly code:
      | "EVENT_DRIFT"
      | "AGGREGATE_VERSION_CONFLICT"
      | "VERSION_GAP"
      | "STALE_UNKNOWN_EVENT",
    message: string
  ) {
    super(message)
    this.name = "AllocationEventProbeError"
  }
}

type ProbeFailpoint =
  | "after_inbox_insert"
  | "after_effect_before_commit"
  | null

// The probe is test-only and process-local. Keeping the deterministic crash
// switch outside the Medusa service avoids generated service decorators
// copying an instance without its private test field.
let probeFailpoint: ProbeFailpoint = null

class AllocationEventProbeCrash extends Error {
  constructor(name: Exclude<ProbeFailpoint, null>) {
    super(`Allocation event probe failpoint: ${name}`)
    this.name = "AllocationEventProbeCrash"
  }
}

type InboxRow = {
  event_id: string
  event_name: string
  event_hash: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number | string
  occurred_at: Date | string
  delivery_count: number | string
}

type InjectedDependencies = { baseRepository: DAL.RepositoryService }

export default class AllocationEventProbeModuleService extends MedusaService({
  AllocationEventProbeCursor,
  AllocationEventProbeEffect,
  AllocationEventProbeInbox,
}) {
  constructor(private readonly dependencies_: InjectedDependencies) {
    super(...arguments)
  }

  async setProbeFailpoint(failpoint: ProbeFailpoint): Promise<void> {
    probeFailpoint = failpoint
  }

  async applyAllocationEvent(
    eventName: string,
    envelope: AllocationEventWireEnvelope
  ): Promise<{ replayed: boolean; delivery_count: number }> {
    validateAllocationEventWireEnvelope(envelope)
    if (eventName !== envelope.event_name) {
      throw new AllocationEventProbeError(
        "EVENT_DRIFT",
        "Outer event name differs from the immutable envelope"
      )
    }
    return await this.dependencies_.baseRepository.transaction<SqlEntityManager>(
      async (manager) => {
        await manager.execute(
          "set local transaction isolation level read committed"
        )
        const now = await this.databaseNow(manager)
        const cursorId = createHash("sha256")
          .update(
            `${ALLOCATION_EVENT_PROBE_CONSUMER}\u0000${envelope.aggregate_type}\u0000${envelope.aggregate_id}`
          )
          .digest("hex")
        await manager.execute(
          `insert into flash_sale_test_allocation_event_cursor
            (id, consumer_id, aggregate_type, aggregate_id, last_version,
             effect_count, created_at, updated_at)
           values (?, ?, ?, ?, 1, 0, ?::timestamptz, ?::timestamptz)
           on conflict (consumer_id, aggregate_type, aggregate_id) do nothing`,
          [
            cursorId,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.aggregate_type,
            envelope.aggregate_id,
            now,
            now,
          ]
        )
        const cursors = (await manager.execute(
          `select last_version, last_event_id, last_event_hash, effect_count
             from flash_sale_test_allocation_event_cursor
            where consumer_id = ? and aggregate_type = ? and aggregate_id = ?
            for update`,
          [
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.aggregate_type,
            envelope.aggregate_id,
          ]
        )) as Array<{
          last_version: number | string
          last_event_id: string | null
          last_event_hash: string | null
          effect_count: number | string
        }>
        const existing = (await manager.execute(
          `select event_id, event_name, event_hash, aggregate_type, aggregate_id,
                  aggregate_version, occurred_at, delivery_count
             from flash_sale_test_allocation_event_inbox
            where consumer_id = ? and event_id = ? for update`,
          [ALLOCATION_EVENT_PROBE_CONSUMER, envelope.event_id]
        )) as InboxRow[]
        if (existing[0]) {
          this.assertExact(existing[0], envelope)
          const rows = (await manager.execute(
            `update flash_sale_test_allocation_event_inbox
                set delivery_count = delivery_count + 1,
                    last_received_at = ?::timestamptz,
                    updated_at = ?::timestamptz
              where consumer_id = ? and event_id = ?
              returning delivery_count`,
            [
              now,
              now,
              ALLOCATION_EVENT_PROBE_CONSUMER,
              envelope.event_id,
            ]
          )) as Array<{ delivery_count: number | string }>
          return { replayed: true, delivery_count: Number(rows[0].delivery_count) }
        }
        const versionOwner = (await manager.execute(
          `select event_id from flash_sale_test_allocation_event_inbox
            where consumer_id = ? and aggregate_type = ? and aggregate_id = ?
              and aggregate_version = ?`,
          [
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.aggregate_type,
            envelope.aggregate_id,
            envelope.aggregate_version,
          ]
        )) as Array<{ event_id: string }>
        if (versionOwner[0]) {
          throw new AllocationEventProbeError(
            "AGGREGATE_VERSION_CONFLICT",
            "Aggregate version already belongs to another event"
          )
        }
        const lastVersion = Number(cursors[0].last_version)
        if (envelope.aggregate_version > lastVersion + 1) {
          throw new AllocationEventProbeError(
            "VERSION_GAP",
            "Allocation event arrived with a version gap"
          )
        }
        if (envelope.aggregate_version <= lastVersion) {
          throw new AllocationEventProbeError(
            "STALE_UNKNOWN_EVENT",
            "Unknown stale allocation event cannot be applied"
          )
        }
        const inboxId = `fsprobein_${envelope.event_id}`.slice(0, 255)
        await manager.execute(
          `insert into flash_sale_test_allocation_event_inbox
            (id, consumer_id, event_id, event_name, event_hash, aggregate_type,
             aggregate_id, aggregate_version, occurred_at, payload,
             delivery_count, first_received_at, last_received_at, processed_at,
             created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::jsonb, 1,
                   ?::timestamptz, ?::timestamptz, ?::timestamptz,
                   ?::timestamptz, ?::timestamptz)`,
          [
            inboxId,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.event_id,
            envelope.event_name,
            envelope.event_hash,
            envelope.aggregate_type,
            envelope.aggregate_id,
            envelope.aggregate_version,
            envelope.occurred_at,
            JSON.stringify(envelope.payload),
            now,
            now,
            now,
            now,
            now,
          ]
        )
        this.trip("after_inbox_insert")
        await manager.execute(
          `insert into flash_sale_test_allocation_event_effect
            (id, consumer_id, event_id, event_hash, aggregate_type, aggregate_id,
             aggregate_version, effect_name, applied_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz,
                   ?::timestamptz, ?::timestamptz)`,
          [
            `fsprobeef_${envelope.event_id}`.slice(0, 255),
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.event_id,
            envelope.event_hash,
            envelope.aggregate_type,
            envelope.aggregate_id,
            envelope.aggregate_version,
            envelope.event_name,
            now,
            now,
            now,
          ]
        )
        await manager.execute(
          `update flash_sale_test_allocation_event_cursor
              set last_version = ?, last_event_id = ?, last_event_hash = ?,
                  effect_count = effect_count + 1,
                  updated_at = ?::timestamptz
            where consumer_id = ? and aggregate_type = ? and aggregate_id = ?`,
          [
            envelope.aggregate_version,
            envelope.event_id,
            envelope.event_hash,
            now,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            envelope.aggregate_type,
            envelope.aggregate_id,
          ]
        )
        this.trip("after_effect_before_commit")
        return { replayed: false, delivery_count: 1 }
      }
    )
  }

  private assertExact(row: InboxRow, envelope: AllocationEventWireEnvelope) {
    if (
      row.event_name !== envelope.event_name ||
      row.event_hash !== envelope.event_hash ||
      row.aggregate_type !== envelope.aggregate_type ||
      row.aggregate_id !== envelope.aggregate_id ||
      Number(row.aggregate_version) !== envelope.aggregate_version ||
      new Date(row.occurred_at).toISOString() !== envelope.occurred_at
    ) {
      throw new AllocationEventProbeError(
        "EVENT_DRIFT",
        "Duplicate allocation event changed immutable fields"
      )
    }
  }

  private trip(name: Exclude<ProbeFailpoint, null>) {
    if (probeFailpoint !== name) return
    probeFailpoint = null
    throw new AllocationEventProbeCrash(name)
  }

  private async databaseNow(manager: SqlEntityManager) {
    const rows = (await manager.execute(
      "select clock_timestamp() as fresh_now"
    )) as Array<{ fresh_now: Date | string }>
    return new Date(rows[0].fresh_now)
  }
}
