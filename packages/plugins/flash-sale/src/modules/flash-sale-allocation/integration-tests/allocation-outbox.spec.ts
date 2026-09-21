import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  AllocationCommandErrorCode,
  ClaimAndHoldQuotaCommand,
} from "../application"
import {
  AllocationOutboxStatus,
  AllocationPolicyState,
  CapacityState,
  FlashSalePluginModule,
} from "../../../types"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationOutboxControl,
  AllocationOutboxEvent,
  AllocationPolicy,
  Capacity,
  CapacityMovement,
  CapacityMovementCheckpoint,
  CapacityMovementControl,
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import { PostgresAllocationAttemptStore } from "../persistence"
import FlashSaleAllocationModuleService from "../service"
import {
  AllocationOutboxDispatcher,
  AllocationOutboxDispatcherConfig,
} from "../../../orchestration/allocation-outbox"

jest.setTimeout(240000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (label: string) => `${label}-outbox-${process.pid}-${++sequence}`
const hash = (value: number) => value.toString(16).padStart(64, "0")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation",
  moduleModels: [
    AllocationCampaignFence,
    AllocationOutboxControl,
    AllocationOutboxEvent,
    AllocationPolicy,
    Capacity,
    CapacityMovement,
    CapacityMovementCheckpoint,
    CapacityMovementControl,
    PurchaseAttempt,
    AllocationHold,
    SubjectAllocation,
  ],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ MikroOrmWrapper, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    async function seed(quantity = 100) {
      const campaignId = id("campaign")
      const policyId = id("fsapol")
      const itemId = id("item")
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 minute',
                 now() + interval '10 minutes', 300, 100, 1)`,
        [policyId, campaignId, "c".repeat(64), AllocationPolicyState.OPEN]
      )
      await execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values (?, ?, ?, 0, ?, ?, 0, 0, 1, 1,
           jsonb_build_object('value', ?::text, 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20))`,
        [id("fscap"), policyId, itemId, CapacityState.OPEN, quantity, quantity]
      )
      return { campaignId, itemId }
    }

    function command(
      campaignId: string,
      itemId: string,
      subject = id("subject")
    ): ClaimAndHoldQuotaCommand {
      return {
        campaign_id: campaignId,
        subject_id: subject,
        cart_id: id("cart"),
        idempotency_key_hash: hash(sequence + 100),
        expected_rules_version: 1,
        items: [{ campaign_item_id: itemId, quantity: 1 }],
      }
    }

    async function outboxRows(attemptId: string) {
      return (await execute(
        `select id, event_name, aggregate_version::int as aggregate_version,
                event_hash, payload, status, attempt_count::int as attempt_count,
                lease_epoch::int as lease_epoch, redrive_count::int as redrive_count
           from flash_sale_allocation_outbox_event
          where aggregate_id = ? order by aggregate_version`,
        [attemptId]
      )) as Array<Record<string, unknown>>
    }

    async function insertOutbox(
      aggregate: string,
      version: number,
      overrides: {
        status?: AllocationOutboxStatus
        available?: string
        leaseOwner?: string
        leaseUntil?: string
        leaseEpoch?: number
        attemptCount?: number
        maxAttempts?: number | null
        dead?: boolean
      } = {}
    ) {
      const status = overrides.status ?? AllocationOutboxStatus.PENDING
      const eventId = id("fsaevt")
      await execute(
        `insert into flash_sale_allocation_outbox_event
          (id, event_name, schema_version, aggregate_type, aggregate_id,
           aggregate_version, event_hash, payload, status, available_at,
           occurred_at, attempt_count, max_attempts, lease_owner, lease_until,
           lease_epoch, dead_lettered_at, redrive_count)
         values (?, 'test.event.v1', 1, 'purchase_attempt', ?, ?, ?,
                 ?::jsonb, ?, ${overrides.available ?? "now()"}, now(), ?, ?, ?,
                 ${overrides.leaseUntil ?? "null"}, ?,
                 ${overrides.dead ? "now()" : "null"}, 0)`,
        [
          eventId,
          aggregate,
          version,
          hash(sequence + version),
          JSON.stringify({ aggregate, version }),
          status,
          overrides.attemptCount ?? 0,
          overrides.maxAttempts ?? null,
          overrides.leaseOwner ?? null,
          overrides.leaseEpoch ?? 0,
        ]
      )
      const rows = (await execute(
        `select id, event_hash from flash_sale_allocation_outbox_event where id = ?`,
        [eventId]
      )) as Array<{ id: string; event_hash: string }>
      return rows[0]
    }

    it("emits one immutable event per transition and appends nothing on replay", async () => {
      await service.activateAllocationOutbox({})
      const fixture = await seed()
      const input = command(fixture.campaignId, fixture.itemId)
      const held = await service.claimAndHoldQuota(input)
      expect(held.status).toBe("held")
      if (held.status !== "held") throw new Error("expected held")
      expect(
        (await outboxRows(held.attempt.id)).map((row) => row.event_name)
      ).toEqual(["flash_sale.quota.held.v1"])
      await service.claimAndHoldQuota(input)
      expect(await outboxRows(held.attempt.id)).toHaveLength(1)

      const settlementId = id("checkout")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.consumeQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.consumeQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      const rows = await outboxRows(held.attempt.id)
      expect(
        rows.map((row) => [row.aggregate_version, row.event_name])
      ).toEqual([
        [2, "flash_sale.quota.held.v1"],
        [3, "flash_sale.quota.settlement_started.v1"],
        [4, "flash_sale.quota.consumed.v1"],
      ])
      expect(new Set(rows.map((row) => row.event_hash)).size).toBe(3)
    })

    it("converges 20 concurrent business commands and response-loss replay to one event", async () => {
      await service.activateAllocationOutbox({})
      const fixture = await seed()
      const input = command(fixture.campaignId, fixture.itemId)
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.claimAndHoldQuota(input))
      )
      const attemptIds = results.map((result) => result.attempt.id)
      expect(new Set(attemptIds).size).toBe(1)
      const beforeReplay = await outboxRows(attemptIds[0])
      expect(beforeReplay).toHaveLength(1)
      const replay = await service.claimAndHoldQuota(input)
      expect(replay.replayed).toBe(true)
      const afterReplay = await outboxRows(attemptIds[0])
      expect(afterReplay).toEqual(beforeReplay)
    })

    it("lets one expiry race win without duplicate terminal events", async () => {
      await service.activateAllocationOutbox({})
      const fixture = await seed()
      const held = await service.claimAndHoldQuota(
        command(fixture.campaignId, fixture.itemId)
      )
      if (held.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_purchase_attempt set expires_at = now() - interval '1 second'
          where id = ?`,
        [held.attempt.id]
      )
      await execute(
        `update flash_sale_allocation_hold set expires_at = now() - interval '1 second'
          where attempt_id = ?`,
        [held.attempt.id]
      )
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.expireQuota({ attempt_id: held.attempt.id })
        )
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(
        (await outboxRows(held.attempt.id)).filter(
          (row) => row.event_name === "flash_sale.quota.expired.v1"
        )
      ).toHaveLength(1)
    })

    it("emits rejected, held_cancel, settlement_release, and expiry facts", async () => {
      const rejectedFixture = await seed(1)
      const first = await service.claimAndHoldQuota(
        command(rejectedFixture.campaignId, rejectedFixture.itemId)
      )
      expect(first.status).toBe("held")
      const rejected = await service.claimAndHoldQuota(
        command(rejectedFixture.campaignId, rejectedFixture.itemId)
      )
      expect(rejected.status).toBe("rejected")
      const rejectedEvent = (await outboxRows(rejected.attempt.id))[0]
      expect(rejectedEvent.event_name).toBe("flash_sale.quota.rejected.v1")
      expect(rejectedEvent.payload).toMatchObject({
        items: [{ campaign_item_id: rejectedFixture.itemId, quantity: 1 }],
        rejection_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
      })

      const cancelFixture = await seed()
      const canceled = await service.claimAndHoldQuota(
        command(cancelFixture.campaignId, cancelFixture.itemId)
      )
      if (canceled.status !== "held") throw new Error("expected held")
      await service.cancelHeldQuota({ attempt_id: canceled.attempt.id })
      const cancelRows = await outboxRows(canceled.attempt.id)
      expect(
        (cancelRows[1].payload as { release_kind: string }).release_kind
      ).toBe("held_cancel")

      const releaseFixture = await seed()
      const released = await service.claimAndHoldQuota(
        command(releaseFixture.campaignId, releaseFixture.itemId)
      )
      if (released.status !== "held") throw new Error("expected held")
      const settlementId = id("checkout")
      await service.beginQuotaSettlement({
        attempt_id: released.attempt.id,
        settlement_id: settlementId,
      })
      await service.releaseQuotaSettlement({
        attempt_id: released.attempt.id,
        settlement_id: settlementId,
      })
      const releaseRows = await outboxRows(released.attempt.id)
      expect(
        (releaseRows[2].payload as { release_kind: string }).release_kind
      ).toBe("settlement_release")

      const expireFixture = await seed()
      const expired = await service.claimAndHoldQuota(
        command(expireFixture.campaignId, expireFixture.itemId)
      )
      if (expired.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_purchase_attempt set expires_at = now() - interval '1 second'
          where id = ?`,
        [expired.attempt.id]
      )
      await execute(
        `update flash_sale_allocation_hold set expires_at = now() - interval '1 second'
          where attempt_id = ?`,
        [expired.attempt.id]
      )
      await service.expireQuota({ attempt_id: expired.attempt.id })
      expect((await outboxRows(expired.attempt.id))[1].event_name).toBe(
        "flash_sale.quota.expired.v1"
      )
    })

    it("fails closed on a missing activated replay event but exempts legacy rows", async () => {
      const legacyFixture = await seed()
      const legacyInput = command(
        legacyFixture.campaignId,
        legacyFixture.itemId
      )
      const legacy = await service.claimAndHoldQuota(legacyInput)
      if (legacy.status !== "held") throw new Error("expected held")
      await service.activateAllocationOutbox({})
      await execute(
        "delete from flash_sale_allocation_outbox_event where aggregate_id = ?",
        [legacy.attempt.id]
      )
      await expect(
        service.claimAndHoldQuota(legacyInput)
      ).resolves.toMatchObject({
        replayed: true,
      })

      const activeFixture = await seed()
      const activeInput = command(
        activeFixture.campaignId,
        activeFixture.itemId
      )
      const active = await service.claimAndHoldQuota(activeInput)
      if (active.status !== "held") throw new Error("expected held")
      await execute(
        "delete from flash_sale_allocation_outbox_event where aggregate_id = ?",
        [active.attempt.id]
      )
      await expect(
        service.claimAndHoldQuota(activeInput)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
      })
      const reconciliation = await service.reconcileAllocation({
        campaign_id: activeFixture.campaignId,
      })
      expect(reconciliation.counts).toMatchObject({
        OUTBOX_CURRENT_EVENT_MISSING: 1,
      })

      const conflictFixture = await seed()
      const conflictInput = command(
        conflictFixture.campaignId,
        conflictFixture.itemId
      )
      const conflict = await service.claimAndHoldQuota(conflictInput)
      if (conflict.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_allocation_outbox_event
            set payload = payload || '{"tampered":true}'::jsonb
          where aggregate_id = ? and aggregate_version = ?`,
        [conflict.attempt.id, conflict.attempt.version]
      )
      await expect(service.claimAttempt(conflictInput)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
      })
    })

    it.each([
      "after_domain_transition_before_outbox",
      "after_outbox_append_before_commit",
    ] as const)("rolls domain and event back at %s", async (failpoint) => {
      const fixture = await seed()
      const input = command(fixture.campaignId, fixture.itemId)
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresAllocationAttemptStore(repository, {
        hit: (name) => {
          if (name === failpoint) throw new Error(`injected ${failpoint}`)
        },
      })
      await expect(
        store.claimAndHoldQuota({
          ...input,
          request_hash: "f".repeat(64),
          items: input.items,
        })
      ).rejects.toThrow(`injected ${failpoint}`)
      const rows = (await execute(
        `select
          (select count(*)::int from flash_sale_purchase_attempt where campaign_id = ?) attempts,
          (select count(*)::int from flash_sale_allocation_outbox_event
            where aggregate_id in (select id from flash_sale_purchase_attempt where campaign_id = ?)) events`,
        [fixture.campaignId, fixture.campaignId]
      )) as Array<{ attempts: number; events: number }>
      expect(rows[0]).toEqual({ attempts: 0, events: 0 })
    })

    it("claims disjoint batches, fences old epochs, retries, dead-letters, and redrives", async () => {
      const event1 = await insertOutbox(id("aggregate"), 1)
      const event2 = await insertOutbox(id("aggregate"), 1)
      const [left, right] = await Promise.all([
        service.claimAllocationOutboxEvents({
          worker_id: "worker-left",
          limit: 1,
          lease_seconds: 30,
          max_attempts: 2,
        }),
        service.claimAllocationOutboxEvents({
          worker_id: "worker-right",
          limit: 1,
          lease_seconds: 30,
          max_attempts: 2,
        }),
      ])
      expect(left.events).toHaveLength(1)
      expect(right.events).toHaveLength(1)
      expect(left.events[0].id).not.toBe(right.events[0].id)
      expect(new Set([left.events[0].id, right.events[0].id])).toEqual(
        new Set([event1.id, event2.id])
      )

      const expiring = right.events[0]
      await execute(
        `update flash_sale_allocation_outbox_event
            set lease_until = now() - interval '1 second'
          where id = ?`,
        [expiring.id]
      )
      const takeover = await service.claimAllocationOutboxEvents({
        worker_id: "worker-expired-takeover",
        limit: 1,
        lease_seconds: 30,
        max_attempts: 2,
      })
      expect(takeover.events[0]).toMatchObject({
        id: expiring.id,
        lease_epoch: expiring.lease_epoch + 1,
        attempt_count: 2,
      })
      expect(
        await service.markAllocationOutboxPublished({
          event_id: expiring.id,
          worker_id: expiring.lease_owner!,
          lease_epoch: expiring.lease_epoch,
        })
      ).toMatchObject({ disposition: "fenced", event: null })
      expect(
        await service.markAllocationOutboxPublished({
          event_id: expiring.id,
          worker_id: "worker-expired-takeover",
          lease_epoch: takeover.events[0].lease_epoch,
        })
      ).toMatchObject({ disposition: "published" })

      const first = left.events[0]
      expect(
        await service.markAllocationOutboxPublished({
          event_id: first.id,
          worker_id: "wrong-worker",
          lease_epoch: first.lease_epoch,
        })
      ).toMatchObject({ disposition: "fenced", event: null })
      const retried = await service.failAllocationOutboxEvent({
        event_id: first.id,
        worker_id: first.lease_owner!,
        lease_epoch: first.lease_epoch,
        retry_after_seconds: 1,
        error_code: "BROKER_UNAVAILABLE",
        permanent: false,
      })
      expect(retried.disposition).toBe("retried")
      expect(
        await service.claimAllocationOutboxEvents({
          worker_id: "worker-too-early",
          limit: 10,
          lease_seconds: 30,
          max_attempts: 2,
        })
      ).toMatchObject({ events: [] })
      await execute(
        "update flash_sale_allocation_outbox_event set available_at = now() where id = ?",
        [first.id]
      )
      const reclaimed = await service.claimAllocationOutboxEvents({
        worker_id: "worker-takeover",
        limit: 1,
        lease_seconds: 30,
        max_attempts: 2,
      })
      expect(reclaimed.events[0].lease_epoch).toBe(first.lease_epoch + 1)
      expect(
        await service.markAllocationOutboxPublished({
          event_id: reclaimed.events[0].id,
          worker_id: first.lease_owner!,
          lease_epoch: first.lease_epoch,
        })
      ).toMatchObject({ disposition: "fenced", event: null })
      expect(
        await service.failAllocationOutboxEvent({
          event_id: reclaimed.events[0].id,
          worker_id: "worker-takeover",
          lease_epoch: reclaimed.events[0].lease_epoch,
          retry_after_seconds: 1,
          error_code: "BROKER_UNAVAILABLE",
          permanent: false,
        })
      ).toMatchObject({ disposition: "dead_lettered" })
      const deadRows = await outboxRows(reclaimed.events[0].aggregate_id)
      const dead = deadRows.find((row) => row.id === reclaimed.events[0].id)!
      const redriven = await service.redriveAllocationOutboxEvent({
        event_id: dead.id as string,
        event_hash: dead.event_hash as string,
      })
      expect(redriven).toMatchObject({ disposition: "redriven" })
      expect(redriven.event).toMatchObject({
        status: AllocationOutboxStatus.PENDING,
        attempt_count: 0,
        redrive_count: 1,
      })
    })

    it("publishes with exact replay and keeps published events immutable", async () => {
      const inserted = await insertOutbox(id("publish"), 1)
      const claim = await service.claimAllocationOutboxEvents({
        worker_id: "worker-publish",
        limit: 1,
        lease_seconds: 30,
        max_attempts: 3,
      })
      expect(claim.events[0].id).toBe(inserted.id)
      const command = {
        event_id: inserted.id,
        worker_id: "worker-publish",
        lease_epoch: claim.events[0].lease_epoch,
      }
      const published = await service.markAllocationOutboxPublished(command)
      expect(published.disposition).toBe("published")
      await expect(
        service.markAllocationOutboxPublished(command)
      ).resolves.toEqual(published)
      await expect(
        service.redriveAllocationOutboxEvent({
          event_id: inserted.id,
          event_hash: inserted.event_hash,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.OUTBOX_STATE_CONFLICT,
      })
    })

    it("blocks generated outbox CRUD mutations", async () => {
      await expect(
        (
          service as unknown as {
            createAllocationOutboxEvents(): Promise<never>
          }
        ).createAllocationOutboxEvents()
      ).rejects.toThrow("Direct allocation CRUD is disabled")
      await expect(
        (
          service as unknown as {
            updateAllocationOutboxControls(): Promise<never>
          }
        ).updateAllocationOutboxControls()
      ).rejects.toThrow("Direct allocation CRUD is disabled")
    })

    it("enforces aggregate head-of-line while isolating another aggregate", async () => {
      const blockedAggregate = id("blocked")
      await insertOutbox(blockedAggregate, 1, {
        status: AllocationOutboxStatus.DEAD_LETTER,
        dead: true,
        attemptCount: 1,
        maxAttempts: 1,
      })
      const blockedTail = await insertOutbox(blockedAggregate, 2)
      const healthy = await insertOutbox(id("healthy"), 1)
      const claimed = await service.claimAllocationOutboxEvents({
        worker_id: "worker-hol",
        limit: 10,
        lease_seconds: 30,
        max_attempts: 3,
      })
      expect(claimed.events.map((event) => event.id)).toContain(healthy.id)
      expect(claimed.events.map((event) => event.id)).not.toContain(
        blockedTail.id
      )
    })

    it("holds no PostgreSQL outbox row lock while the network publish is pending", async () => {
      await service.activateAllocationOutbox({})
      const fixture = await seed()
      const held = await service.claimAndHoldQuota(
        command(fixture.campaignId, fixture.itemId)
      )
      if (held.status !== "held") throw new Error("expected held quota")

      let enterPublish!: () => void
      let releasePublish!: () => void
      const publishing = new Promise<void>((resolve) => {
        enterPublish = resolve
      })
      const release = new Promise<void>((resolve) => {
        releasePublish = resolve
      })
      const subscriberManifest = {
        "flash_sale.quota.held.v1": ["allocation-consumer-v1"],
      }
      const dispatcher = new AllocationOutboxDispatcher(
        service,
        {
          assertReady: () => undefined,
          publish: async () => {
            enterPublish()
            await release
            return { accepted: true, provider: "medusa-redis-event-bus" }
          },
        },
        {
          enabled: true,
          concurrency: 1,
          lease_seconds: 30,
          max_attempts: 3,
          retry_after_seconds: 1,
          mark_timeout_ms: 1_000,
          safety_margin_ms: 1_000,
          subscriber_manifest: subscriberManifest,
        } as AllocationOutboxDispatcherConfig,
        "network-lock-worker"
      )

      const tick = dispatcher.runTick()
      await publishing
      const rows = await outboxRows(held.attempt.id)
      expect(rows[0].status).toBe(AllocationOutboxStatus.PUBLISHING)
      await expect(
        MikroOrmWrapper.forkManager().execute(
          `select id from flash_sale_allocation_outbox_event
            where id = ? for update nowait`,
          [rows[0].id]
        )
      ).resolves.toHaveLength(1)
      releasePublish()
      await expect(tick).resolves.toMatchObject({
        claimed: 1,
        accepted: 1,
        published: 1,
      })
    })

    it("uses a fresh DB clock after a blocked row lock before publishing", async () => {
      const inserted = await insertOutbox(id("clock"), 1, {
        status: AllocationOutboxStatus.PUBLISHING,
        leaseOwner: "clock-worker",
        leaseUntil: "now() + interval '30 seconds'",
        leaseEpoch: 1,
        attemptCount: 1,
        maxAttempts: 3,
      })
      const blocker = MikroOrmWrapper.forkManager()
      await blocker.begin()
      await blocker.execute(
        "select id from flash_sale_allocation_outbox_event where id = ? for update",
        [inserted.id]
      )
      const lease = (await blocker.execute(
        `update flash_sale_allocation_outbox_event
            set lease_until = clock_timestamp() + interval '1 second'
          where id = ?
          returning lease_until, clock_timestamp() as fresh_now`,
        [inserted.id]
      )) as Array<{ lease_until: Date | string; fresh_now: Date | string }>
      expect(new Date(lease[0].fresh_now).getTime()).toBeLessThan(
        new Date(lease[0].lease_until).getTime()
      )
      const publish = service.markAllocationOutboxPublished({
        event_id: inserted.id,
        worker_id: "clock-worker",
        lease_epoch: 1,
      })
      await waitForBlockedOutboxCommand(MikroOrmWrapper.forkManager())
      await MikroOrmWrapper.forkManager().execute("select pg_sleep(1.1)")
      await blocker.commit()
      await expect(publish).resolves.toMatchObject({
        disposition: "fenced",
        event: null,
      })
    })

    async function waitForBlockedOutboxCommand(manager: SqlEntityManager) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = (await manager.execute(
          `select exists(
             select 1 from pg_stat_activity
              where datname = current_database()
                and pid <> pg_backend_pid()
                and wait_event_type = 'Lock'
                and query like '%flash_sale_allocation_outbox_event%'
           ) as blocked`
        )) as Array<{ blocked: boolean }>
        if (rows[0]?.blocked) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("outbox command did not block on the event row")
    }
  },
})
