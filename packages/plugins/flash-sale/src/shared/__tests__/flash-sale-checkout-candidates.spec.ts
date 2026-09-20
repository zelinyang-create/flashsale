import { CampaignState } from "../../types"
import {
  CHECKOUT_BLOCKING_CAMPAIGN_STATES,
  filterCheckoutBlockingCampaignCandidates,
} from "../flash-sale-checkout-candidates"

describe("checkout-blocking campaign candidate contract", () => {
  it("keeps SCHEDULED and ACTIVE in one shared ambiguity set", () => {
    expect(CHECKOUT_BLOCKING_CAMPAIGN_STATES).toEqual([
      CampaignState.SCHEDULED,
      CampaignState.ACTIVE,
    ])
    const candidates = filterCheckoutBlockingCampaignCandidates(
      [
        { id: "scheduled", state: CampaignState.SCHEDULED },
        { id: "active", state: CampaignState.ACTIVE },
        { id: "ended", state: CampaignState.ENDED },
      ] as never,
      [
        { id: "item-s", campaign_id: "scheduled" },
        { id: "item-a", campaign_id: "active" },
        { id: "item-e", campaign_id: "ended" },
      ] as never
    )

    expect(candidates.campaigns.map((campaign) => campaign.id)).toEqual([
      "scheduled",
      "active",
    ])
    expect(candidates.items.map((item) => item.id)).toEqual([
      "item-s",
      "item-a",
    ])
  })
})
