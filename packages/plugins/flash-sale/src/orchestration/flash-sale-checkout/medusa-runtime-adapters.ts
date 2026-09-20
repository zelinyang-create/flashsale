import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { ILockingModule, MedusaContainer } from "@medusajs/framework/types"
import {
  generateEntityId,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import {
  CampaignState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  FlashSalePluginModule,
} from "../../types"
import {
  AllocationCheckoutPort,
  CampaignCheckoutPort,
  CartLockScope,
  CartLockPort,
  CheckoutExecutionPort,
  FlashSaleCheckoutItem,
  FlashSaleCheckoutOrchestratorOptions,
  NativeCommercePort,
} from "./contracts"
import { FlashSaleCheckoutOrchestrator } from "./flash-sale-checkout-orchestrator"

const INVENTORY_DEFINITIVE_FAILURE = "INSUFFICIENT_INVENTORY"
const UNKNOWN_NATIVE_RESULT = "NATIVE_COMMERCE_RESULT_UNKNOWN"
const INVALID_NATIVE_SUCCESS = "NATIVE_COMMERCE_SUCCESS_WITHOUT_ORDER"

type CampaignModuleReadPort = Readonly<{
  retrieveCampaign(id: string): Promise<FlashSaleCampaignDTO>
  listCampaignItems(
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignItemDTO[]>
}>

type ActiveCartLockRegistry = Readonly<{
  enter(scopeKey: string, cartId: string): void
  leave(scopeKey: string): void
  matches(scopeKey: string, cartId: string): boolean
}>

function activeCartLockRegistry(): ActiveCartLockRegistry {
  const active = new Map<string, string>()
  return {
    enter: (scopeKey, cartId) => active.set(scopeKey, cartId),
    leave: (scopeKey) => active.delete(scopeKey),
    matches: (scopeKey, cartId) => active.get(scopeKey) === cartId,
  }
}

class MedusaCampaignCheckoutAdapter implements CampaignCheckoutPort {
  constructor(private readonly campaign: CampaignModuleReadPort) {}

  async assertCheckoutEligible(command: {
    campaign_id: string
    subject_id: string
    cart_id: string
    rules_version: number
    items: readonly FlashSaleCheckoutItem[]
  }): Promise<void> {
    const campaign = await this.campaign.retrieveCampaign(command.campaign_id)
    if (
      campaign.state !== CampaignState.ACTIVE ||
      campaign.rules_version !== command.rules_version
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Flash-sale campaign is not active at the canonical rules version"
      )
    }
    const persistedItems = await this.campaign.listCampaignItems(
      { campaign_id: command.campaign_id },
      { order: { id: "ASC" } }
    )
    const byId = new Map(persistedItems.map((item) => [item.id, item]))
    if (
      command.items.some((item) => {
        const persisted = byId.get(item.campaign_item_id)
        return (
          !persisted ||
          persisted.campaign_id !== command.campaign_id ||
          persisted.variant_id !== item.variant_id
        )
      })
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Canonical checkout items no longer match the campaign snapshot"
      )
    }
  }
}

class MedusaCartLockAdapter implements CartLockPort {
  constructor(
    private readonly locking: ILockingModule,
    private readonly activeLocks: ActiveCartLockRegistry
  ) {}

  async execute<T>(
    key: string,
    job: (scope: CartLockScope) => Promise<T>,
    options: Readonly<{ timeout: number; expire: number }>
  ): Promise<T> {
    return await this.locking.execute(
      key,
      async (signal) => {
        // The value is a non-secret correlation ID and is propagated into
        // Medusa workflow context. Authorization comes from its live registry
        // membership and exact cart binding, not from keeping the value secret.
        const scopeKey = generateEntityId(undefined, "fslockscope")
        this.activeLocks.enter(scopeKey, key)
        try {
          return await job({
            signal,
            parent_step_idempotency_key: scopeKey,
          })
        } finally {
          this.activeLocks.leave(scopeKey)
        }
      },
      options
    )
  }
}

