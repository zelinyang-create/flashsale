/** @jest-environment ./full-app-outbox-tests/redis-fault-proxy-environment.js */

import { createHash, randomUUID } from "node:crypto"
import Redis from "ioredis"
import { Client } from "pg"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { WorkflowManager } from "@medusajs/orchestration"
import { Modules } from "@medusajs/framework/utils"
import path from "node:path"
import { dispatchAllocationOutbox } from "../src/jobs/dispatch-allocation-outbox"
import { createAllocationConfigurationHash } from "../src/modules/flash-sale-allocation/application"
import { FlashSalePluginModule } from "../src/types"
import {
  ALLOCATION_EVENT_PROBE_MODULE,
} from "./src/modules/allocation-event-probe"
import AllocationEventProbeModuleService from "./src/modules/allocation-event-probe/service"
import FlashSaleAllocationModuleService from "../src/modules/flash-sale-allocation/service"

jest.setTimeout(240_000)

const redisUrl = process.env.FLASH_SALE_TEST_REDIS_URL
if (!redisUrl) {
  throw new Error(
    "FLASH_SALE_TEST_REDIS_URL must point to an explicit Redis test instance"
  )
}

type RedisFaultProxy = Readonly<{
  upstreamUrl: string
  proxyUrl: string
  setAvailable(available: boolean): void
  beginCleanWindow(): void
}>
const redisFaultProxy = (
  globalThis as typeof globalThis & {
    __flashSaleRedisFaultProxy: RedisFaultProxy
  }
).__flashSaleRedisFaultProxy
if (!redisFaultProxy || redisFaultProxy.proxyUrl !== redisUrl) {
  throw new Error("Redis fault proxy test environment was not initialized")
}

const eventNames = [
  "flash_sale.quota.held.v1",
  "flash_sale.quota.rejected.v1",
  "flash_sale.quota.settlement_started.v1",
  "flash_sale.quota.consumed.v1",
  "flash_sale.quota.released.v1",
  "flash_sale.quota.expired.v1",
]

