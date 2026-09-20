import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import { FlashSalePluginModule } from "../../../types"
import {
  AllocationLifecycleModuleService,
  CampaignAllocationSnapshot,
} from "../contracts"
import { policyReference } from "./shared"

/**
 * There is deliberately no compensation. A PREPARED policy rejects checkout,
 * so retaining it is fail-closed and gives retries the durable idempotency
 * anchor. Deleting it would make an uncertain schedule impossible to resume.
 */
export const provisionCampaignAllocationStep = createStep(
  "provision-campaign-allocation",
  async (snapshot: CampaignAllocationSnapshot, { container }) => {
    const service = container.resolve<AllocationLifecycleModuleService>(
      FlashSalePluginModule.ALLOCATION
    )
    const result = await service.provisionAllocation({
      campaign_id: snapshot.id,
      rules_version: snapshot.rules_version,
      configuration_hash: snapshot.configuration_hash,
      starts_at: snapshot.starts_at,
      ends_at: snapshot.ends_at,
      hold_ttl_seconds: snapshot.hold_ttl_seconds,
      per_subject_limit: snapshot.per_subject_limit,
      items: snapshot.items.map((item) => ({
        campaign_item_id: item.campaign_item_id,
        quota: item.quota,
      })),
    })
    return new StepResponse(policyReference(result.policy))
  }
)
