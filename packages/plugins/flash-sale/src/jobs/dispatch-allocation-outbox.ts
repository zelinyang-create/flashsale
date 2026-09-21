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
import { randomUUID } from "crypto"
import { hostname } from "os"
import FlashSaleAllocationModuleService from "../modules/flash-sale-allocation/service"
import FlashSaleCheckoutModuleService from "../modules/flash-sale-checkout/service"
import {
  AllocationOutboxDispatchResult,
  AllocationOutboxDispatcher,
  AllocationOutboxDispatcherHooks,
  MedusaRedisOutboxEventTransport,
  parseFlashSaleOutboxDispatcherConfig,
} from "../orchestration/allocation-outbox"
import {
  CheckoutOutboxDispatcher,
  CheckoutOutboxDispatcherHooks,
} from "../orchestration/checkout-outbox"
import { FlashSalePluginModule } from "../types"
import { FairLaneBudgetAllocator } from "../orchestration/outbox-dispatcher"

const workerId = `flash-sale-outbox-${hostname()}-${process.pid}-${randomUUID()}`.slice(0, 220)

function empty(reason: "disabled" | "overlap" = "disabled"): AllocationOutboxDispatchResult {
  return { skipped: true, skip_reason: reason, claimed: 0, accepted: 0,
    published: 0, retry_scheduled: 0, dead_lettered: 0, fenced: 0,
    ambiguous: 0, invalid: 0 }
}

function idle(): AllocationOutboxDispatchResult {
  return { skipped: false, skip_reason: null, claimed: 0, accepted: 0,
    published: 0, retry_scheduled: 0, dead_lettered: 0, fenced: 0,
    ambiguous: 0, invalid: 0 }
}

export type FlashSaleOutboxDispatchResult = Readonly<{
  skipped: boolean
  allocation: AllocationOutboxDispatchResult
  checkout: AllocationOutboxDispatchResult | null
  lane_errors: readonly ("allocation" | "checkout")[]
}>

type Hooks = Readonly<{
  allocation?: AllocationOutboxDispatcherHooks
  checkout?: CheckoutOutboxDispatcherHooks
}>

export class FairOutboxCoordinator {
  private readonly budgets: FairLaneBudgetAllocator
  private running = false
  constructor(
    readonly allocation: AllocationOutboxDispatcher,
    readonly checkout: CheckoutOutboxDispatcher | null,
    private readonly concurrency: number
  ) {
    this.budgets = new FairLaneBudgetAllocator(
      concurrency,
      checkout ? ["allocation", "checkout"] : ["allocation"]
    )
  }

  assertReady(): void {
    this.allocation.assertReady()
    this.checkout?.assertReady()
  }

  async runAllocationOnlyTick(): Promise<AllocationOutboxDispatchResult> {
    if (this.running) return empty("overlap")
    this.running = true
    try {
      this.assertReady()
      return await this.allocation.runTick(undefined, false)
    } finally {
      this.running = false
    }
  }

  async runTick(): Promise<FlashSaleOutboxDispatchResult> {
    if (this.running) {
      return {
        skipped: true,
        allocation: empty("overlap"),
        checkout: this.checkout ? empty("overlap") : null,
        lane_errors: [],
      }
    }
    this.running = true
    try {
      // Synchronous, global preflight: if either enabled lane is invalid,
      // neither module reaches its claim transaction.
      this.assertReady()
      const limits = this.budgets.next()
      const calls: Array<Promise<AllocationOutboxDispatchResult>> = []
      const names: Array<"allocation" | "checkout"> = []
      if (limits.allocation > 0) {
        names.push("allocation")
        calls.push(this.allocation.runTick(limits.allocation, false))
      }
      if (this.checkout && limits.checkout > 0) {
        names.push("checkout")
        calls.push(this.checkout.runTick(limits.checkout, false))
      }
      const settled = await Promise.allSettled(calls)
      // A zero budget means this healthy lane intentionally yielded this tick;
      // it is not disabled and it did not lose its process-local overlap guard.
      let allocation = idle()
      let checkout: AllocationOutboxDispatchResult | null = this.checkout
        ? idle()
        : null
      const errors: Array<"allocation" | "checkout"> = []
      settled.forEach((item, index) => {
        const name = names[index]
        if (item.status === "rejected") {
          errors.push(name)
        } else if (name === "allocation") {
          allocation = item.value
        } else {
          checkout = item.value
        }
      })
      return { skipped: false, allocation, checkout, lane_errors: errors }
    } finally {
      this.running = false
    }
  }

}

