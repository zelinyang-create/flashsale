import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"

export type AllocationItemInput = Readonly<{
  campaign_item_id: string
  quantity: number
}>

export type NormalizedAllocationItem = Readonly<{
  campaign_item_id: string
  quantity: number
}>

/**
 * Establishes the sole lock/acquisition order for a multi-item request.
 * Input item order is intentionally never trusted.
 */
export function normalizeAllocationItems(
  items: readonly AllocationItemInput[]
): NormalizedAllocationItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.EMPTY_ALLOCATION_ITEMS,
      "At least one allocation item is required"
    )
  }

  const seenCampaignItemIds = new Set<string>()
  const normalizedItems = items.map((item) => {
    if (
      !item ||
      typeof item.campaign_item_id !== "string" ||
      !item.campaign_item_id
    ) {
      throw new AllocationDomainError(
        AllocationDomainErrorCode.INVALID_CAMPAIGN_ITEM_ID,
        "Each allocation item must have a non-empty campaign_item_id"
      )
    }

    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new AllocationDomainError(
        AllocationDomainErrorCode.INVALID_ALLOCATION_ITEM_QUANTITY,
        "Each allocation item quantity must be a positive safe integer"
      )
    }

    if (seenCampaignItemIds.has(item.campaign_item_id)) {
      throw new AllocationDomainError(
        AllocationDomainErrorCode.DUPLICATE_CAMPAIGN_ITEM_ID,
        `Duplicate campaign_item_id: ${item.campaign_item_id}`
      )
    }

    seenCampaignItemIds.add(item.campaign_item_id)

    return {
      campaign_item_id: item.campaign_item_id,
      quantity: item.quantity,
    }
  })

  return normalizedItems.sort((left, right) => {
    if (left.campaign_item_id < right.campaign_item_id) {
      return -1
    }

    if (left.campaign_item_id > right.campaign_item_id) {
      return 1
    }

    return 0
  })
}
