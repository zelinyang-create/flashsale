import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationQuotaStore,
  ExpireDueQuotaCommand,
  ExpireDueQuotaResult,
  ExpireQuotaCommand,
  SettleQuotaResult,
} from "./contracts"
import { prepareAttemptOnlyCommand } from "./settle-quota"

const MAX_EXPIRY_BATCH_SIZE = 1000

export function prepareExpireDueQuotaCommand(
  command: ExpireDueQuotaCommand
): ExpireDueQuotaCommand {
  if (
    !command ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    Reflect.ownKeys(command).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(command, key)
      return descriptor?.enumerable === true && key !== "limit"
    }) ||
    !Number.isInteger(command.limit) ||
    command.limit < 1 ||
    command.limit > MAX_EXPIRY_BATCH_SIZE
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      `expireDueQuota limit must be an integer between 1 and ${MAX_EXPIRY_BATCH_SIZE}`
    )
  }
  return { limit: command.limit }
}

export class ExpireQuotaHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: ExpireQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.expireQuota(
      prepareAttemptOnlyCommand(command, "expireQuota")
    )
  }
}

export class ExpireDueQuotaHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: ExpireDueQuotaCommand): Promise<ExpireDueQuotaResult> {
    return await this.store.expireDueQuota(
      prepareExpireDueQuotaCommand(command)
    )
  }
}

export { MAX_EXPIRY_BATCH_SIZE }
