import { Module } from "@medusajs/framework/utils"
import { FlashSalePluginModule } from "../../types"
import FlashSaleAllocationModuleService from "./service"

export * from "./application"
export * from "./domain"
export * from "./models"
export * from "./persistence"
export { FlashSaleAllocationModuleService }

export default Module(FlashSalePluginModule.ALLOCATION, {
  service: FlashSaleAllocationModuleService,
})
