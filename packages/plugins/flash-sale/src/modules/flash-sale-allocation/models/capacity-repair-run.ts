import { model } from "@medusajs/framework/utils"
import CapacityRepairAction from "./capacity-repair-action"
import CapacityRepairApplyRun from "./capacity-repair-apply-run"

const CapacityRepairRun = model
  .define(
    {
      name: "FlashSaleCapacityRepairRun",
      tableName: "flash_sale_capacity_repair_run",
    },
    {
      id: model.id({ prefix: "fsreprun" }).primaryKey(),
      plan_schema_version: model.number().default(1),
      request_identity_digest: model.text(),
      command_digest: model.text(),
      campaign_id: model.text().nullable(),
      activation_id: model.text().nullable(),
      control_schema_version: model.number().nullable(),
      control_root_digest: model.text().nullable(),
      status: model.text(),
      classification: model.text().nullable(),
      actor: model.text(),
      reason: model.text(),
      ticket: model.text(),
      evidence_digest: model.text(),
      issue_codes: model.json(),
      issue_count: model.number(),
      issue_manifest: model.json(),
      evidence_manifest: model.json(),
      snapshot_at: model.dateTime(),
      finished_at: model.dateTime(),
      actions: model.hasMany(() => CapacityRepairAction, { mappedBy: "run" }),
      apply_runs: model.hasMany(() => CapacityRepairApplyRun, {
        mappedBy: "plan_run",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_run_identity_unique",
      on: ["request_identity_digest"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_run_scope_created",
      on: ["campaign_id", "created_at", "id"],
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_run_schema",
      expression: "plan_schema_version IN (1, 2)",
    },
    {
      name: "CK_flash_sale_capacity_repair_run_digests",
      expression:
        "request_identity_digest ~ '^[0-9a-f]{64}$' AND command_digest ~ '^[0-9a-f]{64}$' AND evidence_digest ~ '^[0-9a-f]{64}$' AND (control_root_digest IS NULL OR control_root_digest ~ '^[0-9a-f]{64}$')",
    },
    {
      name: "CK_flash_sale_capacity_repair_run_bounded",
      expression:
        "char_length(actor) BETWEEN 1 AND 255 AND char_length(reason) BETWEEN 1 AND 2000 AND char_length(ticket) BETWEEN 1 AND 255 AND (campaign_id IS NULL OR char_length(campaign_id) BETWEEN 1 AND 255) AND (activation_id IS NULL OR char_length(activation_id) BETWEEN 1 AND 255)",
    },
    {
      name: "CK_flash_sale_capacity_repair_run_outcome",
      expression:
        "((status IN ('not_activated', 'no_changes') AND classification IS NULL) OR (status = 'planned' AND classification IS NOT NULL AND classification = 'safe_repair') OR (status = 'manual_required' AND classification IS NOT NULL AND classification = 'manual_required')) AND issue_count >= 0 AND jsonb_typeof(issue_codes) = 'array' AND jsonb_typeof(issue_manifest) = 'array' AND issue_count = jsonb_array_length(issue_manifest) AND jsonb_typeof(evidence_manifest) = 'object'",
    },
  ])

export default CapacityRepairRun
