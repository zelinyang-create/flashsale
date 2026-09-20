import { model } from "@medusajs/framework/utils"
import CheckoutExecution from "./checkout-execution"

const CheckoutExecutionItem = model
  .define(
    {
      name: "FlashSaleCheckoutExecutionItem",
      tableName: "flash_sale_checkout_execution_item",
    },
    {
      id: model.id({ prefix: "fscheckoutitem" }).primaryKey(),
      execution: model.belongsTo(() => CheckoutExecution, {
        mappedBy: "items",
      }),
      campaign_item_id: model.text(),
      variant_id: model.text(),
      quantity: model.bigNumber(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_checkout_item_campaign_unique",
      on: ["execution_id", "campaign_item_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_checkout_item_variant_unique",
      on: ["execution_id", "variant_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_checkout_item_quantity",
      expression: "quantity > 0",
    },
  ])

export default CheckoutExecutionItem
