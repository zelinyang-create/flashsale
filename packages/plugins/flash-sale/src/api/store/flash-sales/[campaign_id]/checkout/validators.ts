import { z } from "@medusajs/framework/zod"

export const StoreCheckoutFlashSaleParams = z
  .object({
    campaign_id: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  })
  .strict()

export const StoreCheckoutFlashSale = z
  .object({
    cart_id: z.string().trim().min(1).max(255),
  })
  .strict()

export type StoreCheckoutFlashSale = z.infer<typeof StoreCheckoutFlashSale>
