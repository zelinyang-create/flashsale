import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationReconciliationStore,
  DEFAULT_RECONCILIATION_SAMPLE_LIMIT,
  MAX_RECONCILIATION_SAMPLE_LIMIT,
  ReconcileAllocationCommand,
  ReconcileAllocationResult,
} from "./contracts"

const RECONCILE_FIELDS = new Set(["campaign_id", "sample_limit"])

function readExactPlainCommand(command: unknown) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return null
  }
  const prototype = Object.getPrototypeOf(command)
  if (prototype !== Object.prototype && prototype !== null) {
    return null
  }
  const values: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(command)) {
    if (typeof key !== "string" || !RECONCILE_FIELDS.has(key)) {
      return null
    }
    const descriptor = Object.getOwnPropertyDescriptor(command, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return null
    }
    values[key] = descriptor.value
  }
  return values
}

export function prepareReconcileAllocationCommand(
  command: ReconcileAllocationCommand
) {
  const values = readExactPlainCommand(command)
  if (!values) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      "reconcileAllocation received an unsupported command field"
    )
  }
  const campaignId = values.campaign_id
  if (
    campaignId !== undefined &&
    (typeof campaignId !== "string" || !campaignId.trim())
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      "campaign_id must be a non-blank string when provided"
    )
  }
  const sampleLimit =
    values.sample_limit === undefined
      ? DEFAULT_RECONCILIATION_SAMPLE_LIMIT
      : values.sample_limit
  if (
    typeof sampleLimit !== "number" ||
    !Number.isSafeInteger(sampleLimit) ||
    sampleLimit < 1 ||
    sampleLimit > MAX_RECONCILIATION_SAMPLE_LIMIT
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      `sample_limit must be an integer between 1 and ${MAX_RECONCILIATION_SAMPLE_LIMIT}`
    )
  }
  return {
    campaign_id: campaignId as string | undefined,
    sample_limit: sampleLimit,
  }
}

export class ReconcileAllocationHandler {
  constructor(private readonly store_: AllocationReconciliationStore) {}

  async execute(
    command: ReconcileAllocationCommand
  ): Promise<ReconcileAllocationResult> {
    return await this.store_.reconcileAllocation(
      prepareReconcileAllocationCommand(command)
    )
  }
}
