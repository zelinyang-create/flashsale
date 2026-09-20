jest.mock("@medusajs/medusa/core-flows", () => ({
  completeCartWorkflow: jest.fn(),
}))

import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import {
  executeAuthorizedCompleteCart,
  preserveCompletedCommerce,
} from "../execute-authorized-complete-cart"

const mockRun = jest.fn()
const mockCancel = jest.fn()
const mockWorkflow = jest.mocked(completeCartWorkflow)

describe("authorized native complete-cart bridge", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRun.mockResolvedValue({ result: { id: "order-1" } })
    mockWorkflow.mockReturnValue({
      run: mockRun,
      cancel: mockCancel,
    } as never)
  })

  const context = {
    container: { resolve: jest.fn() },
    idempotencyKey: "outer-step-key",
    context: {
      transactionId: "untrusted-outer-transaction",
      requestId: "request-1",
    },
  }

  it("binds the native workflow to the server commerce transaction", async () => {
    await expect(
      executeAuthorizedCompleteCart(
        {
          cart_id: "cart-1",
          commerce_transaction_id: "commerce-transaction-1",
        },
        context as never
      )
    ).resolves.toMatchObject({ output: { id: "order-1" } })
    expect(mockWorkflow).toHaveBeenCalledWith(context.container)
    expect(mockRun).toHaveBeenCalledWith({
      input: { id: "cart-1" },
      context: {
        requestId: "request-1",
        transactionId: "commerce-transaction-1",
        parentStepIdempotencyKey: "outer-step-key",
      },
    })
  })

  it("rejects non-exact or accessor-bearing bridge input", async () => {
    await expect(
      executeAuthorizedCompleteCart(
        {
          cart_id: "cart-1",
          commerce_transaction_id: "commerce-transaction-1",
          extra: true,
        } as never,
        context as never
      )
    ).rejects.toThrow("exact record")

    const accessor = { cart_id: "cart-1" } as Record<string, unknown>
    Object.defineProperty(accessor, "commerce_transaction_id", {
      enumerable: true,
      get: () => "commerce-transaction-1",
    })
    await expect(
      executeAuthorizedCompleteCart(accessor as never, context as never)
    ).rejects.toThrow("commerce_transaction_id")
  })

  it("never cancels successful Commerce during parent compensation", async () => {
    await preserveCompletedCommerce()
    expect(mockCancel).not.toHaveBeenCalled()
    expect(mockRun).not.toHaveBeenCalled()
  })
})
