import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  CampaignState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  FlashSalePluginModule,
} from "../../types"
import {
  CheckoutExecutionSnapshot,
  FlashSaleCheckoutItem,
  ServerCanonicalFlashSaleCheckoutCommand,
} from "./contracts"
import { filterCheckoutBlockingCampaignCandidates } from "../../shared/flash-sale-checkout-candidates"

const MAX_IDENTIFIER_LENGTH = 255

export enum CanonicalCartErrorCode {
  INVALID_CART_ID = "INVALID_CART_ID",
  CART_NOT_FOUND_OR_UNAVAILABLE = "CART_NOT_FOUND_OR_UNAVAILABLE",
  CART_NOT_CHECKOUT_READY = "CART_NOT_CHECKOUT_READY",
  CART_ITEMS_INVALID = "CART_ITEMS_INVALID",
  FLASH_SALE_CAMPAIGN_NOT_FOUND = "FLASH_SALE_CAMPAIGN_NOT_FOUND",
  MULTIPLE_FLASH_SALE_CAMPAIGNS = "MULTIPLE_FLASH_SALE_CAMPAIGNS",
  EXECUTION_IDENTITY_CONFLICT = "EXECUTION_IDENTITY_CONFLICT",
}

export class CanonicalCartError extends Error {
  constructor(readonly code: CanonicalCartErrorCode, message: string) {
    super(message)
    this.name = "CanonicalCartError"
  }
}

type QueryGraphPort = Readonly<{
  graph(input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }): Promise<{ data: unknown[] }>
}>

type CampaignReadPort = Readonly<{
  listCampaigns(
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignDTO[]>
  listCampaignItems(
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignItemDTO[]>
}>

type CheckoutReadPort = Readonly<{
  findExecutionForCart(command: {
    cart_id: string
  }): Promise<CheckoutExecutionSnapshot | null>
}>

type CanonicalCartRow = Readonly<{
  id?: unknown
  customer_id?: unknown
  completed_at?: unknown
  currency_code?: unknown
  region_id?: unknown
  sales_channel_id?: unknown
  items?: unknown
}>

type CanonicalLineItem = Readonly<{
  id?: unknown
  variant_id?: unknown
  product_id?: unknown
  quantity?: unknown
}>

export type CanonicalCartAssemblerDependencies = Readonly<{
  query: QueryGraphPort
  campaign: CampaignReadPort
  checkout: CheckoutReadPort
}>

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= MAX_IDENTIFIER_LENGTH
  )
}

function normalizeCartItems(value: unknown): ReadonlyArray<{
  variant_id: string
  quantity: number
}> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new CanonicalCartError(
      CanonicalCartErrorCode.CART_ITEMS_INVALID,
      "Cart must contain checkout-ready line items"
    )
  }
  const quantities = new Map<string, number>()
  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_ITEMS_INVALID,
        "Cart contains an invalid line item"
      )
    }
    const item = rawItem as CanonicalLineItem
    const quantity = Number(item.quantity)
    if (
      !identifier(item.id) ||
      !identifier(item.variant_id) ||
      !identifier(item.product_id) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_ITEMS_INVALID,
        "Cart contains a custom or unresolved line item"
      )
    }
    const total = (quantities.get(item.variant_id) ?? 0) + quantity
    if (!Number.isSafeInteger(total)) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_ITEMS_INVALID,
        "Cart line-item quantity is invalid"
      )
    }
    quantities.set(item.variant_id, total)
  }
  return [...quantities.entries()]
    .map(([variant_id, quantity]) => ({ variant_id, quantity }))
    .sort((left, right) => left.variant_id.localeCompare(right.variant_id))
}

function assertReplayIdentity(
  snapshot: CheckoutExecutionSnapshot,
  commandId: string,
  customerId: string,
  cartId: string,
  expectedCampaignId: string
): ServerCanonicalFlashSaleCheckoutCommand {
  const execution = snapshot.execution
  const executionItems = snapshot.items
    .map((item) => ({
      campaign_item_id: item.campaign_item_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }))
    .sort((left, right) => left.variant_id.localeCompare(right.variant_id))
  if (
    execution.command_id !== commandId ||
    execution.campaign_id !== expectedCampaignId ||
    execution.subject_id !== customerId ||
    execution.cart_id !== cartId
  ) {
    throw new CanonicalCartError(
      CanonicalCartErrorCode.EXECUTION_IDENTITY_CONFLICT,
      "Cart checkout identity conflicts with the existing execution"
    )
  }
  return {
    campaign_id: execution.campaign_id,
    subject_id: customerId,
    cart_id: cartId,
    command_id: commandId,
    rules_version: execution.rules_version,
    items: executionItems,
  }
}

export class CanonicalFlashSaleCartAssembler {
  constructor(
    private readonly dependencies: CanonicalCartAssemblerDependencies
  ) {}

