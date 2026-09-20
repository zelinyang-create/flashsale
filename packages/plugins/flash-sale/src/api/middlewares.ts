import { defineMiddlewares } from "@medusajs/framework"
import { storeFlashSaleMiddlewares } from "./store/flash-sales/middlewares"

export default defineMiddlewares({
  routes: [...storeFlashSaleMiddlewares],
})
