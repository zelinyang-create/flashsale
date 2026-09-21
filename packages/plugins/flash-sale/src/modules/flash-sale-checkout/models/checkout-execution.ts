import { model } from "@medusajs/framework/utils"
import { CheckoutExecutionState } from "../../../types"
import CheckoutExecutionItem from "./checkout-execution-item"

const CheckoutExecution = model
  .define(
    {
      name: "FlashSaleCheckoutExecution",
      tableName: "flash_sale_checkout_execution",
    },
    {
      id: model.id({ prefix: "fscheckout" }).primaryKey(),
      attempt_id: model.text().unique(),
      campaign_id: model.text(),
      subject_id: model.text(),
      cart_id: model.text().unique(),
      command_id: model.text().unique(),
      request_hash: model.text(),
      commerce_transaction_id: model.text().unique(),
      commerce_result_hash: model.text().nullable(),
      terminal_command_hash: model.text().nullable(),
      rules_version: model.number(),
      state: model
        .enum(CheckoutExecutionState)
        .default(CheckoutExecutionState.PREPARED),
      order_id: model.text().nullable(),
      version: model.number().default(1),
      business_version: model.number().default(0),
      outbox_stream_started: model.boolean().default(false),
      business_changed_at: model.dateTime().nullable(),
      attempt_count: model.number().default(0),
      lease_owner: model.text().nullable(),
      lease_until: model.dateTime().nullable(),
      lease_epoch: model.number().default(0),
      completion_authorized_epoch: model.number().nullable(),
      completion_authorized_at: model.dateTime().nullable(),
      next_reconcile_at: model.dateTime().nullable(),
      last_error_code: model.text().nullable(),
      commerce_started_at: model.dateTime().nullable(),
      commerce_resolved_at: model.dateTime().nullable(),
      terminal_at: model.dateTime().nullable(),
      items: model.hasMany(() => CheckoutExecutionItem, {
        mappedBy: "execution",
      }),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_checkout_live_order_unique",
      on: ["order_id"],
      unique: true,
      where: "deleted_at IS NULL AND order_id IS NOT NULL",
    },
    {
      name: "IDX_flash_sale_checkout_campaign_state",
      on: ["campaign_id", "state"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_flash_sale_checkout_reconcile_due",
      on: ["state", "next_reconcile_at"],
      where: "deleted_at IS NULL AND next_reconcile_at IS NOT NULL",
    },
    {
      name: "IDX_flash_sale_checkout_active_lease",
      on: ["state", "lease_until"],
      where: "deleted_at IS NULL AND state = 'commerce_pending'",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_checkout_request_hash",
      expression: "request_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_checkout_result_hash",
      expression:
        "commerce_result_hash IS NULL OR commerce_result_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_checkout_terminal_hash",
      expression:
        "terminal_command_hash IS NULL OR terminal_command_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_checkout_rules_version",
      expression: "rules_version >= 1",
    },
    {
      name: "CK_flash_sale_checkout_version",
      expression: "version >= 1",
    },
    {
      name: "CK_flash_sale_checkout_business_stream",
      expression:
        "(outbox_stream_started AND business_version >= 1 AND business_changed_at IS NOT NULL) OR (NOT outbox_stream_started AND business_version = 0 AND business_changed_at IS NULL)",
    },
    {
      name: "CK_flash_sale_checkout_attempt_count",
      expression: "attempt_count >= 0",
    },
    {
      name: "CK_flash_sale_checkout_lease_epoch",
      expression: "lease_epoch >= 0",
    },
    {
      name: "CK_flash_sale_checkout_authorized_epoch",
      expression:
        "completion_authorized_epoch IS NULL OR completion_authorized_epoch >= 1",
    },
    {
      name: "CK_flash_sale_checkout_authorized_pair",
      expression:
        "(completion_authorized_epoch IS NULL) = (completion_authorized_at IS NULL)",
    },
    {
      name: "CK_flash_sale_checkout_authorized_fence",
      expression:
        "completion_authorized_epoch IS NULL OR (state = 'commerce_pending' AND completion_authorized_epoch = lease_epoch)",
    },
    {
      name: "CK_flash_sale_checkout_lease_pair",
      expression:
        "(lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_lease_state",
      expression:
        "(state = 'commerce_pending') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_success_result",
      expression:
        "state NOT IN ('commerce_succeeded', 'completed') OR (order_id IS NOT NULL AND last_error_code IS NULL)",
    },
    {
      name: "CK_flash_sale_checkout_failed_result",
      expression:
        "state NOT IN ('commerce_definitive_failed', 'canceled') OR (order_id IS NULL AND last_error_code IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_unknown_result",
      expression:
        "state <> 'commerce_unknown' OR (order_id IS NULL AND last_error_code IS NOT NULL AND next_reconcile_at IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_order_state",
      expression:
        "order_id IS NULL OR state IN ('commerce_succeeded', 'completed')",
    },
    {
      name: "CK_flash_sale_checkout_reconcile_state",
      expression:
        "(state = 'commerce_unknown') = (next_reconcile_at IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_resolved_state",
      expression:
        "(state IN ('commerce_succeeded', 'commerce_definitive_failed', 'completed', 'canceled')) = (commerce_resolved_at IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_terminal_state",
      expression:
        "(state IN ('completed', 'canceled', 'manual_review')) = (terminal_at IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_result_hash_state",
      expression:
        "(state IN ('commerce_succeeded', 'commerce_definitive_failed', 'commerce_unknown', 'completed', 'canceled')) = (commerce_result_hash IS NOT NULL)",
    },
    {
      name: "CK_flash_sale_checkout_terminal_hash_state",
      expression:
        "(state IN ('completed', 'canceled')) = (terminal_command_hash IS NOT NULL)",
    },
  ])

export default CheckoutExecution
