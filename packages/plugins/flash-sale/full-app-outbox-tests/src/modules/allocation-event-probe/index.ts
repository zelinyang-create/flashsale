import { Module } from "@medusajs/framework/utils"
import AllocationEventProbeModuleService, {
  ALLOCATION_EVENT_PROBE_MODULE,
} from "./service"

export * from "./models"
export * from "./service"

export default Module(ALLOCATION_EVENT_PROBE_MODULE, {
  service: AllocationEventProbeModuleService,
})
