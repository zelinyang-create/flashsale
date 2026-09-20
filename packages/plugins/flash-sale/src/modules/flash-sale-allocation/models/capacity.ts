import { model } from "@medusajs/framework/utils"
import { CapacityState } from "../../../types"
import AllocationHold from "./allocation-hold"
import AllocationPolicy from "./allocation-policy"

const Capacity = model
  .define(
    { name: "FlashSaleCapacity", tableName: "flash_sale_capacity" },
    {
      id: model.id({ prefix: "fscap" }).primaryKey(),
      allocation_policy: model.belongsTo(() => AllocationPolicy, {
        mappedBy: "capacities",
      }),
      campaign_item_id: model.text(),
      shard_no: model.number().default(0),
      state: model.enum(CapacityState).default(CapacityState.PREPARED),
      granted_quantity: model.bigNumber(),
      held_quantity: model.bigNumber().default(0),
      consumed_quantity: model.bigNumber().default(0),
      rules_version: model.number(),
      version: model.number().default(1),
      holds: model.hasMany(() => AllocationHold, {
        mappedBy: "capacity",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_policy_item_shard_unique",
      on: ["allocation_policy_id", "campaign_item_id", "shard_no"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_policy_state",
      on: ["allocation_policy_id", "state"],
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_live_campaign_item",
      on: ["campaign_item_id"],
      where: "deleted_at IS NULL",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_single_shard",
      expression: "shard_no = 0",
    },
    {
      name: "CK_flash_sale_capacity_granted_positive",
      expression: "granted_quantity > 0",
    },
    {
      name: "CK_flash_sale_capacity_held_nonnegative",
      expression: "held_quantity >= 0",
    },
    {
      name: "CK_flash_sale_capacity_consumed_nonnegative",
      expression: "consumed_quantity >= 0",
    },
    {
      name: "CK_flash_sale_capacity_balance",
      expression: "held_quantity + consumed_quantity <= granted_quantity",
    },
    {
      name: "CK_flash_sale_capacity_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_capacity_version",
      expression: "version >= 1",
    },
  ])

export default Capacity
