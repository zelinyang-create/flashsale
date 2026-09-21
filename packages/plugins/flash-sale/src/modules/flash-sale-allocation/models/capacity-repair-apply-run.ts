import { model } from "@medusajs/framework/utils"
import CapacityRepairRun from "./capacity-repair-run"
import CapacityRepairApplyAction from "./capacity-repair-apply-action"

const CapacityRepairApplyRun = model
  .define(
    {
      name: "FlashSaleCapacityRepairApplyRun",
      tableName: "flash_sale_capacity_repair_apply_run",
    },
    {
      id: model.id({ prefix: "fsraprun" }).primaryKey(),
      plan_run: model.belongsTo(() => CapacityRepairRun, {
        mappedBy: "apply_runs",
      }),
      plan_schema_version: model.number(),
      campaign_id: model.text(),
      command_digest: model.text(),
      plan_evidence_digest: model.text(),
      ordered_action_set_digest: model.text(),
      approval_token_digest: model.text(),
      approval_claims_digest: model.text(),
      approval_reference_digest: model.text(),
      approver: model.text(),
      approval_issuer: model.text(),
      approval_audience: model.text(),
      approval_tenant: model.text(),
      approval_jti_digest: model.text(),
      approval_permission_version: model.text(),
      approval_roles: model.json(),
      approval_purpose: model.text(),
      approval_issued_at: model.dateTime(),
      approval_not_before: model.dateTime(),
      approval_expires_at: model.dateTime(),
      requester: model.text(),
      reason: model.text(),
      ticket: model.text(),
      status: model.text(),
      result_digest: model.text(),
      finished_at: model.dateTime(),
      actions: model.hasMany(() => CapacityRepairApplyAction, {
        mappedBy: "apply_run",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_apply_run_plan_unique",
      on: ["plan_run_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique",
      on: ["approval_jti_digest"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_apply_run_ticket_created",
      on: ["ticket", "created_at", "id"],
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_apply_run_digests",
      expression:
        "command_digest ~ '^[0-9a-f]{64}$' AND plan_evidence_digest ~ '^[0-9a-f]{64}$' AND ordered_action_set_digest ~ '^[0-9a-f]{64}$' AND approval_token_digest ~ '^[0-9a-f]{64}$' AND approval_claims_digest ~ '^[0-9a-f]{64}$' AND approval_reference_digest ~ '^[0-9a-f]{64}$' AND approval_jti_digest ~ '^[0-9a-f]{64}$' AND result_digest ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_capacity_repair_apply_run_bounded",
      expression:
        "char_length(campaign_id) BETWEEN 1 AND 255 AND char_length(approver) BETWEEN 1 AND 255 AND char_length(approval_issuer) BETWEEN 1 AND 255 AND char_length(approval_audience) BETWEEN 1 AND 255 AND char_length(approval_tenant) BETWEEN 1 AND 255 AND char_length(approval_permission_version) BETWEEN 1 AND 255 AND char_length(requester) BETWEEN 1 AND 255 AND char_length(reason) BETWEEN 1 AND 2000 AND char_length(ticket) BETWEEN 1 AND 255 AND approver <> requester",
    },
    {
      name: "CK_flash_sale_capacity_repair_apply_run_approval_window",
      expression:
        "approval_issued_at < approval_expires_at AND approval_not_before < approval_expires_at AND finished_at < approval_expires_at",
    },
    {
      name: "CK_flash_sale_capacity_repair_apply_run_status",
      expression:
        "plan_schema_version = 2 AND status = 'applied' AND approval_purpose = 'capacity_repair_apply' AND jsonb_typeof(approval_roles) = 'array' AND jsonb_array_length(approval_roles) > 0 AND NOT jsonb_path_exists(approval_roles, '$[*] ? (@.type() != \"string\")')",
    },
  ])

export default CapacityRepairApplyRun
