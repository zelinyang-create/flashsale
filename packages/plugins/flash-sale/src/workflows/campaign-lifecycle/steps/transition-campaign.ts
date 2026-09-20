import { MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import { CampaignState, FlashSalePluginModule } from "../../../types"
import {
  CampaignAllocationSnapshot,
  CampaignLifecycleModuleService,
  SerializableCampaign,
} from "../contracts"
import { mapCampaign } from "./shared"

async function transitionSnapshotCampaign(
  snapshot: CampaignAllocationSnapshot,
  target: CampaignState,
  service: CampaignLifecycleModuleService
): Promise<SerializableCampaign> {
  return mapCampaign(
    await service.transitionCampaignStateFromSnapshot({
      campaign_id: snapshot.id,
      target_state: target,
      expected_version: snapshot.version,
      expected_rules_version: snapshot.rules_version,
      expected_items: snapshot.items.map((item) => ({
        campaign_item_id: item.campaign_item_id,
        quota: item.quota,
        version: item.version,
      })),
    })
  )
}

async function transitionObservedCampaign(
  observed: SerializableCampaign,
  target: CampaignState,
  service: CampaignLifecycleModuleService
): Promise<SerializableCampaign> {
  let expected = observed
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return mapCampaign(
        await service.transitionCampaignStateWithVersion({
          campaign_id: expected.id,
          target_state: target,
          expected_version: expected.version,
          expected_rules_version: expected.rules_version,
        })
      )
    } catch (error) {
      if (
        !(error instanceof MedusaError) ||
        error.type !== MedusaError.Types.CONFLICT ||
        attempt === 2
      ) {
        throw error
      }
      expected = mapCampaign(await service.retrieveCampaign(observed.id))
    }
  }
  throw new MedusaError(
    MedusaError.Types.CONFLICT,
    `Campaign ${observed.id} kept changing before the ${target} transition`
  )
}

// Campaign transitions are audit state and intentionally have no reverse step.
// Every following operation is fail-closed and safe to replay.
export const scheduleCampaignStateStep = createStep(
  "schedule-campaign-state",
  async (snapshot: CampaignAllocationSnapshot, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    return new StepResponse(
      await transitionSnapshotCampaign(snapshot, CampaignState.SCHEDULED, service)
    )
  }
)

export const activateCampaignStateStep = createStep(
  "activate-campaign-state",
  async (snapshot: CampaignAllocationSnapshot, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    return new StepResponse(
      await transitionSnapshotCampaign(snapshot, CampaignState.ACTIVE, service)
    )
  }
)

export const cancelCampaignStateStep = createStep(
  "cancel-campaign-state",
  async (campaign: SerializableCampaign, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    return new StepResponse(
      await transitionObservedCampaign(campaign, CampaignState.CANCELLED, service)
    )
  }
)

export const endCampaignStateStep = createStep(
  "end-campaign-state",
  async (campaign: SerializableCampaign, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    return new StepResponse(
      await transitionObservedCampaign(campaign, CampaignState.ENDED, service)
    )
  }
)
