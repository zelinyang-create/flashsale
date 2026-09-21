/** @jest-environment ./full-app-outbox-tests/redis-fault-proxy-environment.js */

import { createHash, randomUUID } from "node:crypto"
import Redis from "ioredis"
import { Client } from "pg"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { WorkflowManager } from "@medusajs/orchestration"
import {
  ApiKeyType,
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
  PUBLISHABLE_KEY_HEADER,
} from "@medusajs/framework/utils"
import {
  addToCartWorkflow,
  createDefaultsWorkflow,
  createPaymentCollectionForCartWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/core-flows"
import path from "node:path"
import {
  dispatchAllocationOutbox,
  dispatchFlashSaleOutboxes,
} from "../src/jobs/dispatch-allocation-outbox"
import { createAllocationConfigurationHash } from "../src/modules/flash-sale-allocation/application"
import { FlashSalePluginModule } from "../src/types"
import {
  ALLOCATION_EVENT_PROBE_MODULE,
} from "./src/modules/allocation-event-probe"
import AllocationEventProbeModuleService from "./src/modules/allocation-event-probe/service"
import FlashSaleAllocationModuleService from "../src/modules/flash-sale-allocation/service"
import FlashSaleCheckoutModuleService from "../src/modules/flash-sale-checkout/service"
import {
  ALLOCATION_OUTBOX_EVENT_NAMES,
  CHECKOUT_OUTBOX_EVENT_NAMES,
} from "../src/shared"
import {
  activateCampaignWorkflow,
  scheduleCampaignWorkflow,
} from "../src/workflows/campaign-lifecycle"

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
  ...ALLOCATION_OUTBOX_EVENT_NAMES,
  ...CHECKOUT_OUTBOX_EVENT_NAMES,
]

