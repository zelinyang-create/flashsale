import { model } from "@medusajs/framework/utils"
import { CapacityMovementBucket, CapacityMovementKind } from "../../../types"
import Capacity from "./capacity"
import PurchaseAttempt from "./purchase-attempt"

const CapacityMovement = model
  .define(
    {
      name: "FlashSaleCapacityMovement",
      tableName: "flash_sale_capacity_movement",
    },
    {
      id: model.id({ prefix: "fsmov" }).primaryKey(),
      capacity: model.belongsTo(() => Capacity, { mappedBy: "movements" }),
      attempt: model.belongsTo(() => PurchaseAttempt, {
        mappedBy: "capacity_movements",
      }),
      campaign_id: model.text(),
      subject_id: model.text(),
      campaign_item_id: model.text(),
      transition_version: model.number(),
      kind: model.enum(CapacityMovementKind),
      from_bucket: model.enum(CapacityMovementBucket),
      to_bucket: model.enum(CapacityMovementBucket),
      quantity: model.bigNumber(),
      fence_token: model.text(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_movement_attempt_item_transition_unique",
      on: ["attempt_id", "campaign_item_id", "transition_version"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_movement_capacity_created",
      on: ["capacity_id", "created_at", "id"],
      where: "deleted_at IS NULL",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_movement_transition_version",
      expression: "transition_version >= 1",
    },
    {
      name: "CK_flash_sale_movement_quantity",
      expression: "quantity > 0",
    },
    {
      name: "CK_flash_sale_movement_fence_token",
      expression: "fence_token ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_movement_bounded_identity",
      expression:
        "char_length(campaign_id) BETWEEN 1 AND 255 AND char_length(subject_id) BETWEEN 1 AND 255 AND char_length(campaign_item_id) BETWEEN 1 AND 255",
    },
    {
      name: "CK_flash_sale_movement_route",
      expression:
        "(kind = 'hold' AND from_bucket = 'available' AND to_bucket = 'held') OR " +
        "(kind = 'consume' AND from_bucket = 'held' AND to_bucket = 'consumed') OR " +
        "(kind IN ('release', 'expire') AND from_bucket = 'held' AND to_bucket = 'available')",
    },
  ])

export default CapacityMovement
