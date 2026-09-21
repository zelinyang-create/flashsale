import { model } from "@medusajs/framework/utils"

// Independent, append-only identity registry. It intentionally has no FK to the
// Run table so a hard-deleted Run remains detectable on the next exact replay.
const CapacityRepairIdentity = model
  .define(
    {
      name: "FlashSaleCapacityRepairIdentity",
      tableName: "flash_sale_capacity_repair_identity",
    },
    {
      id: model.id({ prefix: "fsrepid" }).primaryKey(),
      request_identity_digest: model.text(),
      run_id: model.text(),
      command_digest: model.text(),
      evidence_digest: model.text(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_capacity_repair_identity_digest_unique",
      on: ["request_identity_digest"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_capacity_repair_identity_run_unique",
      on: ["run_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_capacity_repair_identity_digests",
      expression:
        "request_identity_digest ~ '^[0-9a-f]{64}$' AND command_digest ~ '^[0-9a-f]{64}$' AND evidence_digest ~ '^[0-9a-f]{64}$'",
    },
  ])

export default CapacityRepairIdentity
