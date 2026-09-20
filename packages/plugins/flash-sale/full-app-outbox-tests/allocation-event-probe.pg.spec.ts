import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "node:path"
import {
  ALLOCATION_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_OUTBOX_SCHEMA_VERSION,
  AllocationEventWireEnvelope,
  AllocationOutboxEventName,
  hashAllocationEventIdentity,
} from "../src/shared"
import AllocationEventProbeModuleService, {
  AllocationEventProbeError,
} from "./src/modules/allocation-event-probe/service"
import {
  AllocationEventProbeCursor,
  AllocationEventProbeEffect,
  AllocationEventProbeInbox,
} from "./src/modules/allocation-event-probe/models"

jest.setTimeout(240_000)

let sequence = 0

function heldEnvelope(
  aggregateVersion = 2,
  overrides: Partial<AllocationEventWireEnvelope> = {}
): AllocationEventWireEnvelope {
  const aggregateId = overrides.aggregate_id ?? `attempt-probe-${++sequence}`
  const payload = {
    attempt_id: aggregateId,
    campaign_id: "campaign-probe",
    rules_version: 1,
    state: "quota_held",
    items: [{ campaign_item_id: "item-probe", quantity: 1 }],
  }
  const identity = {
    event_name: AllocationOutboxEventName.QUOTA_HELD,
    schema_version: ALLOCATION_OUTBOX_SCHEMA_VERSION,
    aggregate_type: ALLOCATION_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: aggregateId,
    aggregate_version: aggregateVersion,
    payload,
  } as const
  return {
    event_id: overrides.event_id ?? `event-probe-${sequence}-${aggregateVersion}`,
    ...identity,
    event_hash: hashAllocationEventIdentity(identity),
    occurred_at: "2026-09-20T20:00:00.000Z",
    ...overrides,
  }
}

moduleIntegrationTestRunner<AllocationEventProbeModuleService>({
  moduleName: "allocationEventProbe",
  resolve: path.resolve(__dirname, "src/modules/allocation-event-probe"),
  cwd: path.resolve(__dirname, ".."),
  dbName: "medusa-flash-sale-outbox-probe",
  moduleModels: [
    AllocationEventProbeCursor,
    AllocationEventProbeEffect,
    AllocationEventProbeInbox,
  ],
  pathToMigrations: path.resolve(
    __dirname,
    "src/modules/allocation-event-probe/migrations"
  ),
  testSuite: ({ MikroOrmWrapper, service }) => {
    const execute = async (sql: string, params: unknown[] = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    async function counts(aggregateId: string) {
      const rows = (await execute(
        `select
           (select count(*)::int from flash_sale_test_allocation_event_inbox where aggregate_id = ?) as inbox,
           (select count(*)::int from flash_sale_test_allocation_event_effect where aggregate_id = ?) as effect,
           (select count(*)::int from flash_sale_test_allocation_event_cursor where aggregate_id = ?) as cursor`,
        [aggregateId, aggregateId, aggregateId]
      )) as Array<{ inbox: number; effect: number; cursor: number }>
      return rows[0]
    }

    it("commits Inbox, effect, and cursor atomically and deduplicates exact replay", async () => {
      const event = heldEnvelope()
      expect(await service.applyAllocationEvent(event.event_name, event)).toEqual({
        replayed: false,
        delivery_count: 1,
      })
      expect(await service.applyAllocationEvent(event.event_name, event)).toEqual({
        replayed: true,
        delivery_count: 2,
      })
      expect(await counts(event.aggregate_id)).toEqual({
        inbox: 1,
        effect: 1,
        cursor: 1,
      })
      const cursor = (await execute(
        `select last_version::int as last_version, effect_count::int as effect_count
           from flash_sale_test_allocation_event_cursor where aggregate_id = ?`,
        [event.aggregate_id]
      )) as Array<{ last_version: number; effect_count: number }>
      expect(cursor[0]).toEqual({ last_version: 2, effect_count: 1 })
    })

    it.each(["after_inbox_insert", "after_effect_before_commit"] as const)(
      "rolls back Inbox, effect, and cursor at %s",
      async (failpoint) => {
        const event = heldEnvelope()
        await service.setProbeFailpoint(failpoint)
        await expect(
          service.applyAllocationEvent(event.event_name, event)
        ).rejects.toThrow(`Allocation event probe failpoint: ${failpoint}`)
        expect(await counts(event.aggregate_id)).toEqual({
          inbox: 0,
          effect: 0,
          cursor: 0,
        })
      }
    )

    it("fails closed on event drift, aggregate-version conflict, gaps, and stale unknown events", async () => {
      const driftBase = heldEnvelope()
      await service.applyAllocationEvent(driftBase.event_name, driftBase)
      await expect(
        service.applyAllocationEvent(driftBase.event_name, {
          ...driftBase,
          occurred_at: "2026-09-20T20:00:01.000Z",
        })
      ).rejects.toMatchObject({ code: "EVENT_DRIFT" })

      const conflict = heldEnvelope(2, {
        aggregate_id: driftBase.aggregate_id,
        event_id: `event-conflict-${++sequence}`,
      })
      await expect(
        service.applyAllocationEvent(conflict.event_name, conflict)
      ).rejects.toMatchObject<Partial<AllocationEventProbeError>>({
        code: "AGGREGATE_VERSION_CONFLICT",
      })

      const gap = heldEnvelope(3)
      await expect(
        service.applyAllocationEvent(gap.event_name, gap)
      ).rejects.toMatchObject<Partial<AllocationEventProbeError>>({
        code: "VERSION_GAP",
      })

      const staleAggregate = heldEnvelope()
      await service.applyAllocationEvent(staleAggregate.event_name, staleAggregate)
      await execute(
        "delete from flash_sale_test_allocation_event_inbox where aggregate_id = ?",
        [staleAggregate.aggregate_id]
      )
      const stale = heldEnvelope(2, {
        aggregate_id: staleAggregate.aggregate_id,
        event_id: `event-stale-${++sequence}`,
      })
      await expect(
        service.applyAllocationEvent(stale.event_name, stale)
      ).rejects.toMatchObject<Partial<AllocationEventProbeError>>({
        code: "STALE_UNKNOWN_EVENT",
      })
    })

    it("applies 100 concurrent duplicate deliveries exactly once", async () => {
      const event = heldEnvelope()
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          service.applyAllocationEvent(event.event_name, event)
        )
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(await counts(event.aggregate_id)).toEqual({
        inbox: 1,
        effect: 1,
        cursor: 1,
      })
      const inbox = (await execute(
        `select delivery_count::int as delivery_count
           from flash_sale_test_allocation_event_inbox where event_id = ?`,
        [event.event_id]
      )) as Array<{ delivery_count: number }>
      expect(inbox[0].delivery_count).toBe(100)
    })

    it("supports generated migration down-up without schema drift", async () => {
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      await migrator.down()
      expect(
        await execute(
          "select to_regclass('public.flash_sale_test_allocation_event_inbox') is null as removed"
        )
      ).toEqual([{ removed: true }])
      await migrator.up()
      expect(
        await execute(
          `select
             to_regclass('public.flash_sale_test_allocation_event_inbox') is not null as inbox,
             to_regclass('public.flash_sale_test_allocation_event_effect') is not null as effect,
             to_regclass('public.flash_sale_test_allocation_event_cursor') is not null as cursor`
        )
      ).toEqual([{ inbox: true, effect: true, cursor: true }])
    })
  },
})
