import type {
  ConfigModule,
  IEventBusModuleService,
  Logger,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MEDUSA_SKIP_FILE,
  Modules,
} from "@medusajs/framework/utils"
import { hostname } from "os"
import { randomUUID } from "crypto"
import FlashSaleAllocationModuleService from "../modules/flash-sale-allocation/service"
import {
  AllocationOutboxDispatchResult,
  AllocationOutboxDispatcher,
  AllocationOutboxDispatcherHooks,
  MedusaRedisAllocationEventTransport,
  parseAllocationOutboxDispatcherConfig,
} from "../orchestration/allocation-outbox"
import { FlashSalePluginModule } from "../types"

const workerId = `flash-sale-outbox-${hostname()}-${process.pid}-${randomUUID()}`.slice(
  0,
  255
)

const dispatchers = new WeakMap<MedusaContainer, AllocationOutboxDispatcher>()

function disabledResult(): AllocationOutboxDispatchResult {
  return {
    skipped: true,
    skip_reason: "disabled",
    claimed: 0,
    accepted: 0,
    published: 0,
    retry_scheduled: 0,
    dead_lettered: 0,
    fenced: 0,
    ambiguous: 0,
    invalid: 0,
  }
}

function createDispatcher(
  container: MedusaContainer,
  hooks: AllocationOutboxDispatcherHooks = {}
) {
  const configModule = container.resolve<ConfigModule>(
    ContainerRegistrationKeys.CONFIG_MODULE
  )
  const config = parseAllocationOutboxDispatcherConfig(
    process.env,
    configModule
  )
  if (!config.enabled) return null
  const allocation = container.resolve<FlashSaleAllocationModuleService>(
    FlashSalePluginModule.ALLOCATION
  )
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
  return new AllocationOutboxDispatcher(
    allocation,
    new MedusaRedisAllocationEventTransport(eventBus),
    config,
    workerId,
    hooks
  )
}

export async function dispatchAllocationOutbox(
  container: MedusaContainer,
  hooks: AllocationOutboxDispatcherHooks = {}
): Promise<AllocationOutboxDispatchResult> {
  if (hooks.after_event_bus_accept_before_mark) {
    const dispatcher = createDispatcher(container, hooks)
    return dispatcher ? await dispatcher.runTick() : disabledResult()
  }
  let dispatcher = dispatchers.get(container)
  if (!dispatcher) {
    dispatcher = createDispatcher(container) ?? undefined
    if (!dispatcher) return disabledResult()
    dispatchers.set(container, dispatcher)
  }
  return await dispatcher.runTick()
}

export default async function dispatchAllocationOutboxJob(
  container: MedusaContainer
) {
  const result = await dispatchAllocationOutbox(container)
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  logger.info(
    JSON.stringify({
      event: "flash_sale_allocation_outbox_dispatch",
      ...result,
    })
  )
  return result
}

export const config = {
  name: "flash-sale-dispatch-allocation-outbox",
  schedule:
    process.env.NODE_ENV === "test" &&
    process.env.FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE
      ? process.env.FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE
      : "*/5 * * * * *",
}

// Prevent even the no-op cron workflow from being registered in the default
// disabled deployment. Worker/shared mode is checked again from ConfigModule
// before any claim, because it is unavailable at file-discovery time.
Object.defineProperty(exports, MEDUSA_SKIP_FILE, {
  value: process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED !== "true",
  enumerable: false,
})
