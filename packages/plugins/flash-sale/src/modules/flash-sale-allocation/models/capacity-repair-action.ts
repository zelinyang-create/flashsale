import { model } from "@medusajs/framework/utils"
import CapacityRepairRun from "./capacity-repair-run"
import CapacityRepairApplyAction from "./capacity-repair-apply-action"

const CapacityRepairAction = model
  .define(
    {
      name: "FlashSaleCapacityRepairAction",
      tableName: "flash_sale_capacity_repair_action",
    },
    {
      id: model.id({ prefix: "fsrepact" }).primaryKey(),
      run: model.belongsTo(() => CapacityRepairRun, { mappedBy: "actions" }),
      capacity_id: model.text(),
      before_capacity_version: model.number().nullable(),
      before_granted_quantity: model.text(),
      before_held_quantity: model.text(),
      before_consumed_quantity: model.text(),
      before_raw_granted_quantity: model.text(),
      before_raw_held_quantity: model.text(),
      before_raw_consumed_quantity: model.text(),
      expected_granted_quantity: model.text(),
      expected_held_quantity: model.text(),
      expected_consumed_quantity: model.text(),
      expected_raw_granted_quantity: model.text(),
      expected_raw_held_quantity: model.text(),
      expected_raw_consumed_quantity: model.text(),
      issue_codes: model.json(),
      classification: model.text(),
      evidence_digest: model.text(),
      status: model.text(),
      apply_actions: model.hasMany(() => CapacityRepairApplyAction, {
        mappedBy: "plan_action",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_action_run_capacity_unique",
      on: ["run_id", "capacity_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_action_capacity_created",
      on: ["capacity_id", "created_at", "id"],
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_action_version",
      expression:
        "before_capacity_version IS NULL OR before_capacity_version >= 1",
    },
    {
      name: "CK_flash_sale_capacity_repair_action_digest",
      expression: "evidence_digest ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_capacity_repair_action_decimal",
      expression:
        "before_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_held_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND expected_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$'",
    },
    {
      name: "CK_flash_sale_capacity_repair_action_status",
      expression:
        "classification = 'safe_repair' AND status = 'proposed' AND jsonb_typeof(issue_codes) = 'array' AND jsonb_array_length(issue_codes) > 0",
    },
  ])

export default CapacityRepairAction
