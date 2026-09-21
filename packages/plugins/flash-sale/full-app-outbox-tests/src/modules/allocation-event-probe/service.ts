import { createHash } from "crypto"
import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import type { DAL } from "@medusajs/framework/types"
import { MedusaService } from "@medusajs/framework/utils"
import {
  AllocationEventWireEnvelope,
  CheckoutEventWireEnvelope,
  ALLOCATION_OUTBOX_EVENT_NAMES,
  CHECKOUT_OUTBOX_EVENT_NAMES,
  canonicalJson,
  normalizeAllocationEventWireEnvelope,
  normalizeCheckoutEventWireEnvelope,
  CHECKOUT_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_OUTBOX_AGGREGATE_TYPE,
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
  source_module: string
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
    envelope: AllocationEventWireEnvelope | CheckoutEventWireEnvelope
  ): Promise<{ replayed: boolean; delivery_count: number }> {
    // Select the strict validator from the trusted subscription event name,
    // then use only its immutable descriptor snapshot below. Never inspect the
    // mutable caller object to decide which validator should run.
    const acceptedEnvelope = CHECKOUT_OUTBOX_EVENT_NAMES.includes(eventName as never)
      ? normalizeCheckoutEventWireEnvelope(envelope)
      : ALLOCATION_OUTBOX_EVENT_NAMES.includes(eventName as never)
      ? normalizeAllocationEventWireEnvelope(envelope)
      : (() => { throw new AllocationEventProbeError("EVENT_DRIFT", "Unknown event name") })()
    const sourceModule = acceptedEnvelope.aggregate_type === CHECKOUT_OUTBOX_AGGREGATE_TYPE
      ? "checkout"
      : acceptedEnvelope.aggregate_type === ALLOCATION_OUTBOX_AGGREGATE_TYPE
      ? "allocation"
      : (() => { throw new AllocationEventProbeError("EVENT_DRIFT", "Unknown outbox source") })()
    if (eventName !== acceptedEnvelope.event_name) {
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
            `${ALLOCATION_EVENT_PROBE_CONSUMER}\u0000${sourceModule}\u0000${acceptedEnvelope.aggregate_type}\u0000${acceptedEnvelope.aggregate_id}`
          )
          .digest("hex")
        await manager.execute(
          `insert into flash_sale_test_allocation_event_cursor
            (id, consumer_id, source_module, aggregate_type, aggregate_id, last_version,
             effect_count, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 0, ?::timestamptz, ?::timestamptz)
           on conflict do nothing`,
          [
            cursorId,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
            sourceModule === "allocation" ? 1 : 0,
            now,
            now,
          ]
        )
        const cursors = (await manager.execute(
          `select last_version, last_event_id, last_event_hash, effect_count
             from flash_sale_test_allocation_event_cursor
            where consumer_id = ? and source_module = ? and aggregate_type = ? and aggregate_id = ?
            for update`,
          [
            ALLOCATION_EVENT_PROBE_CONSUMER,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
          ]
        )) as Array<{
          last_version: number | string
          last_event_id: string | null
          last_event_hash: string | null
          effect_count: number | string
        }>
        if (!cursors[0]) {
          throw new AllocationEventProbeError(
            "EVENT_DRIFT",
            "Cursor identity hash belongs to another aggregate"
          )
        }
        const existing = (await manager.execute(
          `select event_id, event_name, event_hash, source_module, aggregate_type, aggregate_id,
                  aggregate_version, occurred_at, delivery_count, payload
             from flash_sale_test_allocation_event_inbox
            where consumer_id = ? and source_module = ? and event_id = ? for update`,
          [ALLOCATION_EVENT_PROBE_CONSUMER, sourceModule, acceptedEnvelope.event_id]
        )) as InboxRow[]
        if (existing[0]) {
          this.assertExact(existing[0], acceptedEnvelope, sourceModule)
          const rows = (await manager.execute(
            `update flash_sale_test_allocation_event_inbox
                set delivery_count = delivery_count + 1,
                    last_received_at = ?::timestamptz,
                    updated_at = ?::timestamptz
              where consumer_id = ? and source_module = ? and event_id = ?
              returning delivery_count`,
            [
              now,
              now,
              ALLOCATION_EVENT_PROBE_CONSUMER,
              sourceModule,
              acceptedEnvelope.event_id,
            ]
          )) as Array<{ delivery_count: number | string }>
          return { replayed: true, delivery_count: Number(rows[0].delivery_count) }
        }
        const versionOwner = (await manager.execute(
          `select event_id from flash_sale_test_allocation_event_inbox
            where consumer_id = ? and source_module = ? and aggregate_type = ? and aggregate_id = ?
              and aggregate_version = ?`,
          [
            ALLOCATION_EVENT_PROBE_CONSUMER,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
            acceptedEnvelope.aggregate_version,
          ]
        )) as Array<{ event_id: string }>
        if (versionOwner[0]) {
          throw new AllocationEventProbeError(
            "AGGREGATE_VERSION_CONFLICT",
            "Aggregate version already belongs to another event"
          )
        }
        const lastVersion = Number(cursors[0].last_version)
        if (acceptedEnvelope.aggregate_version > lastVersion + 1) {
          throw new AllocationEventProbeError(
            "VERSION_GAP",
            "Allocation event arrived with a version gap"
          )
        }
        if (acceptedEnvelope.aggregate_version <= lastVersion) {
          throw new AllocationEventProbeError(
            "STALE_UNKNOWN_EVENT",
            "Unknown stale allocation event cannot be applied"
          )
        }
        const inboxId = `fsprobein_${acceptedEnvelope.event_id}`.slice(0, 255)
        await manager.execute(
          `insert into flash_sale_test_allocation_event_inbox
            (id, consumer_id, event_id, event_name, event_hash, source_module, aggregate_type,
             aggregate_id, aggregate_version, occurred_at, payload,
             delivery_count, first_received_at, last_received_at, processed_at,
             created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::jsonb, 1,
                   ?::timestamptz, ?::timestamptz, ?::timestamptz,
                   ?::timestamptz, ?::timestamptz)`,
          [
            inboxId,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            acceptedEnvelope.event_id,
            acceptedEnvelope.event_name,
            acceptedEnvelope.event_hash,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
            acceptedEnvelope.aggregate_version,
            acceptedEnvelope.occurred_at,
            JSON.stringify(acceptedEnvelope.payload),
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
            (id, consumer_id, event_id, event_hash, source_module, aggregate_type, aggregate_id,
             aggregate_version, effect_name, applied_at, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz,
                   ?::timestamptz, ?::timestamptz)`,
          [
            `fsprobeef_${acceptedEnvelope.event_id}`.slice(0, 255),
            ALLOCATION_EVENT_PROBE_CONSUMER,
            acceptedEnvelope.event_id,
            acceptedEnvelope.event_hash,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
            acceptedEnvelope.aggregate_version,
            acceptedEnvelope.event_name,
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
            where consumer_id = ? and source_module = ? and aggregate_type = ? and aggregate_id = ?`,
          [
            acceptedEnvelope.aggregate_version,
            acceptedEnvelope.event_id,
            acceptedEnvelope.event_hash,
            now,
            ALLOCATION_EVENT_PROBE_CONSUMER,
            sourceModule,
            acceptedEnvelope.aggregate_type,
            acceptedEnvelope.aggregate_id,
          ]
        )
        this.trip("after_effect_before_commit")
        return { replayed: false, delivery_count: 1 }
      }
    )
  }

  private assertExact(
    row: InboxRow & { payload?: Record<string, unknown> | string },
    envelope: AllocationEventWireEnvelope | CheckoutEventWireEnvelope,
    sourceModule: string
  ) {
    if (
      row.event_name !== envelope.event_name ||
      row.event_hash !== envelope.event_hash ||
      row.source_module !== sourceModule ||
      row.aggregate_type !== envelope.aggregate_type ||
      row.aggregate_id !== envelope.aggregate_id ||
      Number(row.aggregate_version) !== envelope.aggregate_version ||
      new Date(row.occurred_at).toISOString() !== envelope.occurred_at ||
      canonicalJson(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) !==
        canonicalJson(envelope.payload)
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
