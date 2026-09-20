jest.mock("@medusajs/medusa/core-flows", () => ({
  completeCartWorkflow: jest.fn(),
  reserveInventoryStepId: "reserve-inventory-step",
}))

import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import {
  MedusaError,
  Modules,
  TransactionHandlerType,
  TransactionState,
} from "@medusajs/framework/utils"
import { CampaignState, FlashSalePluginModule } from "../../../types"
import { createMedusaFlashSaleCheckoutRuntimePorts } from "../medusa-runtime-adapters"

const workflow = jest.mocked(completeCartWorkflow)

describe("Medusa flash-sale checkout runtime adapters", () => {
  const campaign = {
    retrieveCampaign: jest.fn(),
    listCampaignItems: jest.fn(),
  }
  const locking = { execute: jest.fn() }
  const run = jest.fn()
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === FlashSalePluginModule.CAMPAIGN) {
        return campaign
      }
      if (key === Modules.LOCKING) {
        return locking
      }
      throw new Error(`Unexpected dependency: ${key}`)
    }),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    campaign.retrieveCampaign.mockResolvedValue({
      id: "campaign-1",
      state: CampaignState.ACTIVE,
      rules_version: 3,
    })
    campaign.listCampaignItems.mockResolvedValue([
      {
        id: "campaign-item-1",
        campaign_id: "campaign-1",
        variant_id: "variant-1",
      },
    ])
    locking.execute.mockImplementation(
      async (_key, job: (signal?: AbortSignal) => Promise<unknown>) =>
        await job(new AbortController().signal)
    )
    run.mockResolvedValue({ result: { id: "order-1" } })
    workflow.mockReturnValue({ run } as never)
  })

  it("uses the raw cart lock and the persisted transaction inside its paired lock scope", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)
    let knownScopeKey = ""
    await expect(
      ports.cartLock.execute(
        "cart-1",
        async (scope) => {
          knownScopeKey = scope.parent_step_idempotency_key
          return await ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-1",
            parent_step_idempotency_key: scope.parent_step_idempotency_key,
            signal: scope.signal,
          })
        },
        { timeout: 7, expire: 19 }
      )
    ).resolves.toEqual({ kind: "succeeded", order_id: "order-1" })

    expect(locking.execute).toHaveBeenCalledWith(
      "cart-1",
      expect.any(Function),
      { timeout: 7, expire: 19 }
    )
    expect(run).toHaveBeenCalledWith({
      input: { id: "cart-1" },
      context: {
        transactionId: "commerce-transaction-1",
        parentStepIdempotencyKey: expect.stringMatching(/^fslockscope_/),
      },
      throwOnError: false,
    })

    // Treat the propagated value as fully known: callback cleanup, rather
    // than secrecy, must make it unusable after the lock scope exits.
    await expect(
      ports.commerce.complete({
        cart_id: "cart-1",
        commerce_transaction_id: "commerce-transaction-reuse",
        parent_step_idempotency_key: knownScopeKey,
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("removes a known scope binding when the lock job throws", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)
    let knownScopeKey = ""

    await expect(
      ports.cartLock.execute(
        "cart-1",
        async (scope) => {
          knownScopeKey = scope.parent_step_idempotency_key
          throw new Error("nested orchestration failed")
        },
        { timeout: 7, expire: 19 }
      )
    ).rejects.toThrow("nested orchestration failed")

    await expect(
      ports.commerce.complete({
        cart_id: "cart-1",
        commerce_transaction_id: "commerce-transaction-reuse",
        parent_step_idempotency_key: knownScopeKey,
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE })
    expect(run).not.toHaveBeenCalled()
  })

  it("rejects an unrelated permit even while the same cart lock is active", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)

    await ports.cartLock.execute(
      "cart-1",
      async (scope) => {
        await expect(
          ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-attacker",
            parent_step_idempotency_key: "borrowed-active-cart",
            signal: scope.signal,
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE })
        expect(run).not.toHaveBeenCalled()

        await expect(
          ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-owner",
            parent_step_idempotency_key: scope.parent_step_idempotency_key,
            signal: scope.signal,
          })
        ).resolves.toEqual({ kind: "succeeded", order_id: "order-1" })
      },
      { timeout: 7, expire: 19 }
    )

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("refuses to skip the native lock outside the paired outer lock scope", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)
    await expect(
      ports.commerce.complete({
        cart_id: "cart-1",
        commerce_transaction_id: "commerce-transaction-1",
        parent_step_idempotency_key: "server-parent-step-1",
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE })
    expect(run).not.toHaveBeenCalled()
  })

  it("classifies only a cleanly reverted public inventory step as definitive", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)
    run.mockResolvedValueOnce({
      errors: [
        {
          action: "reserve-inventory-step",
          handlerType: TransactionHandlerType.INVOKE,
          error: new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            "inventory module rejected the reservation"
          ),
        },
      ],
      transaction: { getState: () => TransactionState.REVERTED },
    })
    await expect(
      ports.cartLock.execute(
        "cart-1",
        async (scope) =>
          await ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-1",
            parent_step_idempotency_key: scope.parent_step_idempotency_key,
            signal: scope.signal,
          }),
        { timeout: 7, expire: 19 }
      )
    ).resolves.toEqual({
      kind: "definitive_failure",
      error_code: "INVENTORY_STAGE_REVERTED",
    })

    run.mockResolvedValueOnce({
      errors: [
        {
          action: "authorize-payment-session-step",
          handlerType: TransactionHandlerType.INVOKE,
          error: {
            code: MedusaError.Codes.INSUFFICIENT_INVENTORY,
            type: MedusaError.Types.NOT_ALLOWED,
          },
        },
      ],
      transaction: { getState: () => TransactionState.REVERTED },
    })
    await expect(
      ports.cartLock.execute(
        "cart-1",
        async (scope) =>
          await ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-serialized",
            parent_step_idempotency_key: scope.parent_step_idempotency_key,
            signal: scope.signal,
          }),
        { timeout: 7, expire: 19 }
      )
    ).resolves.toEqual({
      kind: "unknown",
      error_code: "NATIVE_COMMERCE_RESULT_UNKNOWN",
    })

    run.mockRejectedValueOnce(new Error("provider connection reset"))
    let failedNestedScopeKey = ""
    await expect(
      ports.cartLock.execute(
        "cart-1",
        async (scope) => {
          failedNestedScopeKey = scope.parent_step_idempotency_key
          return await ports.commerce.complete({
            cart_id: "cart-1",
            commerce_transaction_id: "commerce-transaction-1",
            parent_step_idempotency_key: scope.parent_step_idempotency_key,
            signal: scope.signal,
          })
        },
        { timeout: 7, expire: 19 }
      )
    ).resolves.toEqual({
      kind: "unknown",
      error_code: "NATIVE_COMMERCE_RESULT_UNKNOWN",
    })
    await expect(
      ports.commerce.complete({
        cart_id: "cart-1",
        commerce_transaction_id: "commerce-transaction-reuse",
        parent_step_idempotency_key: failedNestedScopeKey,
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE })
  })

  it("revalidates the canonical campaign item mapping", async () => {
    const ports = createMedusaFlashSaleCheckoutRuntimePorts(container as never)
    await expect(
      ports.campaign.assertCheckoutEligible({
        campaign_id: "campaign-1",
        subject_id: "customer-1",
        cart_id: "cart-1",
        rules_version: 3,
        items: [
          {
            campaign_item_id: "campaign-item-1",
            variant_id: "variant-1",
            quantity: 1,
          },
        ],
      })
    ).resolves.toBeUndefined()

    campaign.listCampaignItems.mockResolvedValueOnce([])
    await expect(
      ports.campaign.assertCheckoutEligible({
        campaign_id: "campaign-1",
        subject_id: "customer-1",
        cart_id: "cart-1",
        rules_version: 3,
        items: [
          {
            campaign_item_id: "campaign-item-1",
            variant_id: "variant-1",
            quantity: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
  })
})
