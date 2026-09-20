import { model } from "@medusajs/framework/utils"
import { AllocationFenceDisposition } from "../../../types"

const AllocationCampaignFence = model
  .define(
    {
      name: "FlashSaleAllocationCampaignFence",
      tableName: "flash_sale_allocation_campaign_fence",
    },
    {
      id: model.id({ prefix: "fsafence" }).primaryKey(),
      campaign_id: model.text(),
      disposition: model.enum(AllocationFenceDisposition),
      campaign_version: model.number(),
      rules_version: model.number(),
      version: model.number().default(1),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_allocation_campaign_fence_campaign_unique",
      on: ["campaign_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_allocation_campaign_fence_campaign_version",
      expression: "campaign_version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_campaign_fence_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_campaign_fence_version",
      expression: "version >= 1",
    },
  ])

export default AllocationCampaignFence
