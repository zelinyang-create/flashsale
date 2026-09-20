import { CampaignState } from "../../../../types"
import {
  assertCampaignStateTransition,
  canTransitionCampaignState,
  InvalidCampaignStateTransitionError,
} from "../campaign-state"

describe("campaign state transitions", () => {
  it.each([
    [CampaignState.DRAFT, CampaignState.SCHEDULED],
    [CampaignState.SCHEDULED, CampaignState.ACTIVE],
    [CampaignState.ACTIVE, CampaignState.ENDED],
  ])("allows the happy path from %s to %s", (from, to) => {
    expect(canTransitionCampaignState(from, to)).toBe(true)
    expect(() => assertCampaignStateTransition(from, to)).not.toThrow()
  })

  it.each([CampaignState.DRAFT, CampaignState.SCHEDULED, CampaignState.ACTIVE])(
    "allows %s campaigns to be cancelled",
    (from) => {
      expect(canTransitionCampaignState(from, CampaignState.CANCELLED)).toBe(
        true
      )
    }
  )

  it.each(Object.values(CampaignState))(
    "treats reapplying %s as an idempotent no-op",
    (state) => {
      expect(canTransitionCampaignState(state, state)).toBe(true)
      expect(() => assertCampaignStateTransition(state, state)).not.toThrow()
    }
  )

  it.each([
    [CampaignState.SCHEDULED, CampaignState.DRAFT],
    [CampaignState.ACTIVE, CampaignState.SCHEDULED],
    [CampaignState.ENDED, CampaignState.ACTIVE],
    [CampaignState.CANCELLED, CampaignState.DRAFT],
    [CampaignState.DRAFT, CampaignState.ACTIVE],
  ])("rejects an illegal transition from %s to %s", (from, to) => {
    expect(canTransitionCampaignState(from, to)).toBe(false)
    expect(() => assertCampaignStateTransition(from, to)).toThrow(
      InvalidCampaignStateTransitionError
    )
  })
})
