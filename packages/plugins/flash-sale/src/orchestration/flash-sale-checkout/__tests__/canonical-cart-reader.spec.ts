import { CampaignState, CheckoutExecutionState } from "../../../types"
import {
  CanonicalCartErrorCode,
  CanonicalFlashSaleCartAssembler,
} from "../canonical-cart-reader"

const COMMAND_ID = "a".repeat(64)

function cart(overrides: Record<string, unknown> = {}) {
  return {
    id: "cart-1",
    customer_id: "customer-1",
    completed_at: null,
    currency_code: "usd",
    region_id: "region-1",
    sales_channel_id: "sales-channel-1",
    items: [
      {
        id: "line-1",
        variant_id: "variant-b",
        product_id: "product-b",
        quantity: 1,
      },
      {
        id: "line-2",
        variant_id: "variant-a",
        product_id: "product-a",
        quantity: { valueOf: () => 2 },
      },
      {
        id: "line-3",
        variant_id: "variant-a",
        product_id: "product-a",
        quantity: 1,
      },
    ],
    ...overrides,
  }
}

function makeHarness(cartRow = cart()) {
  const query = {
    graph: jest.fn(async () => ({ data: [cartRow] })),
  }
  const campaign = {
    listCampaignItems: jest.fn(async () => [
      {
        id: "campaign-item-a",
        campaign_id: "campaign-1",
        variant_id: "variant-a",
      },
      {
        id: "campaign-item-b",
        campaign_id: "campaign-1",
        variant_id: "variant-b",
      },
    ]),
    listCampaigns: jest.fn(async () => [
      {
        id: "campaign-1",
        state: CampaignState.ACTIVE,
        rules_version: 7,
      },
    ]),
  }
  const checkout = { findExecutionForCart: jest.fn(async () => null) }
  const assembler = new CanonicalFlashSaleCartAssembler({
    query: query as never,
    campaign: campaign as never,
    checkout,
  })
  return { assembler, campaign, checkout, query }
}

const INPUT = {
  cart_id: "cart-1",
  authenticated_customer_id: "customer-1",
  command_id: COMMAND_ID,
  expected_campaign_id: "campaign-1",
  allowed_sales_channel_ids: ["sales-channel-1"],
}

