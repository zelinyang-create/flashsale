import {
  addToCartWorkflow,
  completeCartWorkflow,
  createDefaultsWorkflow,
  createPaymentCollectionForCartWorkflow,
  createPaymentSessionsWorkflow,
  updateLineItemInCartWorkflow,
} from "@medusajs/core-flows"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
  ApiKeyType,
  PUBLISHABLE_KEY_HEADER,
} from "@medusajs/framework/utils"
import path from "node:path"
import {
  activateCampaignWorkflow,
  scheduleCampaignWorkflow,
} from "../src/workflows/campaign-lifecycle"
import {
  CampaignState,
  CheckoutExecutionState,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../src/types"

jest.setTimeout(240_000)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname),
  medusaConfigFile: path.resolve(__dirname),
  testSuite: ({ api, getContainer }) => {
    let container: any
    let query: any
    let cartModule: any
    let productModule: any
    let pricingModule: any
    let inventoryModule: any
    let stockLocationModule: any
    let orderModule: any
    let campaignModule: any
    let allocationModule: any
    let checkoutModule: any
    let link: any
    let customer: any
    let region: any
    let salesChannelId: string
    let stockLocationId: string
    let inventoryItemId: string
    let variantId: string
    let campaignId: string
    let storeHeaders: any
    let authenticatedHeaders: any
    let secondCustomerHeaders: any
    let wrongChannelHeaders: any

    beforeAll(async () => {
      container = getContainer()
      query = container.resolve(ContainerRegistrationKeys.QUERY)
      link = container.resolve(ContainerRegistrationKeys.LINK)
      cartModule = container.resolve(Modules.CART)
      productModule = container.resolve(Modules.PRODUCT)
      pricingModule = container.resolve(Modules.PRICING)
      inventoryModule = container.resolve(Modules.INVENTORY)
      stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
      orderModule = container.resolve(Modules.ORDER)
      campaignModule = container.resolve(FlashSalePluginModule.CAMPAIGN)
      allocationModule = container.resolve(FlashSalePluginModule.ALLOCATION)
      checkoutModule = container.resolve(FlashSalePluginModule.CHECKOUT)

      const apiKeyModule = container.resolve(Modules.API_KEY)
      const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
      const publishableKey = await apiKeyModule.createApiKeys({
        title: "Flash-sale full-app key",
        type: ApiKeyType.PUBLISHABLE,
        created_by: "full-app-test",
      })
      storeHeaders = {
        headers: { [PUBLISHABLE_KEY_HEADER]: publishableKey.token },
      }
      const email = "flash-sale-customer@example.com"
      const signup = await api.post("/auth/customer/emailpass/register", {
        email,
        password: "secret_password",
      })
      const createdCustomer = await api.post(
        "/store/customers",
        { email, first_name: "Flash", last_name: "Buyer" },
        {
          headers: {
            ...storeHeaders.headers,
            authorization: `Bearer ${signup.data.token}`,
          },
        }
      )
      customer = createdCustomer.data.customer
      const signin = await api.post("/auth/customer/emailpass", {
        email,
        password: "secret_password",
      })
      authenticatedHeaders = {
        headers: {
          ...storeHeaders.headers,
          authorization: `Bearer ${signin.data.token}`,
        },
      }

      const secondEmail = "flash-sale-second-customer@example.com"
      const secondSignup = await api.post(
        "/auth/customer/emailpass/register",
        {
          email: secondEmail,
          password: "secret_password",
        }
      )
      await api.post(
        "/store/customers",
        { email: secondEmail, first_name: "Other", last_name: "Buyer" },
        {
          headers: {
            ...storeHeaders.headers,
            authorization: `Bearer ${secondSignup.data.token}`,
          },
        }
      )
      const secondSignin = await api.post("/auth/customer/emailpass", {
        email: secondEmail,
        password: "secret_password",
      })
      secondCustomerHeaders = {
        headers: {
          ...storeHeaders.headers,
          authorization: `Bearer ${secondSignin.data.token}`,
        },
      }

      await createDefaultsWorkflow(container).run()
      const regionModule = container.resolve(Modules.REGION)
      const storeModule = container.resolve(Modules.STORE)
      region = await regionModule.createRegions({
        name: "Flash Region",
        currency_code: "usd",
      })
      await link.create({
        [Modules.REGION]: { region_id: region.id },
        [Modules.PAYMENT]: { payment_provider_id: "pp_system_default" },
      })
      let [store] = await storeModule.listStores({})
      let resolvedSalesChannelId = store.default_sales_channel_id
      if (!resolvedSalesChannelId) {
        const salesChannel = await salesChannelModule.createSalesChannels({
          name: "Flash Sale Storefront",
        })
        resolvedSalesChannelId = salesChannel.id
      }
      store = await storeModule.updateStores(store.id, {
        default_region_id: region.id,
        default_sales_channel_id: resolvedSalesChannelId,
        supported_currencies: [{ currency_code: "usd", is_default: true }],
      })
      if (!store.default_sales_channel_id) {
        throw new Error("Default sales channel was not provisioned")
      }
      salesChannelId = store.default_sales_channel_id
      await link.create({
        [Modules.API_KEY]: { publishable_key_id: publishableKey.id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannelId },
      })
      const otherSalesChannel = await salesChannelModule.createSalesChannels({
        name: "Other storefront",
      })
      const otherPublishableKey = await apiKeyModule.createApiKeys({
        title: "Wrong-channel key",
        type: ApiKeyType.PUBLISHABLE,
        created_by: "full-app-test",
      })
      await link.create({
        [Modules.API_KEY]: { publishable_key_id: otherPublishableKey.id },
        [Modules.SALES_CHANNEL]: {
          sales_channel_id: otherSalesChannel.id,
        },
      })
      wrongChannelHeaders = {
        headers: {
          [PUBLISHABLE_KEY_HEADER]: otherPublishableKey.token,
          authorization: `Bearer ${signin.data.token}`,
        },
      }
      const location = await stockLocationModule.createStockLocations({
        name: "Flash Sale Warehouse",
      })
      stockLocationId = location.id
      await link.create({
        [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannelId },
        [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      })

      const [product] = await productModule.createProducts([
        {
          title: "Flash Product",
          status: ProductStatus.PUBLISHED,
          variants: [
            {
              title: "Flash Variant",
              manage_inventory: true,
              allow_backorder: false,
            },
          ],
        },
      ])
      variantId = product.variants[0].id
      const inventoryItem = await inventoryModule.createInventoryItems({
        sku: "flash-inventory",
      })
      inventoryItemId = inventoryItem.id
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
        name: "Full App Flash Sale",
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
      await scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      await activateCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect((await campaignModule.retrieveCampaign(campaign.id)).state).toBe(
        CampaignState.ACTIVE
      )
    })

    async function createCart(
      options: {
        quantity?: number
        custom?: boolean
      } = {}
    ) {
      const created = await cartModule.createCarts({
        currency_code: "usd",
        region_id: region.id,
        sales_channel_id: salesChannelId,
        customer_id: customer.id,
      })
      await addToCartWorkflow(container).run({
        input: {
          cart_id: created.id,
          items: options.custom
            ? [
                {
                  title: "Ordinary custom item",
                  quantity: 1,
                  unit_price: 500,
                  requires_shipping: false,
                  is_discountable: false,
                  is_tax_inclusive: false,
                },
              ]
            : [
                {
                  variant_id: variantId,
                  quantity: options.quantity ?? 1,
                  requires_shipping: false,
                },
              ],
        },
      })
      await createPaymentCollectionForCartWorkflow(container).run({
        input: { cart_id: created.id },
      })
      const {
        data: [cart],
      } = await query.graph({
        entity: "cart",
        fields: ["id", "items.id", "payment_collection.id"],
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

    async function counts() {
      return {
        orders: (await orderModule.listOrders({})).length,
        reservations: (await inventoryModule.listReservationItems({})).length,
      }
    }

    async function flashPost(cartId: string, key: string) {
      return await api.post(
        `/store/flash-sales/${campaignId}/checkout`,
        { cart_id: cartId },
        {
          headers: {
            ...authenticatedHeaders.headers,
            "Idempotency-Key": key,
          },
        }
      )
    }

    async function rejectedResponse(request: Promise<unknown>) {
      try {
        await request
      } catch (error: any) {
        if (error?.response) {
          return error.response
        }
        throw error
      }
      throw new Error("Expected the Store request to be rejected")
    }

    it("autoloads modules, authenticated route, and hook while ordinary carts stay normal", async () => {
      expect(campaignModule).toBeDefined()
      expect(allocationModule).toBeDefined()
      expect(checkoutModule).toBeDefined()

      const flashCart = await createCart()
      await expect(
        api.post(
          `/store/flash-sales/${campaignId}/checkout`,
          { cart_id: flashCart.id },
          {
            headers: {
              ...storeHeaders.headers,
              "Idempotency-Key": "guest-denied",
            },
          }
        )
      ).rejects.toMatchObject({ response: { status: 401 } })

      const ordinary = await createCart({ custom: true })
      await expect(
        completeCartWorkflow(container).run({ input: { id: ordinary.id } })
      ).resolves.toMatchObject({ result: { id: expect.any(String) } })
      await expect(counts()).resolves.toEqual({ orders: 1, reservations: 0 })
    })

    it("enforces the complete authenticated Store boundary before side effects", async () => {
      const cart = await createCart()
      const path = `/store/flash-sales/${campaignId}/checkout`
      const validBody = { cart_id: cart.id }

      const missingPublishableKey = await rejectedResponse(
        api.post(path, validBody, {
          headers: {
            authorization: authenticatedHeaders.headers.authorization,
            "Idempotency-Key": "missing-publishable-key",
          },
        })
      )
      const invalidPublishableKey = await rejectedResponse(
        api.post(path, validBody, {
          headers: {
            ...authenticatedHeaders.headers,
            [PUBLISHABLE_KEY_HEADER]: "invalid-publishable-key",
            "Idempotency-Key": "invalid-publishable-key",
          },
        })
      )
      const missingAuthentication = await rejectedResponse(
        api.post(path, validBody, {
          headers: {
            ...storeHeaders.headers,
            "Idempotency-Key": "missing-customer-auth",
          },
        })
      )
      const extraBodyField = await rejectedResponse(
        api.post(
          path,
          { ...validBody, subject_id: customer.id },
          {
            headers: {
              ...authenticatedHeaders.headers,
              "Idempotency-Key": "extra-body-field",
            },
          }
        )
      )
      const missingIdempotencyKey = await rejectedResponse(
        api.post(path, validBody, authenticatedHeaders)
      )
      const invalidIdempotencyKey = await rejectedResponse(
        api.post(path, validBody, {
          headers: {
            ...authenticatedHeaders.headers,
            "Idempotency-Key": "x".repeat(256),
          },
        })
      )
      const invalidCampaignPath = await rejectedResponse(
        api.post(
          "/store/flash-sales/invalid!campaign/checkout",
          validBody,
          {
            headers: {
              ...authenticatedHeaders.headers,
              "Idempotency-Key": "invalid-campaign-path",
            },
          }
        )
      )
      const wrongCampaign = await rejectedResponse(
        api.post(
          "/store/flash-sales/campaign-does-not-match/checkout",
          validBody,
          {
            headers: {
              ...authenticatedHeaders.headers,
              "Idempotency-Key": "wrong-campaign",
            },
          }
        )
      )
      const wrongChannel = await rejectedResponse(
        api.post(path, validBody, {
          headers: {
            ...wrongChannelHeaders.headers,
            "Idempotency-Key": "wrong-channel",
          },
        })
      )

      expect(missingPublishableKey.status).toBe(400)
      expect(invalidPublishableKey.status).toBe(400)
      expect(missingAuthentication.status).toBe(401)
      expect(extraBodyField.status).toBe(400)
      expect(missingIdempotencyKey.status).toBe(400)
      expect(invalidIdempotencyKey.status).toBe(400)
      expect(invalidCampaignPath.status).toBe(400)
      expect(wrongCampaign.status).toBe(400)
      expect(wrongChannel.status).toBe(404)
      await expect(counts()).resolves.toEqual({ orders: 0, reservations: 0 })
      await expect(
        allocationModule.listPurchaseAttempts({ cart_id: cart.id })
      ).resolves.toHaveLength(0)
      await expect(
        checkoutModule.findExecutionForCart({ cart_id: cart.id })
      ).resolves.toBeNull()
    })

    it("does not reveal whether a cart is absent or belongs to another customer", async () => {
      const ownedCart = await createCart()
      const wrongOwner = await rejectedResponse(
        api.post(
          `/store/flash-sales/${campaignId}/checkout`,
          { cart_id: ownedCart.id },
          {
            headers: {
              ...secondCustomerHeaders.headers,
              "Idempotency-Key": "owner-probe",
            },
          }
        )
      )
      const absent = await rejectedResponse(
        api.post(
          `/store/flash-sales/${campaignId}/checkout`,
          { cart_id: "cart_does_not_exist" },
          {
            headers: {
              ...secondCustomerHeaders.headers,
              "Idempotency-Key": "absent-probe",
            },
          }
        )
      )

      expect(wrongOwner.status).toBe(404)
      expect(absent.status).toBe(404)
      expect(wrongOwner.data).toEqual(absent.data)
      await expect(counts()).resolves.toEqual({ orders: 0, reservations: 0 })
      await expect(
        allocationModule.listPurchaseAttempts({ cart_id: ownedCart.id })
      ).resolves.toHaveLength(0)
    })

    it("rejects ordinary HTTP and direct-workflow completion for a flash cart", async () => {
      const cart = await createCart()
      await expect(
        api.post(`/store/carts/${cart.id}/complete`, {}, storeHeaders)
      ).rejects.toMatchObject({ response: { status: 400 } })
      const direct = await completeCartWorkflow(container).run({
        input: { id: cart.id },
        throwOnError: false,
      })
      expect(direct.errors?.[0]).toBeDefined()
      await expect(counts()).resolves.toEqual({ orders: 0, reservations: 0 })
    })

    it("completes exactly once and replays the same order after response loss", async () => {
      const cart = await createCart()
      const first = await flashPost(cart.id, "stable-response-loss-key")
      expect(first.status).toBe(200)
      expect(first.data).toMatchObject({
        status: "completed",
        order_id: expect.any(String),
        replayed: false,
      })
      const replay = await flashPost(cart.id, "stable-response-loss-key")
      expect(replay.status).toBe(200)
      expect(replay.data).toMatchObject({
        status: "completed",
        order_id: first.data.order_id,
        replayed: true,
      })
      await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
      const attempts = await allocationModule.listPurchaseAttempts({
        cart_id: cart.id,
      })
      expect(attempts).toHaveLength(1)
      expect(attempts[0].state).toBe(PurchaseAttemptState.QUOTA_CONSUMED)
    })

    it("allows only one commerce effect for different-key same-cart races", async () => {
      const cart = await createCart()
      const results = await Promise.allSettled([
        flashPost(cart.id, "racing-key-a"),
        flashPost(cart.id, "racing-key-b"),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
    })

    it("rejects active-permit borrowing with another workflow transaction", async () => {
      const cart = await createCart()
      const originalAuthorize =
        checkoutModule.authorizeCartCompletion.bind(checkoutModule)
      let authorizationReached!: () => void
      let releaseOwner!: () => void
      const reached = new Promise<void>((resolve) => {
        authorizationReached = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        releaseOwner = resolve
      })
      checkoutModule.authorizeCartCompletion = async (command: unknown) => {
        const result = await originalAuthorize(command)
        authorizationReached()
        await blocked
        return result
      }
      try {
        const owner = flashPost(cart.id, "permit-owner")
        await reached
        const attacker = await completeCartWorkflow(container).run({
          input: { id: cart.id },
          context: {
            transactionId: "attacker-commerce-transaction",
            parentStepIdempotencyKey: "known-but-unregistered-parent-key",
          },
          throwOnError: false,
        })
        expect(attacker.errors?.[0]).toBeDefined()
        await expect(counts()).resolves.toEqual({
          orders: 0,
          reservations: 0,
        })
        releaseOwner()
        await expect(owner).resolves.toMatchObject({ status: 200 })
      } finally {
        checkoutModule.authorizeCartCompletion = originalAuthorize
        releaseOwner?.()
      }
      await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
    })

    it("does not invoke native commerce when lock wait crosses the shortened lease", async () => {
      const cart = await createCart()
      const locking = container.resolve(Modules.LOCKING)
      const originalClaim =
        checkoutModule.claimCommerceLease.bind(checkoutModule)
      let leaseClaimed!: () => void
      const claimed = new Promise<void>((resolve) => {
        leaseClaimed = resolve
      })
      checkoutModule.claimCommerceLease = async (command: any) => {
        const result = await originalClaim({ ...command, lease_seconds: 1 })
        leaseClaimed()
        return result
      }
      let lockHeld!: () => void
      let releaseLock!: () => void
      const held = new Promise<void>((resolve) => {
        lockHeld = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const blocker = locking.execute(cart.id, async () => {
        lockHeld()
        await release
      })
      try {
        await held
        const request = flashPost(cart.id, "lease-crossing-lock-wait")
        await claimed
        await new Promise((resolve) => setTimeout(resolve, 1500))
        releaseLock()
        const response = await request
        expect(response.status).toBe(202)
        expect(response.data).toMatchObject({
          status: "in_progress",
          code: "LEASE_LOST",
        })
        await expect(counts()).resolves.toEqual({
          orders: 0,
          reservations: 0,
        })
        const expired = await checkoutModule.findExecutionForCart({
          cart_id: cart.id,
        })
        const oldOwner = expired.execution.lease_owner
        const oldEpoch = expired.execution.lease_epoch
        const takeover = await originalClaim({
          execution_id: expired.execution.id,
          worker_id: "full-app-takeover-worker",
          lease_seconds: 5,
        })
        expect(takeover.execution.lease_epoch).toBe(oldEpoch + 1)
        await expect(
          checkoutModule.authorizeCartCompletion({
            execution_id: expired.execution.id,
            worker_id: oldOwner,
            lease_epoch: oldEpoch,
          })
        ).rejects.toBeDefined()
      } finally {
        releaseLock?.()
        await blocker
        checkoutModule.claimCommerceLease = originalClaim
      }
    })

    it("replays consume after commerce success without canceling the order", async () => {
      const cart = await createCart()
      const originalConsume =
        allocationModule.consumeQuotaSettlement.bind(allocationModule)
      allocationModule.consumeQuotaSettlement = jest
        .fn()
        .mockRejectedValueOnce(new Error("transient settlement failure"))
        .mockImplementation(originalConsume)
      try {
        const first = await flashPost(cart.id, "consume-retry")
        expect(first.status).toBe(202)
        expect(first.data).toMatchObject({
          status: "in_progress",
          code: "SETTLEMENT_RETRY",
        })
        await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
        const replay = await flashPost(cart.id, "consume-retry")
        expect(replay.status).toBe(200)
        await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
      } finally {
        allocationModule.consumeQuotaSettlement = originalConsume
      }
    })

    it("recovers a committed native order after result persistence crashes", async () => {
      const cart = await createCart()
      const originalClaim =
        checkoutModule.claimCommerceLease.bind(checkoutModule)
      const originalRecord =
        checkoutModule.recordCommerceSucceeded.bind(checkoutModule)
      let injectFailure = true
      checkoutModule.claimCommerceLease = (command: any) =>
        originalClaim({ ...command, lease_seconds: 3 })
      checkoutModule.recordCommerceSucceeded = async (command: any) => {
        if (injectFailure) {
          injectFailure = false
          throw new Error("injected result persistence crash")
        }
        return await originalRecord(command)
      }
      try {
        const first = await flashPost(cart.id, "native-success-crash-replay")
        expect(first.status).toBe(202)
        expect(first.data).toMatchObject({
          status: "in_progress",
          code: "RESULT_PERSISTENCE",
        })
        await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
        const [committedOrder] = await orderModule.listOrders({})
        const pending = await checkoutModule.findExecutionForCart({
          cart_id: cart.id,
        })
        expect(pending.execution.state).toBe(
          CheckoutExecutionState.COMMERCE_PENDING
        )
        const [committingAttempt] =
          await allocationModule.listPurchaseAttempts({ cart_id: cart.id })
        expect(committingAttempt.state).toBe(
          PurchaseAttemptState.QUOTA_COMMITTING
        )
        const transactionId = pending.execution.commerce_transaction_id
        const leaseUntil = new Date(pending.execution.lease_until).getTime()
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, leaseUntil - Date.now() + 250))
        )

        const replay = await flashPost(cart.id, "native-success-crash-replay")
        expect(replay.status).toBe(200)
        expect(replay.data).toMatchObject({
          status: "completed",
          order_id: committedOrder.id,
          replayed: true,
        })
        await expect(counts()).resolves.toEqual({ orders: 1, reservations: 1 })
        const completed = await checkoutModule.findExecutionForCart({
          cart_id: cart.id,
        })
        expect(completed.execution).toMatchObject({
          state: CheckoutExecutionState.COMPLETED,
          order_id: replay.data.order_id,
          commerce_transaction_id: transactionId,
        })
        const attempts = await allocationModule.listPurchaseAttempts({
          cart_id: cart.id,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0].state).toBe(PurchaseAttemptState.QUOTA_CONSUMED)
      } finally {
        checkoutModule.claimCommerceLease = originalClaim
        checkoutModule.recordCommerceSucceeded = originalRecord
      }
    })

    it("fails closed when the cart mutates after the canonical read", async () => {
      const cart = await createCart()
      const originalHold =
        allocationModule.claimAndHoldQuota.bind(allocationModule)
      allocationModule.claimAndHoldQuota = async (command: any) => {
        const result = await originalHold(command)
        await updateLineItemInCartWorkflow(container).run({
          input: {
            cart_id: cart.id,
            item_id: cart.items[0].id,
            update: { quantity: 2 },
          },
        })
        return result
      }
      try {
        const response = await flashPost(cart.id, "mutation-after-snapshot")
        expect(response.status).toBe(202)
        expect(response.data).toMatchObject({
          status: "unknown",
          code: "COMMERCE_RESULT_UNKNOWN",
        })
        await expect(counts()).resolves.toEqual({
          orders: 0,
          reservations: 0,
        })
        const execution = await checkoutModule.findExecutionForCart({
          cart_id: cart.id,
        })
        expect(execution.execution.state).toBe(
          CheckoutExecutionState.COMMERCE_UNKNOWN
        )
        const attempts = await allocationModule.listPurchaseAttempts({
          cart_id: cart.id,
        })
        expect(attempts[0].state).toBe(PurchaseAttemptState.QUOTA_COMMITTING)
      } finally {
        allocationModule.claimAndHoldQuota = originalHold
      }
    })

    it("releases quota only for a cleanly reverted inventory stage", async () => {
      const cart = await createCart({ quantity: 5 })
      await inventoryModule.updateInventoryLevels({
        inventory_item_id: inventoryItemId,
        location_id: stockLocationId,
        stocked_quantity: 0,
      })
      const response = await flashPost(cart.id, "inventory-definitive").catch(
        (error) => error.response
      )
      expect(response.status).toBe(409)
      expect(response.data).toMatchObject({
        status: "canceled",
        code: "INVENTORY_STAGE_REVERTED",
      })
      await expect(counts()).resolves.toEqual({ orders: 0, reservations: 0 })
      const attempts = await allocationModule.listPurchaseAttempts({
        cart_id: cart.id,
      })
      expect(attempts[0].state).toBe(PurchaseAttemptState.QUOTA_RELEASED)
    })
  },
})