  async assemble(input: {
    cart_id: string
    authenticated_customer_id: string
    command_id: string
    expected_campaign_id: string
    allowed_sales_channel_ids: readonly string[]
  }): Promise<ServerCanonicalFlashSaleCheckoutCommand> {
    if (!identifier(input.cart_id)) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.INVALID_CART_ID,
        "Cart identifier is invalid"
      )
    }
    if (!identifier(input.authenticated_customer_id)) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
        "Authenticated customer is required"
      )
    }
    if (!identifier(input.expected_campaign_id)) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.FLASH_SALE_CAMPAIGN_NOT_FOUND,
        "Flash-sale campaign identifier is invalid"
      )
    }
    const existing = await this.dependencies.checkout.findExecutionForCart({
      cart_id: input.cart_id,
    })
    const allowedSalesChannels = Array.isArray(input.allowed_sales_channel_ids)
      ? input.allowed_sales_channel_ids.filter(identifier)
      : []
    const { data } = await this.dependencies.query.graph({
      entity: "cart",
      fields: [
        "id",
        "customer_id",
        "completed_at",
        "currency_code",
        "region_id",
        "sales_channel_id",
        "items.id",
        "items.variant_id",
        "items.product_id",
        "items.quantity",
      ],
      filters: { id: input.cart_id },
    })
    if (data.length !== 1) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
        "Cart is not available to this Store caller"
      )
    }
    const cart = data[0] as CanonicalCartRow
    if (
      cart.id !== input.cart_id ||
      cart.customer_id !== input.authenticated_customer_id ||
      !identifier(cart.sales_channel_id) ||
      allowedSalesChannels.length === 0 ||
      !allowedSalesChannels.includes(cart.sales_channel_id)
    ) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
        "Cart is not available to this Store caller"
      )
    }
    if (existing) {
      if (existing.execution.subject_id !== input.authenticated_customer_id) {
        throw new CanonicalCartError(
          CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
          "Cart is not available to this Store caller"
        )
      }
      return assertReplayIdentity(
        existing,
        input.command_id,
        input.authenticated_customer_id,
        input.cart_id,
        input.expected_campaign_id
      )
    }
    if (
      !identifier(cart.currency_code) ||
      !identifier(cart.region_id) ||
      !identifier(cart.sales_channel_id)
    ) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_CHECKOUT_READY,
        "Cart is not ready for checkout"
      )
    }
    const cartItems = normalizeCartItems(cart.items)
    if (cart.completed_at !== null && cart.completed_at !== undefined) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_CHECKOUT_READY,
        "Cart has already been completed"
      )
    }

    const campaignItems = await this.dependencies.campaign.listCampaignItems(
      { variant_id: cartItems.map((item) => item.variant_id) },
      { order: { id: "ASC" } }
    )
    const campaignIds = [
      ...new Set(campaignItems.map((item) => item.campaign_id)),
    ]
    const candidateSet = campaignIds.length
      ? filterCheckoutBlockingCampaignCandidates(
          await this.dependencies.campaign.listCampaigns(
            { id: campaignIds },
            { order: { id: "ASC" } }
          ),
          campaignItems
        )
      : { campaigns: [], items: [] }
    const candidateCampaigns = candidateSet.campaigns
    const candidateItems = candidateSet.items
    const touchedCampaignIds = new Set(
      candidateItems.map((item) => item.campaign_id)
    )
    if (touchedCampaignIds.size > 1) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.MULTIPLE_FLASH_SALE_CAMPAIGNS,
        "Cart matches multiple scheduled or active flash-sale campaigns"
      )
    }
    if (touchedCampaignIds.size !== 1) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.FLASH_SALE_CAMPAIGN_NOT_FOUND,
        "Cart does not match an active flash-sale campaign"
      )
    }
    const campaignId = [...touchedCampaignIds][0]
    const campaign = candidateCampaigns.find((entry) => entry.id === campaignId)
    if (
      !campaign ||
      campaign.id !== input.expected_campaign_id ||
      campaign.state !== CampaignState.ACTIVE
    ) {
      throw new CanonicalCartError(
        CanonicalCartErrorCode.FLASH_SALE_CAMPAIGN_NOT_FOUND,
        "Cart does not match the requested active flash-sale campaign"
      )
    }
    const items: FlashSaleCheckoutItem[] = cartItems.map((cartItem) => {
      const matches = candidateItems.filter(
        (item) =>
          item.campaign_id === campaignId &&
          item.variant_id === cartItem.variant_id
      )
      if (matches.length !== 1) {
        throw new CanonicalCartError(
          CanonicalCartErrorCode.CART_ITEMS_INVALID,
          "Every cart variant must map exactly once to the campaign"
        )
      }
      return {
        campaign_item_id: matches[0].id,
        variant_id: cartItem.variant_id,
        quantity: cartItem.quantity,
      }
    })
    return {
      campaign_id: campaign.id,
      subject_id: input.authenticated_customer_id,
      cart_id: input.cart_id,
      command_id: input.command_id,
      rules_version: campaign.rules_version,
      items,
    }
  }
}

export function createCanonicalFlashSaleCartAssembler(
  container: MedusaContainer
): CanonicalFlashSaleCartAssembler {
  return new CanonicalFlashSaleCartAssembler({
    query: container.resolve<QueryGraphPort>(ContainerRegistrationKeys.QUERY),
    campaign: container.resolve<CampaignReadPort>(
      FlashSalePluginModule.CAMPAIGN
    ),
    checkout: container.resolve<CheckoutReadPort>(
      FlashSalePluginModule.CHECKOUT
    ),
  })
}
