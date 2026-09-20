import { Module } from "@medusajs/framework/utils"
import { FlashSalePluginModule } from "../../types"
import FlashSaleCheckoutModuleService from "./service"

export * from "./application"
export * from "./domain"
export * from "./models"
export * from "./persistence"
export { FlashSaleCheckoutModuleService }

export default Module(FlashSalePluginModule.CHECKOUT, {
  service: FlashSaleCheckoutModuleService,
})
