import { model } from "@medusajs/framework/utils"
import { AllocationOutboxStatus } from "../../../types"

const AllocationOutboxEvent = model
  .define(
    {
      name: "FlashSaleAllocationOutboxEvent",
      tableName: "flash_sale_allocation_outbox_event",
    },
    {
      id: model.id({ prefix: "fsaevt" }).primaryKey(),
      event_name: model.text(),
      schema_version: model.number(),
      aggregate_type: model.text(),
      aggregate_id: model.text(),
      aggregate_version: model.number(),
      event_hash: model.text(),
      payload: model.json(),
      status: model
        .enum(AllocationOutboxStatus)
        .default(AllocationOutboxStatus.PENDING),
      available_at: model.dateTime(),
      occurred_at: model.dateTime(),
      published_at: model.dateTime().nullable(),
      attempt_count: model.number().default(0),
      max_attempts: model.number().nullable(),
      lease_owner: model.text().nullable(),
      lease_until: model.dateTime().nullable(),
      lease_epoch: model.number().default(0),
      published_by: model.text().nullable(),
      published_lease_epoch: model.number().nullable(),
      last_error_code: model.text().nullable(),
      dead_lettered_at: model.dateTime().nullable(),
      redrive_count: model.number().default(0),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_allocation_outbox_aggregate_version_unique",
      on: ["aggregate_type", "aggregate_id", "aggregate_version"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_allocation_outbox_due",
      on: ["status", "available_at", "occurred_at", "id"],
      where: "deleted_at IS NULL AND status = 'pending'",
    },
    {
      name: "IDX_flash_sale_allocation_outbox_recovery",
      on: ["status", "lease_until", "id"],
      where: "deleted_at IS NULL AND status = 'publishing'",
    },
    {
      name: "IDX_flash_sale_allocation_outbox_dead",
      on: ["dead_lettered_at", "id"],
      where: "deleted_at IS NULL AND status = 'dead_letter'",
    },
    {
      name: "IDX_flash_sale_allocation_outbox_head",
      on: ["aggregate_type", "aggregate_id", "aggregate_version"],
      where: "deleted_at IS NULL AND status <> 'published'",
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_allocation_outbox_schema_version",
      expression: "schema_version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_outbox_aggregate_version",
      expression: "aggregate_version >= 1",
    },
    {
      name: "CK_flash_sale_allocation_outbox_hash",
      expression: "event_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_allocation_outbox_payload",
      expression:
        "jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536",
    },
    {
      name: "CK_flash_sale_allocation_outbox_counts",
      expression:
        "attempt_count >= 0 AND lease_epoch >= 0 AND redrive_count >= 0 AND (max_attempts IS NULL OR (max_attempts >= 1 AND max_attempts <= 100)) AND (published_lease_epoch IS NULL OR published_lease_epoch >= 1)",
    },
    {
      name: "CK_flash_sale_allocation_outbox_bounded_identifiers",
      expression:
        "char_length(event_name) BETWEEN 1 AND 160 AND char_length(aggregate_type) BETWEEN 1 AND 64 AND char_length(aggregate_id) BETWEEN 1 AND 255 AND " +
        "(lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 255) AND (published_by IS NULL OR char_length(published_by) BETWEEN 1 AND 255) AND " +
        "(last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$')",
    },
    {
      name: "CK_flash_sale_allocation_outbox_status_fields",
      expression:
        "(status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR " +
        "(status = 'publishing' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR " +
        "(status = 'published' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NOT NULL AND published_by IS NOT NULL AND published_lease_epoch IS NOT NULL AND dead_lettered_at IS NULL) OR " +
        "(status = 'dead_letter' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NOT NULL)",
    },
  ])

export default AllocationOutboxEvent
