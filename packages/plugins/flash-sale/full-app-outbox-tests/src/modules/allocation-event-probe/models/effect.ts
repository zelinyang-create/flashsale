import { model } from "@medusajs/framework/utils"

const AllocationEventProbeEffect = model
  .define(
    {
      name: "AllocationEventProbeEffect",
      tableName: "flash_sale_test_allocation_event_effect",
    },
    {
      id: model.id({ prefix: "fsprobeef" }).primaryKey(),
      consumer_id: model.text(),
      event_id: model.text(),
      event_hash: model.text(),
      aggregate_type: model.text(),
      aggregate_id: model.text(),
      aggregate_version: model.number(),
      effect_name: model.text(),
      applied_at: model.dateTime(),
    }
  )
  .indexes([
    {
      name: "IDX_flash_sale_test_probe_effect_event_unique",
      on: ["consumer_id", "event_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_flash_sale_test_probe_effect_aggregate_version_unique",
      on: [
        "consumer_id",
        "aggregate_type",
        "aggregate_id",
        "aggregate_version",
      ],
      unique: true,
      where: null,
    },
  ])

export default AllocationEventProbeEffect
