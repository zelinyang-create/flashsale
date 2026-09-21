import {
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutOutboxReconciliationStore,
  ReconcileCheckoutOutboxCommand,
} from "../domain"

export class ReconcileCheckoutOutboxHandler {
  constructor(private readonly store: CheckoutOutboxReconciliationStore) {}
  async execute(command: ReconcileCheckoutOutboxCommand) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      return this.invalid()
    }
    const descriptors = Object.getOwnPropertyDescriptors(command)
    const keys = Reflect.ownKeys(descriptors)
    if (
      Object.getPrototypeOf(command) !== Object.prototype ||
      keys.some((key) => typeof key !== "string" ||
        !["execution_id", "sample_limit"].includes(key)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(command, key)
        return !descriptor?.enumerable || !("value" in descriptor) ||
          descriptor.get !== undefined || descriptor.set !== undefined
      })
    ) return this.invalid()
    const executionId = descriptors.execution_id?.value
    const sampleLimit = descriptors.sample_limit?.value ?? 20
    if (
      (executionId !== undefined &&
        (typeof executionId !== "string" || executionId.length < 1 || executionId.length > 255)) ||
      !Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100
    ) return this.invalid()
    return await this.store.reconcileCheckoutOutbox({
      ...(executionId ? { execution_id: executionId } : {}),
      sample_limit: sampleLimit,
    })
  }
  private invalid(): never {
    throw new CheckoutCommandError(
      CheckoutCommandErrorCode.INVALID_COMMAND,
      "reconcileCheckoutOutbox received an invalid command"
    )
  }
}
