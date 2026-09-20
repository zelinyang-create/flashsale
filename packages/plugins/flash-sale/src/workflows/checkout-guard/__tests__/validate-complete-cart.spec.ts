import { MedusaError } from "@medusajs/framework/utils"
import {
  ALLOCATION_REQUEST_SCHEMA_VERSION,
  createCanonicalRequestFingerprint,
} from "../../../modules/flash-sale-allocation"
import {
  CampaignState,
  CheckoutExecutionState,
  PurchaseAttemptState,
} from "../../../types"
import { validateFlashSaleCartCompletion as validateFlashSaleCartCompletionImpl } from "../validate-complete-cart"

const campaign = {
  id: "campaign-1",
  name: "Campaign",
  description: null,
  state: CampaignState.ACTIVE,
  starts_at: new Date("2026-09-20T00:00:00Z"),
  ends_at: new Date("2026-09-21T00:00:00Z"),
  version: 2,
  rules_version: 3,
  campaign_epoch: 1,
  hold_ttl_seconds: 300,
  per_subject_limit: 2,
  metadata: null,
}

const campaignItem = {
  id: "campaign-item-1",
  campaign_id: campaign.id,
  variant_id: "variant-1",
  location_id: null,
  quota: 10,
  version: 1,
  metadata: null,
}

const now = new Date("2026-09-20T12:00:00Z")
const requestHash = createCanonicalRequestFingerprint({
  schema_version: ALLOCATION_REQUEST_SCHEMA_VERSION,
  campaign_id: campaign.id,
  subject_id: "customer-1",
  cart_id: "cart-1",
  rules_version: campaign.rules_version,
  items: [{ campaign_item_id: campaignItem.id, quantity: 1 }],
})
const execution = {
  id: "execution-1",
  attempt_id: "attempt-1",
  campaign_id: campaign.id,
  subject_id: "customer-1",
  cart_id: "cart-1",
  command_id: "command-1",
  request_hash: requestHash,
  commerce_transaction_id: "commerce-1",
  rules_version: campaign.rules_version,
  state: CheckoutExecutionState.COMMERCE_PENDING,
  order_id: null,
  version: 2,
  attempt_count: 1,
  lease_owner: "worker-1",
  lease_until: new Date("2026-09-20T12:01:00Z"),
  lease_epoch: 1,
  completion_authorized_epoch: 1,
  completion_authorized_at: now,
  next_reconcile_at: null,
  last_error_code: null,
  commerce_started_at: now,
  commerce_resolved_at: null,
  terminal_at: null,
  created_at: now,
  updated_at: now,
  deleted_at: null,
}

const snapshot = {
  execution,
  items: [
    {
      id: "execution-item-1",
      execution_id: execution.id,
      campaign_item_id: campaignItem.id,
      variant_id: campaignItem.variant_id,
      quantity: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    },
  ],
}

function validateFlashSaleCartCompletion(
  data: Parameters<typeof validateFlashSaleCartCompletionImpl>[0],
  container: Parameters<typeof validateFlashSaleCartCompletionImpl>[1],
  transactionId = execution.commerce_transaction_id
) {
  return validateFlashSaleCartCompletionImpl(data, container, transactionId)
}

const attempt = {
  id: execution.attempt_id,
  campaign_id: campaign.id,
  subject_id: execution.subject_id,
  cart_id: execution.cart_id,
  request_hash: execution.request_hash,
  rules_version: execution.rules_version,
  state: PurchaseAttemptState.QUOTA_COMMITTING,
  settlement_id: execution.id,
}
const holds = [{ campaign_item_id: campaignItem.id, quantity: 1 }]

function cart(overrides: Record<string, unknown> = {}) {
  return {
    input: { id: "cart-1" },
    cart: {
      id: "cart-1",
      customer: { id: "customer-1" },
      items: [{ variant_id: "variant-1", quantity: 1 }],
      ...overrides,
    },
  }
}

