import { model } from "@medusajs/framework/utils"

const AllocationEventProbeCursor = model
  .define(
    {
      name: "AllocationEventProbeCursor",
      tableName: "flash_sale_test_allocation_event_cursor",
    },
    {
      id: model.id({ prefix: "fsprobecu" }).primaryKey(),
      consumer_id: model.text(),
      aggregate_type: model.text(),
      aggregate_id: model.text(),
      last_version: model.number().default(1),
      last_event_id: model.text().nullable(),
      last_event_hash: model.text().nullable(),
      effect_count: model.number().default(0),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_test_probe_cursor_aggregate_unique",
      on: ["consumer_id", "aggregate_type", "aggregate_id"],
      unique: true,
      where: null,
    },
  ])
  .checks([
    {
      name: "CK_flash_sale_test_probe_cursor_counts",
      expression: "last_version >= 1 AND effect_count >= 0",
    },
  ])

export default AllocationEventProbeCursor
