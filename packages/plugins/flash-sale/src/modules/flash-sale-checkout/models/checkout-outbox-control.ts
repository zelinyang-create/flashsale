import { model } from "@medusajs/framework/utils"

const CheckoutOutboxControl = model.define(
  {
    name: "FlashSaleCheckoutOutboxControl",
    tableName: "flash_sale_checkout_outbox_control",
  },
  {
    id: model.id({ prefix: "fscobctl" }).primaryKey(),
    required_after: model.dateTime(),
  }
)

export default CheckoutOutboxControl
