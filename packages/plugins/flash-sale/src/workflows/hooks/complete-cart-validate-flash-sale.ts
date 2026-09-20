import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { validateFlashSaleCartCompletion } from "../checkout-guard"

completeCartWorkflow.hooks.validate(
  async (data, { container, transactionId }) => {
    await validateFlashSaleCartCompletion(
      data as never,
      container,
      transactionId
    )
  }
)