process.env.FLASH_SALE_TEST_REDIS_QUEUE = `flash-sale-outbox-${process.pid}-${randomUUID()}`
process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED = "true"
process.env.FLASH_SALE_OUTBOX_CONCURRENCY = "4"
process.env.FLASH_SALE_OUTBOX_LEASE_SECONDS = "5"
process.env.FLASH_SALE_OUTBOX_MAX_ATTEMPTS = "3"
process.env.FLASH_SALE_OUTBOX_RETRY_AFTER_SECONDS = "1"
process.env.FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS = "500"
process.env.FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS = "500"
process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = JSON.stringify(
  eventNames.map((eventName) => ({
    event_name: eventName,
    subscriber_ids: ["allocation-event-probe-v1"],
  }))
)
// The workflow must autoload, but this suite drives its handler explicitly so
// lease-takeover assertions cannot race a wall-clock cron tick.
process.env.FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE = "0 0 0 * * *"

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await sleep(50)
    }
  }
  throw lastError
}

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname),
  medusaConfigFile: path.resolve(__dirname),
  env: {
    FLASH_SALE_TEST_REDIS_URL: redisFaultProxy.proxyUrl,
    FLASH_SALE_TEST_REDIS_QUEUE: process.env.FLASH_SALE_TEST_REDIS_QUEUE,
    FLASH_SALE_OUTBOX_DISPATCH_ENABLED: "true",
    FLASH_SALE_OUTBOX_CONCURRENCY: "4",
    FLASH_SALE_OUTBOX_LEASE_SECONDS: "5",
    FLASH_SALE_OUTBOX_MAX_ATTEMPTS: "3",
    FLASH_SALE_OUTBOX_RETRY_AFTER_SECONDS: "1",
    FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS: "500",
    FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS: "500",
    FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON:
      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON,
    FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE: "0 0 0 * * *",
  },
  testSuite: ({ getContainer, dbConfig }) => {
    let container: any
    let allocation: FlashSaleAllocationModuleService
    let probe: AllocationEventProbeModuleService
    let redis: Redis
    let sequence = 0

    async function seedHeld() {
      const suffix = `${process.pid}-${++sequence}-${randomUUID()}`
      const campaignId = `campaign-outbox-${suffix}`
      const itemId = `item-outbox-${suffix}`
      const now = Date.now()
      const snapshot = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: new Date(now - 60_000).toISOString(),
        ends_at: new Date(now + 600_000).toISOString(),
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
        items: [{ campaign_item_id: itemId, quota: 10 }],
      }
      const provisioned = await allocation.provisionAllocation({
        ...snapshot,
        configuration_hash: createAllocationConfigurationHash(snapshot),
      })
      await allocation.openAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: provisioned.policy.version,
      })
      const result = await allocation.claimAndHoldQuota({
        campaign_id: campaignId,
        subject_id: `subject-${suffix}`,
        cart_id: `cart-${suffix}`,
        idempotency_key_hash: createHash("sha256")
          .update(`command-${suffix}`)
          .digest("hex"),
        expected_rules_version: 1,
        items: [{ campaign_item_id: itemId, quantity: 1 }],
      })
      if (result.status !== "held") throw new Error("expected held quota")
      return result.attempt
    }

    async function outboxFor(aggregateId: string) {
      return (await (allocation as any).listAllocationOutboxEvents(
        { aggregate_id: aggregateId },
        { order: { aggregate_version: "ASC" } }
      )) as any[]
    }

    async function inboxFor(eventId: string) {
      return (await (probe as any).listAllocationEventProbeInboxes({
        event_id: eventId,
      })) as any[]
    }

    beforeAll(async () => {
      // Dedicated, short-lived health client talks directly to the explicit
      // test Redis. It never shares the EventBus Queue/Worker connection.
      redis = new Redis(redisFaultProxy.upstreamUrl, {
        lazyConnect: true,
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
      })
      await redis.connect()
      await expect(redis.ping()).resolves.toBe("PONG")
      container = getContainer()
      allocation = container.resolve(FlashSalePluginModule.ALLOCATION)
      probe = container.resolve(ALLOCATION_EVENT_PROBE_MODULE)
      await allocation.activateAllocationOutbox({})
    })

    afterAll(async () => {
      redisFaultProxy.setAvailable(true)
      await redis.quit()
      // The custom Jest environment owns the proxy and closes it only after
      // medusaIntegrationTestRunner has shut down the EventBus application.
      redisFaultProxy.beginCleanWindow()
    })

    it("autoloads the job/subscriber and converges Redis acceptance duplicates to one effect", async () => {
      expect(
        WorkflowManager.getWorkflow("job-flash-sale-dispatch-allocation-outbox")
      ).toBeDefined()

      const normalAttempt = await seedHeld()
      const normalTick = await dispatchAllocationOutbox(container)
      expect(normalTick).toMatchObject({
        claimed: 1,
        accepted: 1,
        published: 1,
      })
      const normalEvent = (await outboxFor(normalAttempt.id))[0]
      expect(normalEvent.status).toBe("published")
      await eventually(async () => {
        const rows = await inboxFor(normalEvent.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(1)
      })

      const crashAttempt = await seedHeld()
      const crashed = await dispatchAllocationOutbox(container, {
        after_event_bus_accept_before_mark: () => {
          throw new Error("deterministic accepted-before-mark crash")
        },
      })
      expect(crashed).toMatchObject({ claimed: 1, accepted: 1, ambiguous: 1 })
      const beforeTakeover = (await outboxFor(crashAttempt.id))[0]
      expect(beforeTakeover.status).toBe("publishing")
      const oldOwner = beforeTakeover.lease_owner
      const oldEpoch = beforeTakeover.lease_epoch
      await eventually(async () => {
        const rows = await inboxFor(beforeTakeover.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(1)
      })

      await sleep(5_100)
      const takeover = await dispatchAllocationOutbox(container)
      expect(takeover).toMatchObject({ claimed: 1, accepted: 1, published: 1 })
      await eventually(async () => {
        const rows = await inboxFor(beforeTakeover.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(2)
        const effects = await (probe as any).listAllocationEventProbeEffects({
          event_id: beforeTakeover.id,
        })
        expect(effects).toHaveLength(1)
        const cursors = await (probe as any).listAllocationEventProbeCursors({
          aggregate_id: crashAttempt.id,
        })
        expect(cursors).toHaveLength(1)
        expect(cursors[0].effect_count).toBe(1)
      })
      const finalEvent = (await outboxFor(crashAttempt.id))[0]
      expect(finalEvent.status).toBe("published")
      expect(finalEvent.id).toBe(beforeTakeover.id)
      expect(finalEvent.event_hash).toBe(beforeTakeover.event_hash)
      expect(finalEvent.lease_epoch).toBe(oldEpoch + 1)
      await expect(
        allocation.markAllocationOutboxPublished({
          event_id: beforeTakeover.id,
          worker_id: oldOwner,
          lease_epoch: oldEpoch,
        })
      ).resolves.toMatchObject({ disposition: "fenced" })

      const outageAttempt = await seedHeld()
      redisFaultProxy.setAvailable(false)
      const outageTick = dispatchAllocationOutbox(container)
      await eventually(async () => {
        const duringOutage = (await outboxFor(outageAttempt.id))[0]
        expect(duringOutage.status).toBe("publishing")
        expect(duringOutage.published_at).toBeNull()
      })

      const lockProbe = new Client({ connectionString: dbConfig.clientUrl })
      await lockProbe.connect()
      try {
        await lockProbe.query("begin")
        await expect(
          lockProbe.query(
            `select id from flash_sale_allocation_outbox_event
              where aggregate_id = $1 for update nowait`,
            [outageAttempt.id]
          )
        ).resolves.toMatchObject({ rowCount: 1 })
      } finally {
        await lockProbe.query("rollback")
        await lockProbe.end()
      }

      // Cross the database lease while Redis/BullMQ's add remains pending.
      // Restoring the proxy lets the original emit resolve; its exact mark is
      // fenced because another process is now allowed to take over.
      await sleep(5_100)
      redisFaultProxy.setAvailable(true)
      const restoredOriginal = await outageTick
      expect(restoredOriginal).toMatchObject({
        claimed: 1,
        accepted: 1,
        published: 0,
        fenced: 1,
      })
      // From this point through takeover and Medusa shutdown, timeout,
      // ECONNABORTED, or orphan workflow errors are fixture failures.
      redisFaultProxy.beginCleanWindow()
      const takeoverAfterOutage = await dispatchAllocationOutbox(container)
      expect(takeoverAfterOutage).toMatchObject({
        claimed: 1,
        accepted: 1,
        published: 1,
      })
      const afterRestore = (await outboxFor(outageAttempt.id))[0]
      expect(afterRestore.status).toBe("published")
      await eventually(async () => {
        const rows = await inboxFor(afterRestore.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(2)
        const effects = await (probe as any).listAllocationEventProbeEffects({
          event_id: afterRestore.id,
        })
        expect(effects).toHaveLength(1)
      })

      const guardedAttempt = await seedHeld()
      const completeManifest =
        process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON!
      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = JSON.stringify(
        [{ event_name: eventNames[0], subscriber_ids: ["allocation-event-probe-v1"] }]
      )
      await expect(
        dispatchAllocationOutbox(container, {
          after_event_bus_accept_before_mark: () => undefined,
        })
      ).rejects.toThrow("FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON")
      expect((await outboxFor(guardedAttempt.id))[0].status).toBe("pending")

      // The legacy all-events-to-one-destination map cannot be represented by
      // the canonical manifest and is rejected before claim.
      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = JSON.stringify(
        Object.fromEntries(eventNames.map((name) => [name, eventNames[0]]))
      )
      await expect(
        dispatchAllocationOutbox(container, {
          after_event_bus_accept_before_mark: () => undefined,
        })
      ).rejects.toThrow("FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON")
      expect((await outboxFor(guardedAttempt.id))[0].status).toBe("pending")

      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = JSON.stringify(
        eventNames.map((eventName) => ({
          event_name: eventName,
          subscriber_ids: ["wrong-subscriber-v1"],
        }))
      )
      await expect(
        dispatchAllocationOutbox(container, {
          after_event_bus_accept_before_mark: () => undefined,
        })
      ).rejects.toThrow("EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH")
      expect((await outboxFor(guardedAttempt.id))[0].status).toBe("pending")

      const eventBus = container.resolve(Modules.EVENT_BUS) as any
      const registered = eventBus.eventToSubscribersMap.get(eventNames[0])
      eventBus.eventToSubscribersMap.delete(eventNames[0])
      eventBus.eventToSubscribersMap.set("*", [
        { id: "allocation-event-probe-v1" },
      ])
      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = completeManifest
      try {
        await expect(
          dispatchAllocationOutbox(container, {
            after_event_bus_accept_before_mark: () => undefined,
          })
        ).rejects.toThrow("EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH")
        expect((await outboxFor(guardedAttempt.id))[0].status).toBe("pending")
      } finally {
        eventBus.eventToSubscribersMap.delete("*")
        eventBus.eventToSubscribersMap.set(eventNames[0], registered)
        process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = completeManifest
      }
    })
  },
})
