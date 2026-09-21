import { model } from "@medusajs/framework/utils"

const AllocationEventProbeInbox = model
  .define(
    {
      name: "AllocationEventProbeInbox",
      tableName: "flash_sale_test_allocation_event_inbox",
    },
    {
      id: model.id({ prefix: "fsprobein" }).primaryKey(),
      consumer_id: model.text(),
      event_id: model.text(),
      event_name: model.text(),
      event_hash: model.text(),
      source_module: model.text().default("allocation"),
      aggregate_type: model.text(),
      aggregate_id: model.text(),
      aggregate_version: model.number(),
      occurred_at: model.dateTime(),
      payload: model.json(),
      delivery_count: model.number().default(1),
      first_received_at: model.dateTime(),
      last_received_at: model.dateTime(),
      processed_at: model.dateTime(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_test_probe_inbox_source_event_unique",
      on: ["consumer_id", "source_module", "event_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_test_probe_inbox_source_aggregate_version_unique",
      on: [
        "consumer_id",
        "source_module",
        "aggregate_type",
        "aggregate_id",
        "aggregate_version",
      ],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_test_probe_inbox_hash",
      expression: "event_hash ~ '^[0-9a-f]{64}$'",
    },
    {
      name: "CK_flash_sale_test_probe_inbox_delivery_count",
      expression: "delivery_count >= 1",
    },
    {
      name: "CK_flash_sale_test_probe_inbox_payload",
      expression:
        "jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536",
    },
  ])

export default AllocationEventProbeInbox
