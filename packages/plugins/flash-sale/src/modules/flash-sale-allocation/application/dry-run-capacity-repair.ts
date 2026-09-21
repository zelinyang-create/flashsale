import { createHash } from "crypto"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  CapacityRepairPlanStore,
  DEFAULT_MOVEMENT_LEDGER_BATCH_SIZE,
  DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  DryRunCapacityRepairCommand,
  DryRunCapacityRepairResult,
  MAX_MOVEMENT_LEDGER_BATCH_SIZE,
  MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  PreparedDryRunCapacityRepairCommand,
} from "./contracts"

const FIELDS = new Set([
  "request_id",
  "idempotency_key",
  "campaign_id",
  "actor",
  "reason",
  "ticket",
  "statement_timeout_ms",
  "batch_size",
])

export function compareRepairPlanKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalRepairPlanValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      invalid("repair plan canonical numbers must be safe integers")
    }
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalRepairPlanValue)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("repair plan canonical values must be plain objects")
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>).sort(
      compareRepairPlanKeys
    )) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined || typeof entry === "bigint") {
        invalid("repair plan canonical values are not JSON-safe")
      }
      result[key] = canonicalRepairPlanValue(entry)
    }
    return result
  }
  return invalid("repair plan canonical values are not JSON-safe")
}

export function canonicalRepairPlanJson(value: unknown): string {
  return JSON.stringify(canonicalRepairPlanValue(value))
}

export function repairPlanDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalRepairPlanJson(value))
    .digest("hex")
}

function invalid(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.INVALID_COMMAND,
    message
  )
}

function record(command: unknown): Record<string, unknown> {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    invalid("dryRunCapacityRepair requires a plain command")
  }
  const prototype = Object.getPrototypeOf(command)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("dryRunCapacityRepair requires a plain command")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(command)) {
    if (typeof key !== "string" || !FIELDS.has(key)) {
      invalid("dryRunCapacityRepair received an unsupported command field")
    }
    const descriptor = Object.getOwnPropertyDescriptor(command, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid("dryRunCapacityRepair command fields must be plain values")
    }
    result[key] = descriptor.value
  }
  return result
}

function boundedText(
  value: unknown,
  field: string,
  maximum: number
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  ) {
    invalid(`${field} must be a bounded, trimmed string`)
  }
  return value
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

export function prepareDryRunCapacityRepairCommand(
  command: DryRunCapacityRepairCommand
): PreparedDryRunCapacityRepairCommand {
  const values = record(command)
  const hasRequestId = values.request_id !== undefined
  const hasIdempotencyKey = values.idempotency_key !== undefined
  if (hasRequestId === hasIdempotencyKey) {
    invalid("exactly one of request_id or idempotency_key is required")
  }
  const identityType = hasRequestId ? "request_id" : "idempotency_key"
  const identity = boundedText(
    hasRequestId ? values.request_id : values.idempotency_key,
    identityType,
    hasRequestId ? 255 : 512
  )
  const campaignId =
    values.campaign_id === undefined
      ? undefined
      : boundedText(values.campaign_id, "campaign_id", 255)
  const actor = boundedText(values.actor, "actor", 255)
  const reason = boundedText(values.reason, "reason", 2_000)
  const ticket = boundedText(values.ticket, "ticket", 255)
  const statementTimeoutMs = boundedInteger(
    values.statement_timeout_ms,
    DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
    100,
    MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
    "statement_timeout_ms"
  )
  const batchSize = boundedInteger(
    values.batch_size,
    DEFAULT_MOVEMENT_LEDGER_BATCH_SIZE,
    1,
    MAX_MOVEMENT_LEDGER_BATCH_SIZE,
    "batch_size"
  )
  const requestIdentityDigest = repairPlanDigest({
    domain: "capacity-repair-request-identity-v1",
    identity_type: identityType,
    identity,
  })
  const canonical = {
    schema: "capacity-repair-command-v1",
    request_identity_digest: requestIdentityDigest,
    campaign_id: campaignId ?? null,
    actor,
    reason,
    ticket,
    statement_timeout_ms: statementTimeoutMs,
    batch_size: batchSize,
  }
  return Object.freeze({
    request_identity_digest: requestIdentityDigest,
    command_digest: repairPlanDigest(canonical),
    campaign_id: campaignId,
    actor,
    reason,
    ticket,
    statement_timeout_ms: statementTimeoutMs,
    batch_size: batchSize,
  })
}

export class DryRunCapacityRepairHandler {
  constructor(private readonly store: CapacityRepairPlanStore) {}

  async execute(
    command: DryRunCapacityRepairCommand
  ): Promise<DryRunCapacityRepairResult> {
    return await this.store.dryRunCapacityRepair(
      prepareDryRunCapacityRepairCommand(command)
    )
  }
}
