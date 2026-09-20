import { MedusaError } from "@medusajs/framework/utils"
import {
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../../types"
import {
  ALLOCATION_REQUEST_SCHEMA_VERSION,
  createCanonicalRequestFingerprint,
} from "../../modules/flash-sale-allocation"
import {
  AuthorizeCartCompletionResult,
  CartSnapshotItemInput,
  CheckoutExecutionSnapshot,
} from "../../modules/flash-sale-checkout"
import { filterCheckoutBlockingCampaignCandidates } from "../../shared/flash-sale-checkout-candidates"

type Container = {
  resolve<T>(name: string): T
}

type CampaignPort = {
  retrieveCampaign(id: string): Promise<FlashSaleCampaignDTO>
  listCampaigns(
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignDTO[]>
  listCampaignItems(
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignItemDTO[]>
}

type CheckoutPort = {
  findExecutionForCart(input: {
    cart_id: string
  }): Promise<CheckoutExecutionSnapshot | null>
  readCartCompletionAuthorization(input: {
    cart_id: string
    subject_id: string
    campaign_id: string
    rules_version: number
    commerce_transaction_id: string
    items: readonly CartSnapshotItemInput[]
  }): Promise<AuthorizeCartCompletionResult>
}

type AllocationAuthorization = {
  attempt: {
    id: string
    campaign_id: string
    subject_id: string
    cart_id: string | null
    request_hash: string
    rules_version: number
    state: PurchaseAttemptState
    settlement_id: string | null
  }
  holds: readonly {
    campaign_item_id: string
    quantity: number
  }[]
}

type AllocationPort = {
  authorizeQuotaSettlement(input: {
    attempt_id: string
    settlement_id: string
  }): Promise<AllocationAuthorization>
}

type CompleteCartData = {
  input: { id: string }
  cart: {
    id: string
    customer?: { id?: string | null } | null
    customer_id?: string | null
    items?: Array<{
      variant_id?: string | null
      quantity: number | { valueOf(): number }
    }> | null
  }
}

function deny(message: string, cause?: unknown): never {
  const error = new MedusaError(MedusaError.Types.NOT_ALLOWED, message)
  if (cause !== undefined) {
    ;(error as Error & { cause?: unknown }).cause = cause
  }
  throw error
}

function normalizedCartItems(data: CompleteCartData): {
  items: CartSnapshotItemInput[]
  hasCustomItems: boolean
} {
  if (!data.cart || data.input?.id !== data.cart.id) {
    deny("Flash-sale checkout cart identity is invalid")
  }
  const quantities = new Map<string, number>()
  let hasCustomItems = false
  for (const item of data.cart.items ?? []) {
    if (!item.variant_id) {
      hasCustomItems = true
      continue
    }
    const quantity = Number(item.quantity)
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      deny("Flash-sale checkout cart quantity is invalid")
    }
    quantities.set(
      item.variant_id,
      (quantities.get(item.variant_id) ?? 0) + quantity
    )
  }
  return {
    items: [...quantities.entries()]
      .map(([variant_id, quantity]) => ({ variant_id, quantity }))
      .sort((left, right) => left.variant_id.localeCompare(right.variant_id)),
    hasCustomItems,
  }
}

async function activeCampaignCandidates(
  campaign: CampaignPort,
  variantIds: readonly string[]
): Promise<{
  campaigns: FlashSaleCampaignDTO[]
  items: FlashSaleCampaignItemDTO[]
}> {
  if (!variantIds.length) {
    return { campaigns: [], items: [] }
  }
  const items = await campaign.listCampaignItems(
    { variant_id: variantIds },
    { order: { id: "ASC" } }
  )
  const ids = [...new Set(items.map((item) => item.campaign_id))]
  if (!ids.length) {
    return { campaigns: [], items: [] }
  }
  return filterCheckoutBlockingCampaignCandidates(
    await campaign.listCampaigns({ id: ids }, { order: { id: "ASC" } }),
    items
  )
}

export async function validateFlashSaleCartCompletion(
  data: CompleteCartData,
  container: Container,
  workflowTransactionId?: string
): Promise<void> {
  const campaign = container.resolve<CampaignPort>(
    FlashSalePluginModule.CAMPAIGN
  )
  const checkout = container.resolve<CheckoutPort>(
    FlashSalePluginModule.CHECKOUT
  )
  const allocation = container.resolve<AllocationPort>(
    FlashSalePluginModule.ALLOCATION
  )

  try {
    const normalizedCart = normalizedCartItems(data)
    const cartItems = normalizedCart.items
    const existing = await checkout.findExecutionForCart({
      cart_id: data.cart.id,
    })
    const candidates = await activeCampaignCandidates(
      campaign,
      cartItems.map((item) => item.variant_id)
    )
    const candidateIds = new Set(candidates.campaigns.map((entry) => entry.id))
    if (candidateIds.size > 1) {
      deny("Cart matches more than one flash-sale campaign")
    }
    if (!existing && candidateIds.size === 0) {
      return
    }
    if (normalizedCart.hasCustomItems) {
      deny("Flash-sale carts cannot contain custom line items")
    }

    const selectedCampaign = existing
      ? await campaign.retrieveCampaign(existing.execution.campaign_id)
      : candidates.campaigns[0]
    if (!selectedCampaign) {
      deny("Flash-sale campaign could not be resolved")
    }
    if (
      existing &&
      candidateIds.size === 1 &&
      !candidateIds.has(existing.execution.campaign_id)
    ) {
      deny("Cart execution does not match the active flash-sale campaign")
    }

    const campaignItems = existing
      ? await campaign.listCampaignItems(
          { campaign_id: selectedCampaign.id },
          { order: { id: "ASC" } }
        )
      : candidates.items.filter(
          (item) => item.campaign_id === selectedCampaign.id
        )
    const byVariant = new Map<string, FlashSaleCampaignItemDTO[]>()
    for (const item of campaignItems) {
      const entries = byVariant.get(item.variant_id) ?? []
      entries.push(item)
      byVariant.set(item.variant_id, entries)
    }
    if (
      cartItems.some(
        (item) => (byVariant.get(item.variant_id) ?? []).length !== 1
      )
    ) {
      deny(
        "Every cart variant must map exactly once to the selected flash-sale campaign"
      )
    }

    const subjectId = data.cart.customer?.id ?? data.cart.customer_id
    if (!subjectId) {
      deny("Flash-sale checkout requires an authenticated customer")
    }
    if (!workflowTransactionId?.trim()) {
      deny("Flash-sale checkout requires a workflow-bound commerce permit")
    }
    const authorized = await checkout.readCartCompletionAuthorization({
      cart_id: data.cart.id,
      subject_id: subjectId,
      campaign_id: selectedCampaign.id,
      rules_version: selectedCampaign.rules_version,
      commerce_transaction_id: workflowTransactionId,
      items: cartItems,
    })
    const expectedExecutionItems = cartItems.map((item) => ({
      campaign_item_id: byVariant.get(item.variant_id)![0].id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }))
    const actualExecutionItems = authorized.items.map((item) => ({
      campaign_item_id: item.campaign_item_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }))
    if (
      JSON.stringify(actualExecutionItems) !==
      JSON.stringify(expectedExecutionItems)
    ) {
      deny("Checkout execution items do not match the campaign snapshot")
    }
    const allocationAuthorization = await allocation.authorizeQuotaSettlement({
      attempt_id: authorized.execution.attempt_id,
      settlement_id: authorized.execution.id,
    })
    const attempt = allocationAuthorization.attempt
    const expectedHolds = expectedExecutionItems
      .map((item) => ({
        campaign_item_id: item.campaign_item_id,
        quantity: item.quantity,
      }))
      .sort((left, right) =>
        left.campaign_item_id.localeCompare(right.campaign_item_id)
      )
    const actualHolds = allocationAuthorization.holds
      .map((hold) => ({
        campaign_item_id: hold.campaign_item_id,
        quantity: hold.quantity,
      }))
      .sort((left, right) =>
        left.campaign_item_id.localeCompare(right.campaign_item_id)
      )
    const expectedRequestHash = createCanonicalRequestFingerprint({
      schema_version: ALLOCATION_REQUEST_SCHEMA_VERSION,
      campaign_id: authorized.execution.campaign_id,
      subject_id: authorized.execution.subject_id,
      cart_id: authorized.execution.cart_id,
      rules_version: authorized.execution.rules_version,
      items: expectedHolds,
    })
    if (
      attempt.id !== authorized.execution.attempt_id ||
      attempt.state !== PurchaseAttemptState.QUOTA_COMMITTING ||
      attempt.settlement_id !== authorized.execution.id ||
      attempt.campaign_id !== authorized.execution.campaign_id ||
      attempt.subject_id !== authorized.execution.subject_id ||
      attempt.cart_id !== authorized.execution.cart_id ||
      attempt.request_hash !== authorized.execution.request_hash ||
      attempt.rules_version !== authorized.execution.rules_version ||
      attempt.request_hash !== expectedRequestHash ||
      authorized.execution.request_hash !== expectedRequestHash ||
      JSON.stringify(actualHolds) !== JSON.stringify(expectedHolds)
    ) {
      deny("Flash-sale allocation does not authorize this cart completion")
    }
  } catch (error) {
    if (error instanceof MedusaError) {
      throw error
    }
    deny("Flash-sale checkout validation failed closed", error)
  }
}

export type { CompleteCartData }
