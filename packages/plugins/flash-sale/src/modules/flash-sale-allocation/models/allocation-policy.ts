import { model } from "@medusajs/framework/utils"
import { AllocationPolicyState } from "../../../types"
import Capacity from "./capacity"
import PurchaseAttempt from "./purchase-attempt"

const AllocationPolicy = model
  .define(
    {
      name: "FlashSaleAllocationPolicy",
      tableName: "flash_sale_allocation_policy",
    },
    {
      id: model.id({ prefix: "fsapol" }).primaryKey(),
      campaign_id: model.text(),
      rules_version: model.number(),
      configuration_hash: model.text(),
      state: model
        .enum(AllocationPolicyState)
        .default(AllocationPolicyState.PREPARED),
      starts_at: model.dateTime(),
      ends_at: model.dateTime(),
      hold_ttl_seconds: model.number(),
      per_subject_limit: model.number(),
      version: model.number().default(1),
      capacities: model.hasMany(() => Capacity, {
        mappedBy: "allocation_policy",
      }),
      attempts: model.hasMany(() => PurchaseAttempt, {
        mappedBy: "allocation_policy",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_allocation_policy_campaign_rules_unique",
      on: ["campaign_id", "rules_version"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_allocation_policy_live_campaign_unique",
      on: ["campaign_id"],
      unique: true,
      where: "deleted_at IS NULL AND state IN ('prepared', 'open')",
    },
    {
      name: "IDX_flash_sale_allocation_policy_live_schedule",
      on: ["state", "starts_at", "ends_at"],
      where: "deleted_at IS NULL",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_allocation_policy_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_policy_version",
      expression: "version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_policy_hold_ttl",
      expression: "hold_ttl_seconds BETWEEN 1 AND 86400",
    },
    {
      name: "CK_flash_sale_allocation_policy_subject_limit",
      expression: "per_subject_limit >= 1",
    },
    {
      name: "CK_flash_sale_allocation_policy_window",
      expression: "ends_at > starts_at",
    },
    {
      name: "CK_flash_sale_allocation_policy_configuration_hash",
      expression: "char_length(configuration_hash) = 64",
    },
  ])

export default AllocationPolicy
