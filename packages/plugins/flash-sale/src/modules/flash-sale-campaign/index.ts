import { Module } from "@medusajs/framework/utils"
import { FlashSalePluginModule } from "../../types"
import FlashSaleCampaignModuleService from "./service"

export * from "./domain"
export * from "./models"
export { FlashSaleCampaignModuleService }

export default Module(FlashSalePluginModule.CAMPAIGN, {
  service: FlashSaleCampaignModuleService,
})
