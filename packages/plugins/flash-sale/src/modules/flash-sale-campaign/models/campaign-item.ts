import { model } from "@medusajs/framework/utils"
import Campaign from "./campaign"

const CampaignItem = model
  .define(
    { name: "FlashSaleCampaignItem", tableName: "flash_sale_campaign_item" },
    {
      id: model.id({ prefix: "fscitem" }).primaryKey(),
      campaign: model.belongsTo(() => Campaign, {
        mappedBy: "items",
      }),
      variant_id: model.text(),
      location_id: model.text().nullable(),
      quota: model.bigNumber(),
      version: model.number().default(1),
      metadata: model.json().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_campaign_item_location_unique",
      on: ["campaign_id", "variant_id", "location_id"],
      unique: true,
      where: "deleted_at IS NULL AND location_id IS NOT NULL",
    },
    {
      name: "IDX_flash_sale_campaign_item_default_location_unique",
      on: ["campaign_id", "variant_id"],
      unique: true,
      where: "deleted_at IS NULL AND location_id IS NULL",
    },
  ])

export default CampaignItem
