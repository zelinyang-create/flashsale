import { model } from "@medusajs/framework/utils"
import { PurchaseAttemptState } from "../../../types"
import AllocationHold from "./allocation-hold"
import AllocationPolicy from "./allocation-policy"
import CapacityMovement from "./capacity-movement"

const PurchaseAttempt = model
  .define(
    {
      name: "FlashSalePurchaseAttempt",
      tableName: "flash_sale_purchase_attempt",
    },
    {
      id: model.id({ prefix: "fsatt" }).primaryKey(),
      allocation_policy: model.belongsTo(() => AllocationPolicy, {
        mappedBy: "attempts",
      }),
      campaign_id: model.text(),
      subject_id: model.text(),
      cart_id: model.text().nullable(),
      idempotency_key_hash: model.text(),
      request_hash: model.text(),
      state: model
        .enum(PurchaseAttemptState)
        .default(PurchaseAttemptState.PENDING),
      rules_version: model.number(),
      expires_at: model.dateTime(),
      version: model.number().default(1),
      last_error_code: model.text().nullable(),
      terminal_at: model.dateTime().nullable(),
      settlement_id: model.text().nullable(),
      settlement_started_at: model.dateTime().nullable(),
      hold_movement_activation_id: model.text().nullable(),
      terminal_movement_activation_id: model.text().nullable(),
      holds: model.hasMany(() => AllocationHold, {
        mappedBy: "attempt",
      }),
      capacity_movements: model.hasMany(() => CapacityMovement, {
        mappedBy: "attempt",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_attempt_idempotency_unique",
      on: ["campaign_id", "subject_id", "idempotency_key_hash"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_attempt_live_cart_settlement_unique",
      on: ["campaign_id", "cart_id"],
      unique: true,
      where:
        "deleted_at IS NULL AND cart_id IS NOT NULL AND state IN ('pending', 'quota_held', 'quota_committing')",
    },
    {
      name: "IDX_flash_sale_attempt_held_expiry",
      on: ["state", "expires_at"],
      where: "deleted_at IS NULL AND state = 'quota_held'",
    },
    {
      name: "IDX_flash_sale_attempt_live_subject_state",
      on: ["campaign_id", "subject_id", "state"],
      where: "deleted_at IS NULL",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_attempt_version",
      expression: "version >= 1",
    },
    {
      name: "CK_flash_sale_attempt_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_attempt_idempotency_hash",
      expression: "char_length(idempotency_key_hash) = 64",
    },
    {
      name: "CK_flash_sale_attempt_request_hash",
      expression: "char_length(request_hash) = 64",
    },
    {
      name: "CK_flash_sale_attempt_settlement_pair",
      expression: "(settlement_id IS NULL) = (settlement_started_at IS NULL)",
    },
    {
      name: "CK_flash_sale_attempt_committing_settlement",
      expression:
        "state <> 'quota_committing' OR (settlement_id IS NOT NULL AND settlement_started_at IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_attempt_hold_movement_activation",
      expression:
        "hold_movement_activation_id IS NULL OR char_length(hold_movement_activation_id) BETWEEN 1 AND 255",
    },
    {
      name: "CK_flash_sale_attempt_terminal_movement_activation",
      expression:
        "terminal_movement_activation_id IS NULL OR char_length(terminal_movement_activation_id) BETWEEN 1 AND 255",
    },
  ])

export default PurchaseAttempt