const coordinators = new WeakMap<MedusaContainer, FairOutboxCoordinator>()

function createCoordinator(container: MedusaContainer, hooks: Hooks = {}) {
  const configModule = container.resolve<ConfigModule>(
    ContainerRegistrationKeys.CONFIG_MODULE
  )
  const config = parseFlashSaleOutboxDispatcherConfig(process.env, configModule)
  if (!config.enabled) return null
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
  const transport = new MedusaRedisOutboxEventTransport(eventBus)
  const allocation = container.resolve<FlashSaleAllocationModuleService>(
    FlashSalePluginModule.ALLOCATION
  )
  const allocationDispatcher = new AllocationOutboxDispatcher(
    allocation,
    transport,
    config.allocation,
    `${workerId}-allocation`,
    hooks.allocation
  )
  let checkoutDispatcher: CheckoutOutboxDispatcher | null = null
  if (config.checkout) {
    const checkout = container.resolve<FlashSaleCheckoutModuleService>(
      FlashSalePluginModule.CHECKOUT
    )
    checkoutDispatcher = new CheckoutOutboxDispatcher(
      checkout,
      transport,
      config.checkout,
      `${workerId}-checkout`,
      hooks.checkout
    )
  }
  return new FairOutboxCoordinator(
    allocationDispatcher,
    checkoutDispatcher,
    config.concurrency
  )
}

export async function dispatchFlashSaleOutboxes(
  container: MedusaContainer,
  hooks: Hooks = {}
): Promise<FlashSaleOutboxDispatchResult> {
  const hasHooks = !!hooks.allocation || !!hooks.checkout
  let coordinator = hasHooks ? undefined : coordinators.get(container)
  if (!coordinator) {
    coordinator = createCoordinator(container, hooks) ?? undefined
    if (!coordinator) {
      return { skipped: true, allocation: empty(), checkout: null, lane_errors: [] }
    }
    if (!hasHooks) coordinators.set(container, coordinator)
  }
  return await coordinator.runTick()
}

// B1 compatibility API. The production job below is the only scheduled job
// and dispatches every enabled lane; this helper remains allocation-only for
// focused tests and operator tooling built against the B1 contract.
export async function dispatchAllocationOutbox(
  container: MedusaContainer,
  hooks: AllocationOutboxDispatcherHooks = {}
): Promise<AllocationOutboxDispatchResult> {
  const hasHooks = Object.keys(hooks).length > 0
  let coordinator = hasHooks ? undefined : coordinators.get(container)
  if (!coordinator) {
    coordinator = createCoordinator(container, { allocation: hooks }) ?? undefined
    if (coordinator && !hasHooks) coordinators.set(container, coordinator)
  }
  if (!coordinator) return empty()
  // Even the B1 compatibility entry point shares the enabled-lane safety
  // boundary. A drifted Checkout registry must prevent Allocation from
  // claiming, otherwise this helper could bypass the production job's global
  // fail-closed preflight.
  return await coordinator.runAllocationOnlyTick()
}

export default async function dispatchFlashSaleOutboxesJob(
  container: MedusaContainer
) {
  const result = await dispatchFlashSaleOutboxes(container)
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  logger.info(JSON.stringify({
    event: "flash_sale_outbox_dispatch",
    skipped: result.skipped,
    lane_errors: result.lane_errors,
    allocation: result.allocation,
    checkout: result.checkout,
  }))
  return result
}

export const config = {
  name: "flash-sale-dispatch-outboxes",
  schedule:
    process.env.NODE_ENV === "test" && process.env.FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE
      ? process.env.FLASH_SALE_OUTBOX_TEST_JOB_SCHEDULE
      : "*/5 * * * * *",
}

Object.defineProperty(exports, MEDUSA_SKIP_FILE, {
  value: process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED !== "true",
  enumerable: false,
})