function fixture() {
  const campaignPort = {
    retrieveCampaign: jest.fn().mockResolvedValue(campaign),
    listCampaigns: jest.fn().mockResolvedValue([campaign]),
    listCampaignItems: jest.fn().mockResolvedValue([campaignItem]),
  }
  const checkoutPort = {
    findExecutionForCart: jest.fn().mockResolvedValue(snapshot),
    readCartCompletionAuthorization: jest
      .fn()
      .mockImplementation(
        async (input: { commerce_transaction_id: string }) => {
          if (
            input.commerce_transaction_id !== execution.commerce_transaction_id
          ) {
            throw new Error("commerce transaction permit mismatch")
          }
          return { ...snapshot, replayed: true }
        }
      ),
  }
  const allocationPort = {
    authorizeQuotaSettlement: jest.fn().mockResolvedValue({ attempt, holds }),
  }
  const services: Record<string, unknown> = {
    flashSaleCampaign: campaignPort,
    flashSaleCheckout: checkoutPort,
    flashSaleAllocation: allocationPort,
  }
  return {
    campaignPort,
    checkoutPort,
    allocationPort,
    container: {
      resolve<T>(name: string): T {
        return services[name] as T
      },
    },
  }
}

describe("completeCart public validate hook guard", () => {
  it("allows a normal cart with no execution or scheduled/active variant", async () => {
    const context = fixture()
    context.checkoutPort.findExecutionForCart.mockResolvedValue(null)
    context.campaignPort.listCampaignItems.mockResolvedValue([])
    context.campaignPort.listCampaigns.mockResolvedValue([])
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).resolves.toBeUndefined()
    expect(
      context.checkoutPort.readCartCompletionAuthorization
    ).not.toHaveBeenCalled()
  })

  it("keeps an ordinary custom-line-item cart transparent", async () => {
    const context = fixture()
    context.checkoutPort.findExecutionForCart.mockResolvedValue(null)
    context.campaignPort.listCampaignItems.mockResolvedValue([])
    context.campaignPort.listCampaigns.mockResolvedValue([])
    await expect(
      validateFlashSaleCartCompletion(
        cart({ items: [{ variant_id: null, quantity: 1 }] }),
        context.container
      )
    ).resolves.toBeUndefined()
  })

  it("rejects a custom item mixed into a flash-sale cart", async () => {
    const context = fixture()
    await expect(
      validateFlashSaleCartCompletion(
        cart({
          items: [
            { variant_id: "variant-1", quantity: 1 },
            { variant_id: null, quantity: 1 },
          ],
        }),
        context.container
      )
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("fails closed when a different complete-cart transaction borrows an active permit", async () => {
    const context = fixture()
    await expect(
      validateFlashSaleCartCompletion(
        cart(),
        context.container,
        "different-complete-transaction"
      )
    ).rejects.toBeInstanceOf(MedusaError)
    expect(
      context.checkoutPort.readCartCompletionAuthorization
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        commerce_transaction_id: "different-complete-transaction",
      })
    )
    expect(
      context.allocationPort.authorizeQuotaSettlement
    ).not.toHaveBeenCalled()
  })

  it("fails closed when the workflow transaction credential is absent", async () => {
    const context = fixture()
    await expect(
      validateFlashSaleCartCompletionImpl(cart(), context.container)
    ).rejects.toBeInstanceOf(MedusaError)
    expect(
      context.checkoutPort.readCartCompletionAuthorization
    ).not.toHaveBeenCalled()
  })

  it("rejects an active or scheduled flash variant without an execution", async () => {
    for (const state of [CampaignState.ACTIVE, CampaignState.SCHEDULED]) {
      const context = fixture()
      context.checkoutPort.findExecutionForCart.mockResolvedValue(null)
      context.campaignPort.listCampaigns.mockResolvedValue([
        { ...campaign, state },
      ])
      context.checkoutPort.readCartCompletionAuthorization.mockRejectedValue(
        new Error("missing execution")
      )
      await expect(
        validateFlashSaleCartCompletion(cart(), context.container)
      ).rejects.toBeInstanceOf(MedusaError)
    }
  })

  it("allows the exact execution, active lease, and committing allocation", async () => {
    const context = fixture()
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).resolves.toBeUndefined()
    expect(
      context.allocationPort.authorizeQuotaSettlement
    ).toHaveBeenCalledWith({
      attempt_id: execution.attempt_id,
      settlement_id: execution.id,
    })
  })

  it("rejects HELD instead of COMMITTING", async () => {
    const context = fixture()
    context.allocationPort.authorizeQuotaSettlement.mockResolvedValue({
      attempt: { ...attempt, state: PurchaseAttemptState.QUOTA_HELD },
      holds,
    })
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it.each([
    ["wrong customer", cart({ customer: { id: "customer-other" } })],
    [
      "wrong quantity",
      cart({ items: [{ variant_id: "variant-1", quantity: 2 }] }),
    ],
  ])("rejects %s", async (_label, data) => {
    const context = fixture()
    context.checkoutPort.readCartCompletionAuthorization.mockRejectedValue(
      new Error("snapshot mismatch")
    )
    await expect(
      validateFlashSaleCartCompletion(data, context.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("rejects wrong cart identity before module access", async () => {
    const context = fixture()
    const data = cart()
    data.input.id = "cart-other"
    await expect(
      validateFlashSaleCartCompletion(data, context.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("rejects stale rules, request hash, attempt, or settlement identity", async () => {
    for (const changed of [
      { rules_version: 4 },
      { request_hash: "b".repeat(64) },
      { id: "attempt-other" },
      { settlement_id: "execution-other" },
    ]) {
      const context = fixture()
      context.allocationPort.authorizeQuotaSettlement.mockResolvedValue({
        attempt: { ...attempt, ...changed },
        holds,
      })
      await expect(
        validateFlashSaleCartCompletion(cart(), context.container)
      ).rejects.toBeInstanceOf(MedusaError)
    }
  })

  it("rejects campaign-item and allocation-hold snapshot drift", async () => {
    const context = fixture()
    context.checkoutPort.readCartCompletionAuthorization.mockResolvedValue({
      ...snapshot,
      items: [
        {
          ...snapshot.items[0],
          campaign_item_id: "campaign-item-other",
        },
      ],
      replayed: true,
    })
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).rejects.toBeInstanceOf(MedusaError)

    const holdContext = fixture()
    holdContext.allocationPort.authorizeQuotaSettlement.mockResolvedValue({
      attempt,
      holds: [{ campaign_item_id: campaignItem.id, quantity: 2 }],
    })
    await expect(
      validateFlashSaleCartCompletion(cart(), holdContext.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("rejects an expired lease reported by the checkout authorization port", async () => {
    const context = fixture()
    context.checkoutPort.readCartCompletionAuthorization.mockRejectedValue(
      new Error("lease expired")
    )
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("rejects overlapping campaigns", async () => {
    const context = fixture()
    context.checkoutPort.findExecutionForCart.mockResolvedValue(null)
    context.campaignPort.listCampaignItems.mockResolvedValue([
      campaignItem,
      { ...campaignItem, id: "campaign-item-2", campaign_id: "campaign-2" },
    ])
    context.campaignPort.listCampaigns.mockResolvedValue([
      campaign,
      { ...campaign, id: "campaign-2" },
    ])
    await expect(
      validateFlashSaleCartCompletion(cart(), context.container)
    ).rejects.toBeInstanceOf(MedusaError)
  })

  it("fails closed when campaign, checkout, or allocation dependencies fail", async () => {
    const failures = ["campaign", "checkout", "allocation"] as const
    for (const failure of failures) {
      const context = fixture()
      if (failure === "campaign") {
        context.campaignPort.listCampaignItems.mockRejectedValue(
          new Error("campaign unavailable")
        )
      } else if (failure === "checkout") {
        context.checkoutPort.findExecutionForCart.mockRejectedValue(
          new Error("checkout unavailable")
        )
      } else {
        context.allocationPort.authorizeQuotaSettlement.mockRejectedValue(
          new Error("allocation unavailable")
        )
      }
      await expect(
        validateFlashSaleCartCompletion(cart(), context.container)
      ).rejects.toBeInstanceOf(MedusaError)
    }
  })
})
