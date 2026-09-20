import { model } from "@medusajs/framework/utils"

const AllocationOutboxControl = model.define(
  {
    name: "FlashSaleAllocationOutboxControl",
    tableName: "flash_sale_allocation_outbox_control",
  },
  {
    id: model.id({ prefix: "fsaobctl" }).primaryKey(),
    required_after: model.dateTime(),
  }
)

export default AllocationOutboxControl