process.env.FLASH_SALE_TEST_REDIS_QUEUE = `flash-sale-outbox-${process.pid}-${randomUUID()}`
process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED = "true"
process.env.FLASH_SALE_CHECKOUT_OUTBOX_DISPATCH_ENABLED = "true"
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
    FLASH_SALE_CHECKOUT_OUTBOX_DISPATCH_ENABLED: "true",
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
  testSuite: ({ api, getContainer, dbConfig }) => {
    let container: any
    let allocation: FlashSaleAllocationModuleService
    let checkout: FlashSaleCheckoutModuleService
    let probe: AllocationEventProbeModuleService
    let redis: Redis
    let sequence = 0
    let query: any
    let cartModule: any
    let inventoryModule: any
    let orderModule: any
    let region: any
    let salesChannelId: string
    let variantId: string
    let campaignId: string
    let authenticatedHeaders: any

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
      query = container.resolve(ContainerRegistrationKeys.QUERY)
      allocation = container.resolve(FlashSalePluginModule.ALLOCATION)
      checkout = container.resolve(FlashSalePluginModule.CHECKOUT)
      probe = container.resolve(ALLOCATION_EVENT_PROBE_MODULE)
      cartModule = container.resolve(Modules.CART)
      inventoryModule = container.resolve(Modules.INVENTORY)
      orderModule = container.resolve(Modules.ORDER)
      await allocation.activateAllocationOutbox({})
      await checkout.activateCheckoutOutbox({})

      const apiKeyModule = container.resolve(Modules.API_KEY)
      const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
      const productModule = container.resolve(Modules.PRODUCT)
      const pricingModule = container.resolve(Modules.PRICING)
      const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
      const storeModule = container.resolve(Modules.STORE)
      const campaignModule = container.resolve(FlashSalePluginModule.CAMPAIGN)
      const link = container.resolve(ContainerRegistrationKeys.LINK)

      const publishableKey = await apiKeyModule.createApiKeys({
        title: "Flash-sale Redis full-app key",
        type: ApiKeyType.PUBLISHABLE,
        created_by: "redis-full-app-test",
      })
      const email = `redis-flash-sale-${process.pid}@example.com`
      const signup = await api.post("/auth/customer/emailpass/register", {
        email,
        password: "secret_password",
      })
      await api.post(
        "/store/customers",
        { email, first_name: "Redis", last_name: "Buyer" },
        {
          headers: {
            [PUBLISHABLE_KEY_HEADER]: publishableKey.token,
            authorization: `Bearer ${signup.data.token}`,
          },
        }
      )
      const signin = await api.post("/auth/customer/emailpass", {
        email,
        password: "secret_password",
      })
      authenticatedHeaders = {
        [PUBLISHABLE_KEY_HEADER]: publishableKey.token,
        authorization: `Bearer ${signin.data.token}`,
      }

      await createDefaultsWorkflow(container).run()
      const regionModule = container.resolve(Modules.REGION)
      region = await regionModule.createRegions({
        name: "Redis Flash Region",
        currency_code: "usd",
      })
      await link.create({
        [Modules.REGION]: { region_id: region.id },
        [Modules.PAYMENT]: { payment_provider_id: "pp_system_default" },
      })
      let [store] = await storeModule.listStores({})
      let defaultSalesChannelId = store.default_sales_channel_id
      if (!defaultSalesChannelId) {
        defaultSalesChannelId = (
          await salesChannelModule.createSalesChannels({ name: "Redis Flash Storefront" })
        ).id
      }
      store = await storeModule.updateStores(store.id, {
        default_region_id: region.id,
        default_sales_channel_id: defaultSalesChannelId,
        supported_currencies: [{ currency_code: "usd", is_default: true }],
      })
      salesChannelId = store.default_sales_channel_id
      await link.create({
        [Modules.API_KEY]: { publishable_key_id: publishableKey.id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannelId },
      })
      const location = await stockLocationModule.createStockLocations({
        name: "Redis Flash Warehouse",
      })
      await link.create({
        [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannelId },
        [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      })
      const [product] = await productModule.createProducts([{
        title: "Redis Flash Product",
        status: ProductStatus.PUBLISHED,
        variants: [{ title: "Redis Flash Variant", manage_inventory: true, allow_backorder: false }],
      }])
      variantId = product.variants[0].id
      const inventoryItem = await inventoryModule.createInventoryItems({
        sku: `redis-flash-${process.pid}`,
      })
      await inventoryModule.createInventoryLevels({
        inventory_item_id: inventoryItem.id,
        location_id: location.id,
        stocked_quantity: 5,
        reserved_quantity: 0,
      })
      const priceSet = await pricingModule.createPriceSets({
        prices: [{ amount: 1000, currency_code: "usd" }],
      })
      await link.create([
        {
          [Modules.PRODUCT]: { variant_id: variantId },
          [Modules.PRICING]: { price_set_id: priceSet.id },
        },
        {
          [Modules.PRODUCT]: { variant_id: variantId },
          [Modules.INVENTORY]: { inventory_item_id: inventoryItem.id },
        },
        {
          [Modules.PRODUCT]: { product_id: product.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannelId },
        },
      ])
      const now = Date.now()
      const campaign = await campaignModule.createCampaigns({
        name: "Redis Full App Flash Sale",
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 3_600_000),
        hold_ttl_seconds: 120,
        per_subject_limit: 20,
      })
      campaignId = campaign.id
      await campaignModule.createCampaignItems({
        campaign_id: campaign.id,
        variant_id: variantId,
        quota: 20,
      })
      await scheduleCampaignWorkflow(container).run({ input: { campaign_id: campaign.id } })
      await activateCampaignWorkflow(container).run({ input: { campaign_id: campaign.id } })
    })

    async function createFlashCart() {
      const customer = await container.resolve(Modules.CUSTOMER).listCustomers({
        email: `redis-flash-sale-${process.pid}@example.com`,
      })
      const created = await cartModule.createCarts({
        currency_code: "usd",
        region_id: region.id,
        sales_channel_id: salesChannelId,
        customer_id: customer[0].id,
      })
      await addToCartWorkflow(container).run({
        input: {
          cart_id: created.id,
          items: [{ variant_id: variantId, quantity: 1, requires_shipping: false }],
        },
      })
      await createPaymentCollectionForCartWorkflow(container).run({
        input: { cart_id: created.id },
      })
      const { data: [cart] } = await query.graph({
        entity: "cart",
        fields: ["id", "payment_collection.id"],
        filters: { id: created.id },
      })
      await createPaymentSessionsWorkflow(container).run({
        input: {
          payment_collection_id: cart.payment_collection.id,
          provider_id: "pp_system_default",
          context: {},
          data: {},
        },
      })
      return cart
    }

    afterAll(async () => {
      redisFaultProxy.setAvailable(true)
      await redis.quit()
      // The custom Jest environment owns the proxy and closes it only after
      // medusaIntegrationTestRunner has shut down the EventBus application.
      redisFaultProxy.beginCleanWindow()
    })

    it("autoloads the job/subscriber and converges Redis acceptance duplicates to one effect", async () => {
      expect(
        WorkflowManager.getWorkflow("job-flash-sale-dispatch-outboxes")
      ).toBeDefined()

      const routeCart = await createFlashCart()
      const routeResult = await api.post(
        `/store/flash-sales/${campaignId}/checkout`,
        { cart_id: routeCart.id },
        { headers: { ...authenticatedHeaders, "Idempotency-Key": "redis-route-happy" } }
      )
      expect(routeResult).toMatchObject({
        status: 200,
        data: { status: "completed", order_id: expect.any(String) },
      })
      const attempts = await allocation.listPurchaseAttempts({ cart_id: routeCart.id })
      const execution = await checkout.findExecutionForCart({ cart_id: routeCart.id })
      expect(attempts).toHaveLength(1)
      expect(execution).not.toBeNull()
      for (let index = 0; index < 4; index += 1) {
        await dispatchFlashSaleOutboxes(container)
      }
      await eventually(async () => {
        const allocationEffects = await (probe as any).listAllocationEventProbeEffects({
          aggregate_id: attempts[0].id,
        })
        const checkoutEffects = await (probe as any).listAllocationEventProbeEffects({
          aggregate_id: execution!.execution.id,
        })
        expect(allocationEffects).toHaveLength(3)
        expect(checkoutEffects).toHaveLength(4)
        const orderedCheckoutEffects = [...checkoutEffects].sort(
          (left: any, right: any) => left.aggregate_version - right.aggregate_version
        )
        expect(orderedCheckoutEffects.map((effect: any) => effect.aggregate_version)).toEqual([1, 2, 3, 4])
        const completedInbox = await (probe as any).listAllocationEventProbeInboxes({
          aggregate_id: execution!.execution.id,
          aggregate_version: 4,
        })
        expect(completedInbox).toHaveLength(1)
        expect(completedInbox[0].payload.order_id).toBe(routeResult.data.order_id)
      })
      expect((await orderModule.listOrders({ id: routeResult.data.order_id }))).toHaveLength(1)
      expect((await inventoryModule.listReservationItems({}))).toHaveLength(1)

      const checkoutSuffix = `${process.pid}-${++sequence}-${randomUUID()}`
      const prepared = await checkout.prepareExecution({
        attempt_id: `attempt-checkout-${checkoutSuffix}`,
        campaign_id: `campaign-checkout-${checkoutSuffix}`,
        subject_id: `subject-checkout-${checkoutSuffix}`,
        cart_id: `cart-checkout-${checkoutSuffix}`,
        command_id: createHash("sha256").update(`command-${checkoutSuffix}`).digest("hex"),
        request_hash: createHash("sha256").update(`request-${checkoutSuffix}`).digest("hex"),
        rules_version: 1,
        items: [{ campaign_item_id: "item-checkout", variant_id: "variant-checkout", quantity: 1 }],
      })
      const lease = await checkout.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "commerce-worker",
        lease_seconds: 30,
      })
      const authorized = await checkout.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "commerce-worker",
        lease_epoch: lease.execution.lease_epoch,
      })
      const succeeded = await checkout.recordCommerceSucceeded({
        execution_id: prepared.execution.id,
        expected_version: authorized.execution.version,
        worker_id: "commerce-worker",
        lease_epoch: authorized.execution.lease_epoch,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        order_id: `order-checkout-${checkoutSuffix}`,
      })
      await checkout.completeExecution({
        execution_id: prepared.execution.id,
        expected_version: succeeded.execution.version,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        order_id: succeeded.execution.order_id!,
      })
      for (let index = 0; index < 4; index += 1) {
        await dispatchFlashSaleOutboxes(container)
      }
      await eventually(async () => {
        const effects = await (probe as any).listAllocationEventProbeEffects({
          aggregate_id: prepared.execution.id,
        })
        expect(effects).toHaveLength(4)
        expect(effects.map((effect: any) => effect.aggregate_version).sort()).toEqual([1, 2, 3, 4])
        expect(new Set(effects.map((effect: any) => effect.source_module))).toEqual(new Set(["checkout"]))
      })

      const duplicateSuffix = `${process.pid}-${++sequence}-${randomUUID()}`
      const duplicatePrepared = await checkout.prepareExecution({
        attempt_id: `attempt-checkout-duplicate-${duplicateSuffix}`,
        campaign_id: `campaign-checkout-duplicate-${duplicateSuffix}`,
        subject_id: `subject-checkout-duplicate-${duplicateSuffix}`,
        cart_id: `cart-checkout-duplicate-${duplicateSuffix}`,
        command_id: createHash("sha256").update(`command-${duplicateSuffix}`).digest("hex"),
        request_hash: createHash("sha256").update(`request-${duplicateSuffix}`).digest("hex"),
        rules_version: 1,
        items: [{ campaign_item_id: "item-checkout", variant_id: "variant-checkout", quantity: 1 }],
      })
      const checkoutCrash = await dispatchFlashSaleOutboxes(container, {
        checkout: {
          after_event_bus_accept_before_mark: () => {
            throw new Error("deterministic checkout accepted-before-mark crash")
          },
        },
      })
      expect(checkoutCrash.checkout).toMatchObject({
        claimed: 1,
        accepted: 1,
        ambiguous: 1,
      })
      const checkoutBeforeTakeover = (
        await (checkout as any).listCheckoutOutboxEvents(
          { aggregate_id: duplicatePrepared.execution.id },
          { order: { aggregate_version: "ASC" } }
        )
      )[0]
      expect(checkoutBeforeTakeover.status).toBe("publishing")
      await eventually(async () => {
        const rows = await inboxFor(checkoutBeforeTakeover.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(1)
      })
      await sleep(5_100)
      const checkoutTakeover = await dispatchFlashSaleOutboxes(container)
      expect(checkoutTakeover.checkout).toMatchObject({
        claimed: 1,
        accepted: 1,
        published: 1,
      })
      await eventually(async () => {
        const rows = await inboxFor(checkoutBeforeTakeover.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].delivery_count).toBe(2)
        const effects = await (probe as any).listAllocationEventProbeEffects({
          event_id: checkoutBeforeTakeover.id,
        })
        expect(effects).toHaveLength(1)
      })
      const checkoutAfterTakeover = (
        await (checkout as any).listCheckoutOutboxEvents({ id: checkoutBeforeTakeover.id })
      )[0]
      expect(checkoutAfterTakeover).toMatchObject({
        status: "published",
        id: checkoutBeforeTakeover.id,
        event_hash: checkoutBeforeTakeover.event_hash,
        lease_epoch: checkoutBeforeTakeover.lease_epoch + 1,
      })
      await expect(checkout.markCheckoutOutboxPublished({
        event_id: checkoutBeforeTakeover.id,
        worker_id: checkoutBeforeTakeover.lease_owner,
        lease_epoch: checkoutBeforeTakeover.lease_epoch,
      })).resolves.toMatchObject({ disposition: "fenced" })

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
      const guardedCheckoutSuffix = `${process.pid}-${++sequence}-${randomUUID()}`
      const guardedCheckout = await checkout.prepareExecution({
        attempt_id: `attempt-checkout-guarded-${guardedCheckoutSuffix}`,
        campaign_id: `campaign-checkout-guarded-${guardedCheckoutSuffix}`,
        subject_id: `subject-checkout-guarded-${guardedCheckoutSuffix}`,
        cart_id: `cart-checkout-guarded-${guardedCheckoutSuffix}`,
        command_id: createHash("sha256").update(`command-${guardedCheckoutSuffix}`).digest("hex"),
        request_hash: createHash("sha256").update(`request-${guardedCheckoutSuffix}`).digest("hex"),
        rules_version: 1,
        items: [{ campaign_item_id: "item-checkout", variant_id: "variant-checkout", quantity: 1 }],
      })
      const completeManifest =
        process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON!
      process.env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON = JSON.stringify(
        [{ event_name: eventNames[0], subscriber_ids: ["allocation-event-probe-v1"] }]
      )
      await expect(
        dispatchFlashSaleOutboxes(container, {
          checkout: {
            after_event_bus_accept_before_mark: () => undefined,
          },
        })
      ).rejects.toThrow("FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON")
      expect((await outboxFor(guardedAttempt.id))[0].status).toBe("pending")
      expect((await (checkout as any).listCheckoutOutboxEvents({
        aggregate_id: guardedCheckout.execution.id,
      }))[0].status).toBe("pending")

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
