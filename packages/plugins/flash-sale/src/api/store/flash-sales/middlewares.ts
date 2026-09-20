import { authenticate, validateAndTransformBody } from "@medusajs/framework"
import { MedusaRequestHandler } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { MiddlewareRoute } from "@medusajs/medusa"
import {
  StoreCheckoutFlashSale,
  StoreCheckoutFlashSaleParams,
} from "./[campaign_id]/checkout/validators"

export const validateFlashSaleCheckoutParams: MedusaRequestHandler = (
  req,
  _res,
  next
) => {
  if (!StoreCheckoutFlashSaleParams.safeParse(req.params).success) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Flash-sale campaign identifier is invalid"
    )
  }
  next()
}

export const storeFlashSaleMiddlewares: MiddlewareRoute[] = [
  {
    method: "POST",
    matcher: "/store/flash-sales/:campaign_id/checkout",
    middlewares: [
      authenticate("customer", ["session", "bearer"]),
      validateFlashSaleCheckoutParams,
      validateAndTransformBody(StoreCheckoutFlashSale),
    ],
  },
]