describe("CanonicalFlashSaleCartAssembler", () => {
  it("derives an exact sorted snapshot from public Query and campaign modules", async () => {
    const harness = makeHarness()

    await expect(harness.assembler.assemble(INPUT)).resolves.toEqual({
      campaign_id: "campaign-1",
      subject_id: "customer-1",
      cart_id: "cart-1",
      command_id: COMMAND_ID,
      rules_version: 7,
      items: [
        {
          campaign_item_id: "campaign-item-a",
          variant_id: "variant-a",
          quantity: 3,
        },
        {
          campaign_item_id: "campaign-item-b",
          variant_id: "variant-b",
          quantity: 1,
        },
      ],
    })
    expect(harness.query.graph).toHaveBeenCalledWith({
      entity: "cart",
      fields: expect.arrayContaining([
        "customer_id",
        "currency_code",
        "region_id",
        "sales_channel_id",
        "items.variant_id",
        "items.product_id",
        "items.quantity",
      ]),
      filters: { id: "cart-1" },
    })
  })

  it("uses a matching execution snapshot for completed-cart response replay", async () => {
    const harness = makeHarness(
      cart({
        completed_at: new Date("2026-09-20T00:00:00.000Z"),
        items: [
          {
            id: "line-1",
            variant_id: "variant-a",
            product_id: "product-a",
            quantity: 3,
          },
          {
            id: "line-2",
            variant_id: "variant-b",
            product_id: "product-b",
            quantity: 1,
          },
        ],
      })
    )
    harness.checkout.findExecutionForCart.mockResolvedValueOnce({
      execution: {
        id: "execution-1",
        campaign_id: "campaign-persisted",
        subject_id: "customer-1",
        cart_id: "cart-1",
        command_id: COMMAND_ID,
        rules_version: 5,
        state: CheckoutExecutionState.COMPLETED,
      },
      items: [
        {
          campaign_item_id: "persisted-a",
          variant_id: "variant-a",
          quantity: 3,
        },
        {
          campaign_item_id: "persisted-b",
          variant_id: "variant-b",
          quantity: 1,
        },
      ],
    } as never)

    await expect(
      harness.assembler.assemble({
        ...INPUT,
        expected_campaign_id: "campaign-persisted",
      })
    ).resolves.toMatchObject({
      campaign_id: "campaign-persisted",
      rules_version: 5,
      items: [
        { campaign_item_id: "persisted-a", variant_id: "variant-a" },
        { campaign_item_id: "persisted-b", variant_id: "variant-b" },
      ],
    })
    expect(harness.campaign.listCampaignItems).not.toHaveBeenCalled()
    expect(
      harness.checkout.findExecutionForCart.mock.invocationCallOrder[0]
    ).toBeLessThan(harness.query.graph.mock.invocationCallOrder[0])
  })

  it.each([
    {
      label: "another customer",
      row: cart({ customer_id: "customer-2" }),
      code: CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
    },
    {
      label: "empty cart",
      row: cart({ items: [] }),
      code: CanonicalCartErrorCode.CART_ITEMS_INVALID,
    },
    {
      label: "custom item",
      row: cart({
        items: [{ id: "custom-1", quantity: 1, product_id: null }],
      }),
      code: CanonicalCartErrorCode.CART_ITEMS_INVALID,
    },
    {
      label: "missing region context",
      row: cart({ region_id: null }),
      code: CanonicalCartErrorCode.CART_NOT_CHECKOUT_READY,
    },
    {
      label: "already completed without execution",
      row: cart({ completed_at: new Date() }),
      code: CanonicalCartErrorCode.CART_NOT_CHECKOUT_READY,
    },
  ])("rejects $label", async ({ row, code }) => {
    await expect(
      makeHarness(row).assembler.assemble(INPUT)
    ).rejects.toMatchObject({ code })
  })

  it.each([
    {
      label: "missing publishable-key sales-channel scope",
      input: { ...INPUT, allowed_sales_channel_ids: [] },
    },
    {
      label: "a publishable key scoped to another sales channel",
      input: { ...INPUT, allowed_sales_channel_ids: ["sales-channel-2"] },
    },
  ])("hides the cart for $label", async ({ input }) => {
    await expect(makeHarness().assembler.assemble(input)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
    })
  })

  it("replays a pending execution from its immutable snapshot before readiness checks", async () => {
    const harness = makeHarness(
      cart({
        completed_at: new Date("2026-09-20T00:00:00.000Z"),
        currency_code: null,
        items: [{ id: "changed-custom-item", quantity: 99 }],
      })
    )
    harness.checkout.findExecutionForCart.mockResolvedValueOnce({
      execution: {
        id: "execution-pending",
        campaign_id: "campaign-1",
        subject_id: "customer-1",
        cart_id: "cart-1",
        command_id: COMMAND_ID,
        rules_version: 5,
        state: CheckoutExecutionState.COMMERCE_PENDING,
      },
      items: [
        {
          campaign_item_id: "persisted-a",
          variant_id: "variant-a",
          quantity: 3,
        },
      ],
    } as never)

    await expect(harness.assembler.assemble(INPUT)).resolves.toMatchObject({
      campaign_id: "campaign-1",
      rules_version: 5,
      items: [
        {
          campaign_item_id: "persisted-a",
          variant_id: "variant-a",
          quantity: 3,
        },
      ],
    })
    expect(harness.campaign.listCampaignItems).not.toHaveBeenCalled()
  })

  it("rejects a cart touching multiple active campaigns", async () => {
    const harness = makeHarness()
    harness.campaign.listCampaignItems.mockResolvedValueOnce([
      {
        id: "campaign-item-a",
        campaign_id: "campaign-1",
        variant_id: "variant-a",
      },
      {
        id: "campaign-item-b",
        campaign_id: "campaign-2",
        variant_id: "variant-b",
      },
    ] as never)
    harness.campaign.listCampaigns.mockResolvedValueOnce([
      { id: "campaign-1", state: CampaignState.ACTIVE, rules_version: 1 },
      { id: "campaign-2", state: CampaignState.SCHEDULED, rules_version: 1 },
    ] as never)

    await expect(harness.assembler.assemble(INPUT)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.MULTIPLE_FLASH_SALE_CAMPAIGNS,
    })
  })

  it("rejects inactive, incomplete, or ambiguous campaign mappings", async () => {
    const inactive = makeHarness()
    inactive.campaign.listCampaigns.mockResolvedValueOnce([
      { id: "campaign-1", state: CampaignState.SCHEDULED, rules_version: 7 },
    ] as never)
    await expect(inactive.assembler.assemble(INPUT)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.FLASH_SALE_CAMPAIGN_NOT_FOUND,
    })

    const incomplete = makeHarness()
    incomplete.campaign.listCampaignItems.mockResolvedValueOnce([
      {
        id: "campaign-item-a",
        campaign_id: "campaign-1",
        variant_id: "variant-a",
      },
    ] as never)
    await expect(incomplete.assembler.assemble(INPUT)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.CART_ITEMS_INVALID,
    })

    const ambiguous = makeHarness()
    ambiguous.campaign.listCampaignItems.mockResolvedValueOnce([
      {
        id: "campaign-item-a-1",
        campaign_id: "campaign-1",
        variant_id: "variant-a",
      },
      {
        id: "campaign-item-a-2",
        campaign_id: "campaign-1",
        variant_id: "variant-a",
      },
      {
        id: "campaign-item-b",
        campaign_id: "campaign-1",
        variant_id: "variant-b",
      },
    ] as never)
    await expect(ambiguous.assembler.assemble(INPUT)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.CART_ITEMS_INVALID,
    })

    await expect(
      makeHarness().assembler.assemble({
        ...INPUT,
        expected_campaign_id: "client-selected-other-campaign",
      })
    ).rejects.toMatchObject({
      code: CanonicalCartErrorCode.FLASH_SALE_CAMPAIGN_NOT_FOUND,
    })
  })

  it("fails closed when the persisted execution key or cart snapshot changed", async () => {
    const harness = makeHarness(
      cart({
        completed_at: new Date("2026-09-20T00:00:00.000Z"),
        items: [{ id: "changed-custom-item", quantity: 99 }],
      })
    )
    harness.checkout.findExecutionForCart.mockResolvedValueOnce({
      execution: {
        command_id: "b".repeat(64),
        subject_id: "customer-1",
        cart_id: "cart-1",
      },
      items: [],
    } as never)

    await expect(harness.assembler.assemble(INPUT)).rejects.toMatchObject({
      code: CanonicalCartErrorCode.EXECUTION_IDENTITY_CONFLICT,
    })
    expect(harness.campaign.listCampaignItems).not.toHaveBeenCalled()
  })
})
