import {
  CampaignState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
} from "../types"

export const CHECKOUT_BLOCKING_CAMPAIGN_STATES = Object.freeze([
  CampaignState.SCHEDULED,
  CampaignState.ACTIVE,
] as const)

export function filterCheckoutBlockingCampaignCandidates(
  campaigns: readonly FlashSaleCampaignDTO[],
  items: readonly FlashSaleCampaignItemDTO[]
): Readonly<{
  campaigns: FlashSaleCampaignDTO[]
  items: FlashSaleCampaignItemDTO[]
}> {
  const eligibleCampaigns = campaigns.filter((campaign) =>
    CHECKOUT_BLOCKING_CAMPAIGN_STATES.includes(
      campaign.state as (typeof CHECKOUT_BLOCKING_CAMPAIGN_STATES)[number]
    )
  )
  const ids = new Set(eligibleCampaigns.map((campaign) => campaign.id))
  return {
    campaigns: eligibleCampaigns,
    items: items.filter((item) => ids.has(item.campaign_id)),
  }
}
