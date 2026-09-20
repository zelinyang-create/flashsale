import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  createCanonicalFlashSaleCartAssembler,
  createMedusaFlashSaleCheckoutOrchestrator,
  hashFlashSaleIdempotencyKey,
  mapFlashSaleCheckoutResult,
  toPublicFlashSaleCheckoutError,
} from "../../../../../orchestration/flash-sale-checkout"
import { StoreCheckoutFlashSale } from "./validators"

type StoreFlashSaleCheckoutResponse = Readonly<Record<string, unknown>>

export const POST = async (
  req: AuthenticatedMedusaRequest<StoreCheckoutFlashSale>,
  res: MedusaResponse<StoreFlashSaleCheckoutResponse>
) => {
  try {
    const commandId = hashFlashSaleIdempotencyKey(
      req.headers["idempotency-key"]
    )
    const canonical = await createCanonicalFlashSaleCartAssembler(
      req.scope
    ).assemble({
      cart_id: req.validatedBody.cart_id,
      authenticated_customer_id: req.auth_context.actor_id,
      command_id: commandId,
      expected_campaign_id: req.params.campaign_id,
      allowed_sales_channel_ids:
        req.publishable_key_context?.sales_channel_ids ?? [],
    })
    const result = await createMedusaFlashSaleCheckoutOrchestrator(
      req.scope
    ).run(canonical)
    const response = mapFlashSaleCheckoutResult(result)
    res.status(response.status).json(response.body)
  } catch (error) {
    throw toPublicFlashSaleCheckoutError(error)
  }
}
