import { model } from "@medusajs/framework/utils"
import { CampaignState } from "../../../types"
import CampaignItem from "./campaign-item"

const Campaign = model
  .define(
    { name: "FlashSaleCampaign", tableName: "flash_sale_campaign" },
    {
      id: model.id({ prefix: "fscamp" }).primaryKey(),
      name: model.text().searchable(),
      description: model.text().searchable().nullable(),
      state: model.enum(CampaignState).default(CampaignState.DRAFT),
      starts_at: model.dateTime().nullable(),
      ends_at: model.dateTime().nullable(),
      version: model.number().default(1),
      rules_version: model.number().default(1),
      campaign_epoch: model.number().default(1),
      hold_ttl_seconds: model.number().default(300),
      per_subject_limit: model.number().default(1),
      items: model.hasMany(() => CampaignItem, {
        mappedBy: "campaign",
      }),
      metadata: model.json().nullable(),
    }
  )
  .cascades({
    delete: ["items"],
  })
  .indexes([
    {
      name: "IDX_flash_sale_campaign_state",
      on: ["state"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_flash_sale_campaign_schedule",
      on: ["starts_at", "ends_at"],
      where: "deleted_at IS NULL",
    },
  ])

export default Campaign
