import { model } from "@medusajs/framework/utils"
import { AllocationHoldState } from "../../../types"
import Capacity from "./capacity"
import PurchaseAttempt from "./purchase-attempt"

const AllocationHold = model
  .define(
    {
      name: "FlashSaleAllocationHold",
      tableName: "flash_sale_allocation_hold",
    },
    {
      id: model.id({ prefix: "fsahold" }).primaryKey(),
      attempt: model.belongsTo(() => PurchaseAttempt, {
        mappedBy: "holds",
      }),
      capacity: model.belongsTo(() => Capacity, {
        mappedBy: "holds",
      }),
      campaign_item_id: model.text(),
      quantity: model.bigNumber(),
      state: model.enum(AllocationHoldState).default(AllocationHoldState.HELD),
      expires_at: model.dateTime(),
      version: model.number().default(1),
      resolved_at: model.dateTime().nullable(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_hold_attempt_item_unique",
      on: ["attempt_id", "campaign_item_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_hold_capacity_state",
      on: ["capacity_id", "state"],
      where: null,
    },
    {
      name: "IDX_flash_sale_hold_held_expiry",
      on: ["state", "expires_at"],
      where: "deleted_at IS NULL AND state = 'held'",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_hold_quantity",
      expression: "quantity > 0",
    },
    {
      name: "CK_flash_sale_hold_version",
      expression: "version >= 1",
    },
  ])

export default AllocationHold
