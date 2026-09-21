import { model } from "@medusajs/framework/utils"

const CapacityMovementControl = model
  .define(
    {
      name: "FlashSaleCapacityMovementControl",
      tableName: "flash_sale_capacity_movement_control",
    },
    {
      id: model.id({ prefix: "fsmovctl" }).primaryKey(),
      activation_id: model.text(),
      required_after: model.dateTime(),
      schema_version: model.number(),
      checkpoint_digest: model.text(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_movement_control_activation_unique",
      on: ["activation_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_movement_control_singleton",
      expression: "id = 'allocation-movement-ledger'",
    },
    {
      name: "CK_flash_sale_movement_control_schema",
      expression:
        "schema_version >= 1 AND char_length(activation_id) BETWEEN 1 AND 255 AND checkpoint_digest ~ '^[0-9a-f]{64}$'",
    },
  ])

export default CapacityMovementControl
