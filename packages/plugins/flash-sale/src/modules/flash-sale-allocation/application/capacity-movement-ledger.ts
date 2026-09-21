import {
  ActivateAllocationMovementLedgerCommand,
  ActivateAllocationMovementLedgerResult,
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationMovementLedgerStore,
} from "./contracts"

function isExactEmptyRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (
      (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).length === 0
    )
  } catch {
    return false
  }
}

export class ActivateAllocationMovementLedgerHandler {
  constructor(private readonly store: AllocationMovementLedgerStore) {}

  async execute(
    command: ActivateAllocationMovementLedgerCommand
  ): Promise<ActivateAllocationMovementLedgerResult> {
    if (!isExactEmptyRecord(command)) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.INVALID_COMMAND,
        "activateAllocationMovementLedger received an invalid command"
      )
    }
    return await this.store.activateMovementLedger(command)
  }
}
