import { model } from "@medusajs/framework/utils"

const SubjectAllocation = model
  .define(
    {
      name: "FlashSaleSubjectAllocation",
      tableName: "flash_sale_subject_allocation",
    },
    {
      id: model.id({ prefix: "fssub" }).primaryKey(),
      campaign_id: model.text(),
      subject_id: model.text(),
      limit_quantity: model.bigNumber(),
      held_quantity: model.bigNumber().default(0),
      consumed_quantity: model.bigNumber().default(0),
      rules_version: model.number(),
      version: model.number().default(1),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_subject_campaign_subject_unique",
      on: ["campaign_id", "subject_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_subject_live_campaign",
      on: ["campaign_id"],
      where: "deleted_at IS NULL",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_subject_limit",
      expression: "limit_quantity > 0",
    },
    {
      name: "CK_flash_sale_subject_held_nonnegative",
      expression: "held_quantity >= 0",
    },
    {
      name: "CK_flash_sale_subject_consumed_nonnegative",
      expression: "consumed_quantity >= 0",
    },
    {
      name: "CK_flash_sale_subject_balance",
      expression: "held_quantity + consumed_quantity <= limit_quantity",
    },
    {
      name: "CK_flash_sale_subject_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_subject_version",
      expression: "version >= 1",
    },
  ])

export default SubjectAllocation
