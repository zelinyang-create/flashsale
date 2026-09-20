import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationQuotaStore,
  CancelHeldQuotaCommand,
  SettlementQuotaCommand,
  SettleQuotaResult,
} from "./contracts"

const SETTLE_FIELDS = new Set(["attempt_id"])
const SETTLEMENT_FIELDS = new Set(["attempt_id", "settlement_id"])
const MAX_SETTLEMENT_IDENTIFIER_LENGTH = 255

function isExactPlainRecord(
  command: unknown,
  fields: ReadonlySet<string>
): command is Record<string, unknown> {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return false
  }
  const prototype = Object.getPrototypeOf(command)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  const keys = Reflect.ownKeys(command)
  return (
    keys.length === fields.size &&
    keys.every((key) => {
      if (typeof key !== "string" || !fields.has(key)) {
        return false
      }
      const descriptor = Object.getOwnPropertyDescriptor(command, key)
      return descriptor?.enumerable === true && "value" in descriptor
    })
  )
}

export function prepareAttemptOnlyCommand(
  command: CancelHeldQuotaCommand,
  operation: string
): CancelHeldQuotaCommand {
  if (
    !isExactPlainRecord(command, SETTLE_FIELDS) ||
    typeof command.attempt_id !== "string" ||
    !command.attempt_id.trim() ||
    command.attempt_id.length > MAX_SETTLEMENT_IDENTIFIER_LENGTH
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      `${operation} requires exactly one non-empty attempt_id`
    )
  }
  return { attempt_id: command.attempt_id }
}

export function prepareSettlementCommand(
  command: SettlementQuotaCommand,
  operation: string
): SettlementQuotaCommand {
  if (
    !isExactPlainRecord(command, SETTLEMENT_FIELDS) ||
    typeof command.attempt_id !== "string" ||
    !command.attempt_id.trim() ||
    command.attempt_id.length > MAX_SETTLEMENT_IDENTIFIER_LENGTH ||
    typeof command.settlement_id !== "string" ||
    !command.settlement_id.trim() ||
    command.settlement_id.length > MAX_SETTLEMENT_IDENTIFIER_LENGTH
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      `${operation} requires exactly one non-empty attempt_id and settlement_id`
    )
  }
  return {
    attempt_id: command.attempt_id,
    settlement_id: command.settlement_id,
  }
}

export class BeginQuotaSettlementHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: SettlementQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.beginQuotaSettlement(
      prepareSettlementCommand(command, "beginQuotaSettlement")
    )
  }
}

export class ConsumeQuotaSettlementHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: SettlementQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.consumeQuotaSettlement(
      prepareSettlementCommand(command, "consumeQuotaSettlement")
    )
  }
}

export class AuthorizeQuotaSettlementHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: SettlementQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.authorizeQuotaSettlement(
      prepareSettlementCommand(command, "authorizeQuotaSettlement")
    )
  }
}

export class ReleaseQuotaSettlementHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: SettlementQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.releaseQuotaSettlement(
      prepareSettlementCommand(command, "releaseQuotaSettlement")
    )
  }
}

export class CancelHeldQuotaHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: CancelHeldQuotaCommand): Promise<SettleQuotaResult> {
    return await this.store.cancelHeldQuota(
      prepareAttemptOnlyCommand(command, "cancelHeldQuota")
    )
  }
}
