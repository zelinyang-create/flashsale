import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "node:path"
import {
  ALLOCATION_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_OUTBOX_SCHEMA_VERSION,
  AllocationEventWireEnvelope,
  AllocationOutboxEventName,
  hashAllocationEventIdentity,
  CHECKOUT_OUTBOX_AGGREGATE_TYPE,
  CHECKOUT_OUTBOX_SCHEMA_VERSION,
  CheckoutEventWireEnvelope,
  CheckoutOutboxEventName,
  hashCheckoutEventIdentity,
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

function checkoutEnvelope(): CheckoutEventWireEnvelope {
  const aggregateId = `checkout-probe-${++sequence}`
  const identity = {
    event_name: CheckoutOutboxEventName.PREPARED,
    schema_version: CHECKOUT_OUTBOX_SCHEMA_VERSION,
    aggregate_type: CHECKOUT_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: aggregateId,
    aggregate_version: 1,
    payload: {
      execution_id: aggregateId,
      attempt_id: `attempt-${aggregateId}`,
      campaign_id: "campaign-probe",
      rules_version: 1,
      state: "prepared",
      items: [{ campaign_item_id: "item-probe", variant_id: "variant-probe", quantity: 1 }],
    },
  } as const
  return {
    event_id: `event-${aggregateId}`,
    ...identity,
    event_hash: hashCheckoutEventIdentity(identity),
    occurred_at: "2026-09-20T20:00:00.000Z",
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

    it("starts a Checkout source cursor at zero and applies v1 once under 100 duplicates", async () => {
      const event = checkoutEnvelope()
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          service.applyAllocationEvent(event.event_name, event)
        )
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(await counts(event.aggregate_id)).toEqual({ inbox: 1, effect: 1, cursor: 1 })
      expect(await execute(
        `select source_module, last_version::int, effect_count::int
           from flash_sale_test_allocation_event_cursor where aggregate_id = ?`,
        [event.aggregate_id]
      )).toEqual([{ source_module: "checkout", last_version: 1, effect_count: 1 }])
    })

    it("persists only the validated immutable snapshot and rejects Proxy input", async () => {
      const event = checkoutEnvelope()
      const applying = service.applyAllocationEvent(event.event_name, event)
      const payload = event.payload as {
        items: Array<{ quantity: number }>
      }
      payload.items[0].quantity = 99
      await expect(applying).resolves.toEqual({ replayed: false, delivery_count: 1 })
      expect(await execute(
        `select (payload #>> '{items,0,quantity}')::int as quantity
           from flash_sale_test_allocation_event_inbox where event_id = ?`,
        [event.event_id]
      )).toEqual([{ quantity: 1 }])

      const proxied = new Proxy(checkoutEnvelope(), {})
      await expect(
        service.applyAllocationEvent(CheckoutOutboxEventName.PREPARED, proxied)
      ).rejects.toThrow("Proxy")
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

    it("commits one effect for 100 concurrent duplicate deliveries", async () => {
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

    it("upgrades populated B1 tables and supports a generated down-up round trip", async () => {
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      await migrator.down()
      expect(
        await execute(
          `select
             to_regclass('public.flash_sale_test_allocation_event_inbox') is not null as table_kept,
             exists(select 1 from information_schema.columns where table_name =
               'flash_sale_test_allocation_event_inbox' and column_name = 'source_module') as source_kept,
             exists(select 1 from pg_indexes where indexname =
               'IDX_flash_sale_test_probe_inbox_source_event_unique') as source_index`
        )
      ).toEqual([{ table_kept: true, source_kept: false, source_index: false }])
      const legacyHash = "a".repeat(64)
      await execute(
        `insert into flash_sale_test_allocation_event_cursor
          (id, consumer_id, aggregate_type, aggregate_id, last_version, effect_count)
         values ('legacy-cursor', 'legacy-consumer', 'purchase_attempt', 'legacy-attempt', 2, 1)`
      )
      await execute(
        `insert into flash_sale_test_allocation_event_effect
          (id, consumer_id, event_id, event_hash, aggregate_type, aggregate_id,
           aggregate_version, effect_name, applied_at)
         values ('legacy-effect', 'legacy-consumer', 'legacy-event', ?,
                 'purchase_attempt', 'legacy-attempt', 2,
                 'flash_sale.quota.held.v1', now())`,
        [legacyHash]
      )
      await execute(
        `insert into flash_sale_test_allocation_event_inbox
          (id, consumer_id, event_id, event_name, event_hash, aggregate_type,
           aggregate_id, aggregate_version, occurred_at, payload,
           first_received_at, last_received_at, processed_at)
         values ('legacy-inbox', 'legacy-consumer', 'legacy-event',
                 'flash_sale.quota.held.v1', ?, 'purchase_attempt',
                 'legacy-attempt', 2, now(), '{}'::jsonb, now(), now(), now())`,
        [legacyHash]
      )
      await migrator.up()
      expect(
        await execute(
          `select
             to_regclass('public.flash_sale_test_allocation_event_inbox') is not null as inbox,
             to_regclass('public.flash_sale_test_allocation_event_effect') is not null as effect,
             to_regclass('public.flash_sale_test_allocation_event_cursor') is not null as cursor,
             exists(select 1 from pg_indexes where indexname =
               'IDX_flash_sale_test_probe_inbox_source_event_unique') as source_index,
             (select source_module from flash_sale_test_allocation_event_cursor
               where id = 'legacy-cursor') as cursor_source,
             (select source_module from flash_sale_test_allocation_event_effect
               where id = 'legacy-effect') as effect_source,
             (select source_module from flash_sale_test_allocation_event_inbox
               where id = 'legacy-inbox') as inbox_source`
        )
      ).toEqual([{
        inbox: true,
        effect: true,
        cursor: true,
        source_index: true,
        cursor_source: "allocation",
        effect_source: "allocation",
        inbox_source: "allocation",
      }])
    })
  },
})
