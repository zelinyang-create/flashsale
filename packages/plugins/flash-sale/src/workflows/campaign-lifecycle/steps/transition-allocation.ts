import { MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import {
  AllocationCampaignFenceDTO,
  AllocationFenceDisposition,
  FlashSalePluginModule,
} from "../../../types"
import {
  AllocationCampaignFenceReference,
  AllocationLifecycleModuleService,
  AllocationPolicyReference,
  SerializableCampaign,
  TerminalAllocationResult,
} from "../contracts"
import { policyReference } from "./shared"

export const openCampaignAllocationStep = createStep(
  "open-campaign-allocation",
  async (policy: AllocationPolicyReference, { container }) => {
    const service = container.resolve<AllocationLifecycleModuleService>(
      FlashSalePluginModule.ALLOCATION
    )
    const result = await service.openAllocation({
      policy_id: policy.id,
      expected_rules_version: policy.rules_version,
      expected_version: policy.version,
    })
    return new StepResponse(policyReference(result.policy))
  }
)

function fenceReference(
  fence: AllocationCampaignFenceDTO
): AllocationCampaignFenceReference {
  return {
    id: fence.id,
    campaign_id: fence.campaign_id,
    disposition: fence.disposition,
    campaign_version: fence.campaign_version,
    rules_version: fence.rules_version,
    version: fence.version,
  }
}

async function fenceAndCloseForCampaign(
  campaign: SerializableCampaign,
  disposition: AllocationFenceDisposition,
  service: AllocationLifecycleModuleService
): Promise<TerminalAllocationResult> {
  const result = await service.fenceAndCloseCampaignAllocation({
    campaign_id: campaign.id,
    disposition,
    campaign_version: campaign.version,
    rules_version: campaign.rules_version,
  })
  const policies = await service.listAllocationPolicies(
    {
      campaign_id: campaign.id,
      rules_version: campaign.rules_version,
    },
    { order: { id: "ASC" } }
  )
  if (policies.length > 1) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Allocation invariant violated: Campaign ${campaign.id} has multiple policies for rules version ${campaign.rules_version}`
    )
  }
  return {
    fence: fenceReference(result.fence),
    allocation_policy:
      policies.length === 0 ? null : policyReference(policies[0]),
  }
}

/**
 * Closing has no inverse compensation. Re-opening after a later Campaign
 * failure would briefly admit new purchases in an uncertain lifecycle state.
 * The safe retry is to replay close, then retry the Campaign transition.
 */
export const fenceAndCloseAllocationForCancelStep = createStep(
  "fence-and-close-allocation-for-cancel",
  async (campaign: SerializableCampaign, { container }) => {
    const service = container.resolve<AllocationLifecycleModuleService>(
      FlashSalePluginModule.ALLOCATION
    )
    return new StepResponse(
      await fenceAndCloseForCampaign(
        campaign,
        AllocationFenceDisposition.CANCELLED,
        service
      )
    )
  }
)

export const fenceAndCloseAllocationForEndStep = createStep(
  "fence-and-close-allocation-for-end",
  async (campaign: SerializableCampaign, { container }) => {
    const service = container.resolve<AllocationLifecycleModuleService>(
      FlashSalePluginModule.ALLOCATION
    )
    return new StepResponse(
      await fenceAndCloseForCampaign(
        campaign,
        AllocationFenceDisposition.ENDED,
        service
      )
    )
  }
)
