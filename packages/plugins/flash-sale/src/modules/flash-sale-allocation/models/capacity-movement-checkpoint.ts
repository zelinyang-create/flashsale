import { model } from "@medusajs/framework/utils"
import Capacity from "./capacity"

const CapacityMovementCheckpoint = model
  .define(
    {
      name: "FlashSaleCapacityMovementCheckpoint",
      tableName: "flash_sale_capacity_movement_checkpoint",
    },
    {
      id: model.id({ prefix: "fsmovcp" }).primaryKey(),
      activation_id: model.text(),
      capacity: model.belongsTo(() => Capacity, {
        mappedBy: "movement_checkpoints",
      }),
      campaign_item_id: model.text(),
      shard_no: model.number(),
      opening_granted_quantity: model.bigNumber(),
      opening_available_quantity: model.bigNumber(),
      opening_held_quantity: model.bigNumber(),
      opening_consumed_quantity: model.bigNumber(),
      capacity_version: model.number(),
      activated_at: model.dateTime(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_movement_checkpoint_activation_capacity_unique",
      on: ["activation_id", "capacity_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_movement_checkpoint_route_unique",
      on: ["activation_id", "campaign_item_id", "shard_no"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_movement_checkpoint_quantities",
      expression:
        "opening_granted_quantity > 0 AND opening_available_quantity >= 0 AND opening_held_quantity >= 0 AND opening_consumed_quantity >= 0 AND opening_available_quantity + opening_held_quantity + opening_consumed_quantity = opening_granted_quantity",
    },
    {
      name: "CK_flash_sale_movement_checkpoint_version",
      expression: "capacity_version >= 1 AND shard_no >= 0",
    },
    {
      name: "CK_flash_sale_movement_checkpoint_identity",
      expression:
        "char_length(activation_id) BETWEEN 1 AND 255 AND char_length(campaign_item_id) BETWEEN 1 AND 255",
    },
  ])

export default CapacityMovementCheckpoint
