import { model } from "@medusajs/framework/utils"

// Independent append-only registry. The missing-FK design is intentional: a
// hard-deleted ApplyRun remains detectable by its surviving identity row.
const CapacityRepairApplyIdentity = model
  .define(
    {
      name: "FlashSaleCapacityRepairApplyIdentity",
      tableName: "flash_sale_capacity_repair_apply_identity",
    },
    {
      id: model.id({ prefix: "fsrapid" }).primaryKey(),
      request_identity_digest: model.text(),
      apply_run_id: model.text(),
      command_digest: model.text(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_apply_identity_digest_unique",
      on: ["request_identity_digest"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_apply_identity_run_unique",
      on: ["apply_run_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_apply_identity_digests",
      expression:
        "request_identity_digest ~ '^[0-9a-f]{64}$' AND command_digest ~ '^[0-9a-f]{64}$'",
    },
  ])

export default CapacityRepairApplyIdentity
