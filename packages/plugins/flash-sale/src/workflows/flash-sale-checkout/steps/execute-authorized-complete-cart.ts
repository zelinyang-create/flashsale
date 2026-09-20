import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import {
  createStep,
  StepExecutionContext,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"

export type ExecuteAuthorizedCompleteCartInput = Readonly<{
  cart_id: string
  commerce_transaction_id: string
}>

const MAX_IDENTIFIER_LENGTH = 255

function exactIdentifierInput(
  value: ExecuteAuthorizedCompleteCartInput
): ExecuteAuthorizedCompleteCartInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== 2
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Authorized complete-cart input must be an exact record"
    )
  }
  for (const field of ["cart_id", "commerce_transaction_id"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !descriptor.value.trim() ||
      descriptor.value.length > MAX_IDENTIFIER_LENGTH
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${field} must be a non-empty bounded identifier`
      )
    }
  }
  return {
    cart_id: value.cart_id,
    commerce_transaction_id: value.commerce_transaction_id,
  }
}

export async function executeAuthorizedCompleteCart(
  rawInput: ExecuteAuthorizedCompleteCartInput,
  context: StepExecutionContext
) {
  const input = exactIdentifierInput(rawInput)
  const transaction = await completeCartWorkflow(context.container).run({
    input: { id: input.cart_id },
    context: {
      ...context.context,
      transactionId: input.commerce_transaction_id,
      parentStepIdempotencyKey: context.idempotencyKey,
    },
  })
  return new StepResponse(transaction.result)
}

export async function preserveCompletedCommerce() {
  // Deliberately do not cancel the nested complete-cart transaction. If a
  // later quota consume fails after Commerce succeeded, CheckoutExecution
  // remains COMMERCE_SUCCEEDED and a replay finishes settlement.
  return new StepResponse()
}

export const executeAuthorizedCompleteCartStep = createStep(
  "execute-authorized-complete-cart",
  executeAuthorizedCompleteCart,
  preserveCompletedCommerce
)
