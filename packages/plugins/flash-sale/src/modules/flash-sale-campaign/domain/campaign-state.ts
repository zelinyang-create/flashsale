import { CampaignState } from "../../../types"

const ALLOWED_CAMPAIGN_STATE_TRANSITIONS: Readonly<
  Record<CampaignState, readonly CampaignState[]>
> = {
  [CampaignState.DRAFT]: [CampaignState.SCHEDULED, CampaignState.CANCELLED],
  [CampaignState.SCHEDULED]: [CampaignState.ACTIVE, CampaignState.CANCELLED],
  [CampaignState.ACTIVE]: [CampaignState.ENDED, CampaignState.CANCELLED],
  [CampaignState.ENDED]: [],
  [CampaignState.CANCELLED]: [],
}

export class InvalidCampaignStateTransitionError extends Error {
  readonly code = "INVALID_CAMPAIGN_STATE_TRANSITION"

  constructor(from: CampaignState, to: CampaignState) {
    super(`Campaign cannot transition from ${from} to ${to}`)
    this.name = "InvalidCampaignStateTransitionError"
  }
}

/**
 * Returns whether a transition is valid. Reapplying the current state is a
 * deliberate no-op so workflow retries remain idempotent.
 */
export function canTransitionCampaignState(
  from: CampaignState,
  to: CampaignState
): boolean {
  return from === to || ALLOWED_CAMPAIGN_STATE_TRANSITIONS[from].includes(to)
}

export function assertCampaignStateTransition(
  from: CampaignState,
  to: CampaignState
): void {
  if (!canTransitionCampaignState(from, to)) {
    throw new InvalidCampaignStateTransitionError(from, to)
  }
}
