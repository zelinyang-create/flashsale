import { model } from "@medusajs/framework/utils"
import CapacityRepairAction from "./capacity-repair-action"
import CapacityRepairApplyRun from "./capacity-repair-apply-run"

const DECIMAL = "'^(0|[1-9][0-9]*)$'"

const CapacityRepairApplyAction = model
  .define(
    {
      name: "FlashSaleCapacityRepairApplyAction",
      tableName: "flash_sale_capacity_repair_apply_action",
    },
    {
      id: model.id({ prefix: "fsrapact" }).primaryKey(),
      apply_run: model.belongsTo(() => CapacityRepairApplyRun, {
        mappedBy: "actions",
      }),
      plan_action: model.belongsTo(() => CapacityRepairAction, {
        mappedBy: "apply_actions",
      }),
      capacity_id: model.text(),
      before_capacity_version: model.number(),
      after_capacity_version: model.number(),
      before_granted_quantity: model.text(),
      before_held_quantity: model.text(),
      before_consumed_quantity: model.text(),
      before_raw_granted_quantity: model.text(),
      before_raw_held_quantity: model.text(),
      before_raw_consumed_quantity: model.text(),
      after_granted_quantity: model.text(),
      after_held_quantity: model.text(),
      after_consumed_quantity: model.text(),
      after_raw_granted_quantity: model.text(),
      after_raw_held_quantity: model.text(),
      after_raw_consumed_quantity: model.text(),
      evidence_digest: model.text(),
      status: model.text(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_apply_action_plan_unique",
      on: ["plan_action_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_apply_action_run_capacity_unique",
      on: ["apply_run_id", "capacity_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_apply_action_version",
      expression:
        "before_capacity_version >= 1 AND after_capacity_version = before_capacity_version + 1",
    },
    {
      name: "CK_flash_sale_capacity_repair_apply_action_decimal",
      expression: [
        "before_granted_quantity",
        "before_held_quantity",
        "before_consumed_quantity",
        "before_raw_granted_quantity",
        "before_raw_held_quantity",
        "before_raw_consumed_quantity",
        "after_granted_quantity",
        "after_held_quantity",
        "after_consumed_quantity",
        "after_raw_granted_quantity",
        "after_raw_held_quantity",
        "after_raw_consumed_quantity",
      ]
        .map((field) => `${field} ~ ${DECIMAL}`)
        .join(" AND "),
    },
    {
      name: "CK_flash_sale_capacity_repair_apply_action_invariants",
      expression:
        "status = 'applied' AND evidence_digest ~ '^[0-9a-f]{64}$' AND before_granted_quantity = after_granted_quantity AND before_granted_quantity = before_raw_granted_quantity AND after_granted_quantity = after_raw_granted_quantity AND after_held_quantity = after_raw_held_quantity AND after_consumed_quantity = after_raw_consumed_quantity AND before_held_quantity::numeric + before_consumed_quantity::numeric <= before_granted_quantity::numeric AND after_held_quantity::numeric + after_consumed_quantity::numeric <= after_granted_quantity::numeric",
    },
  ])

export default CapacityRepairApplyAction
