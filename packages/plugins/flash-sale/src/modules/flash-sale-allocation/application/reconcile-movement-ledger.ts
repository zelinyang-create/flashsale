import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  DEFAULT_MOVEMENT_LEDGER_BATCH_SIZE,
  DEFAULT_MOVEMENT_LEDGER_SAMPLE_LIMIT,
  DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  MAX_MOVEMENT_LEDGER_BATCH_SIZE,
  MAX_MOVEMENT_LEDGER_SAMPLE_LIMIT,
  MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  MovementLedgerReconciliationStore,
  PreparedReconcileMovementLedgerCommand,
  ReconcileMovementLedgerCommand,
  ReconcileMovementLedgerResult,
} from "./contracts"

const FIELDS = new Set([
  "campaign_id",
  "sample_limit",
  "statement_timeout_ms",
  "batch_size",
])

function invalid(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.INVALID_COMMAND,
    message
  )
}

function exactPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("reconcileMovementLedger requires a plain command")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("reconcileMovementLedger requires a plain command")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !FIELDS.has(key)) {
      invalid("reconcileMovementLedger received an unsupported command field")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid("reconcileMovementLedger command fields must be plain values")
    }
    result[key] = descriptor.value
  }
  return result
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const candidate = value === undefined ? fallback : value
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return candidate
}

export function prepareReconcileMovementLedgerCommand(
  command: ReconcileMovementLedgerCommand
): PreparedReconcileMovementLedgerCommand {
  const values = exactPlainRecord(command)
  const campaignId = values.campaign_id
  if (
    campaignId !== undefined &&
    (typeof campaignId !== "string" ||
      campaignId.trim() !== campaignId ||
      campaignId.length < 1 ||
      campaignId.length > 255)
  ) {
    invalid("campaign_id must be a bounded, trimmed identifier")
  }
  return Object.freeze({
    campaign_id: campaignId as string | undefined,
    sample_limit: boundedInteger(
      values.sample_limit,
      DEFAULT_MOVEMENT_LEDGER_SAMPLE_LIMIT,
      1,
      MAX_MOVEMENT_LEDGER_SAMPLE_LIMIT,
      "sample_limit"
    ),
    statement_timeout_ms: boundedInteger(
      values.statement_timeout_ms,
      DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
      100,
      MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
      "statement_timeout_ms"
    ),
    batch_size: boundedInteger(
      values.batch_size,
      DEFAULT_MOVEMENT_LEDGER_BATCH_SIZE,
      1,
      MAX_MOVEMENT_LEDGER_BATCH_SIZE,
      "batch_size"
    ),
  })
}

export class ReconcileMovementLedgerHandler {
  constructor(private readonly store: MovementLedgerReconciliationStore) {}

  async execute(
    command: ReconcileMovementLedgerCommand
  ): Promise<ReconcileMovementLedgerResult> {
    return await this.store.reconcileMovementLedger(
      prepareReconcileMovementLedgerCommand(command)
    )
  }
}