class MedusaNativeCommerceAdapter implements NativeCommercePort {
  constructor(
    private readonly container: MedusaContainer,
    private readonly activeLocks: ActiveCartLockRegistry
  ) {}

  async complete(command: {
    cart_id: string
    commerce_transaction_id: string
    parent_step_idempotency_key: string
    signal?: AbortSignal
  }) {
    if (
      !command.parent_step_idempotency_key.trim() ||
      !this.activeLocks.matches(
        command.parent_step_idempotency_key,
        command.cart_id
      )
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Native flash-sale checkout requires the paired active Cart Lock"
      )
    }
    if (command.signal?.aborted) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        "Cart Lock was lost before native checkout"
      )
    }
    try {
      const transaction = await completeCartWorkflow(this.container).run({
        input: { id: command.cart_id },
        context: {
          transactionId: command.commerce_transaction_id,
          parentStepIdempotencyKey: command.parent_step_idempotency_key,
        },
      })
      const orderId = (transaction.result as { id?: unknown })?.id
      if (typeof orderId !== "string" || !orderId.trim()) {
        return {
          kind: "unknown" as const,
          error_code: INVALID_NATIVE_SUCCESS,
        }
      }
      return { kind: "succeeded" as const, order_id: orderId }
    } catch (error) {
      if (
        MedusaError.isMedusaError(error) &&
        error.code === MedusaError.Codes.INSUFFICIENT_INVENTORY
      ) {
        return {
          kind: "definitive_failure" as const,
          error_code: INVENTORY_DEFINITIVE_FAILURE,
        }
      }
      return { kind: "unknown" as const, error_code: UNKNOWN_NATIVE_RESULT }
    }
  }
}

export type MedusaFlashSaleCheckoutRuntimeOptions = Readonly<
  Partial<
    Omit<FlashSaleCheckoutOrchestratorOptions, "workerIdFactory"> & {
      workerIdFactory: () => string
    }
  >
>

export function createMedusaFlashSaleCheckoutRuntimePorts(
  container: MedusaContainer
): Readonly<{
  campaign: CampaignCheckoutPort
  cartLock: CartLockPort
  commerce: NativeCommercePort
}> {
  const activeLocks = activeCartLockRegistry()
  const campaign = container.resolve<CampaignModuleReadPort>(
    FlashSalePluginModule.CAMPAIGN
  )
  const locking = container.resolve<ILockingModule>(Modules.LOCKING)
  return {
    campaign: new MedusaCampaignCheckoutAdapter(campaign),
    cartLock: new MedusaCartLockAdapter(locking, activeLocks),
    commerce: new MedusaNativeCommerceAdapter(container, activeLocks),
  }
}

export function createMedusaFlashSaleCheckoutOrchestrator(
  container: MedusaContainer,
  options: MedusaFlashSaleCheckoutRuntimeOptions = {}
): FlashSaleCheckoutOrchestrator {
  const runtime = createMedusaFlashSaleCheckoutRuntimePorts(container)
  const allocation = container.resolve<AllocationCheckoutPort>(
    FlashSalePluginModule.ALLOCATION
  )
  const checkout = container.resolve<CheckoutExecutionPort>(
    FlashSalePluginModule.CHECKOUT
  )

  return new FlashSaleCheckoutOrchestrator(
    {
      campaign: runtime.campaign,
      allocation,
      checkout,
      cartLock: runtime.cartLock,
      commerce: runtime.commerce,
    },
    {
      workerIdFactory:
        options.workerIdFactory ??
        (() => generateEntityId(undefined, "fscheckoutworker")),
      lease_seconds: options.lease_seconds ?? 30,
      lock_timeout_seconds: options.lock_timeout_seconds ?? 30,
      lock_expire_seconds: options.lock_expire_seconds ?? 120,
      unknown_reconcile_after_seconds:
        options.unknown_reconcile_after_seconds ?? 30,
    }
  )
}
