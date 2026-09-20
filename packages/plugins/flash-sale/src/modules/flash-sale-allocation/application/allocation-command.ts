import {
  canonicalizeAllocationRequest,
  createCanonicalRequestFingerprint,
} from "../domain"
import {
  ALLOCATION_REQUEST_SCHEMA_VERSION,
  AllocationCommandError,
  AllocationCommandErrorCode,
  ClaimAttemptCommand,
  ClaimAttemptPersistenceInput,
  HoldQuotaCommand,
  HoldQuotaPersistenceInput,
} from "./contracts"

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const ITEM_FIELDS = new Set(["campaign_item_id", "quantity"])
const CLAIM_FIELDS = new Set([
  "campaign_id",
  "subject_id",
  "cart_id",
  "idempotency_key_hash",
  "expected_rules_version",
  "items",
])
const HOLD_FIELDS = new Set([
  "attempt_id",
  "campaign_id",
  "subject_id",
  "cart_id",
  "expected_rules_version",
  "items",
])

function hasUnsupportedKey(value: object, allowed: ReadonlySet<string>) {
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return (
      descriptor?.enumerable === true &&
      (typeof key !== "string" || !allowed.has(key))
    )
  })
}

function assertShape(
  command: { items: readonly unknown[] },
  allowed: ReadonlySet<string>,
  operation: string
) {
  if (
    !command ||
    typeof command !== "object" ||
    hasUnsupportedKey(command, allowed) ||
    !Array.isArray(command.items)
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      `${operation} received an unsupported command field`
    )
  }
  for (const item of command.items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      hasUnsupportedKey(item, ITEM_FIELDS)
    ) {
      throw new AllocationCommandError(
        AllocationCommandErrorCode.INVALID_COMMAND,
        `${operation} received an invalid allocation item shape`
      )
    }
  }
}

function canonicalize(command: {
  campaign_id: string
  subject_id: string
  cart_id: string | null
  expected_rules_version: number
  items: ClaimAttemptCommand["items"]
}) {
  const request = canonicalizeAllocationRequest({
    schema_version: ALLOCATION_REQUEST_SCHEMA_VERSION,
    campaign_id: command.campaign_id,
    subject_id: command.subject_id,
    cart_id: command.cart_id,
    rules_version: command.expected_rules_version,
    items: command.items,
  })
  const total = request.items.reduce((sum, item) => sum + item.quantity, 0)
  if (!Number.isSafeInteger(total)) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      "Total allocation quantity must be a safe integer"
    )
  }
  return request
}

export function prepareClaimCommand(
  command: ClaimAttemptCommand
): ClaimAttemptPersistenceInput {
  assertShape(command, CLAIM_FIELDS, "claimAttempt")
  if (
    typeof command.idempotency_key_hash !== "string" ||
    !LOWERCASE_SHA256.test(command.idempotency_key_hash)
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_IDEMPOTENCY_KEY_HASH,
      "idempotency_key_hash must be a 64-character lowercase SHA-256 hex digest"
    )
  }
  const request = canonicalize(command)
  return {
    campaign_id: request.campaign_id,
    subject_id: request.subject_id,
    cart_id: request.cart_id,
    idempotency_key_hash: command.idempotency_key_hash,
    request_hash: createCanonicalRequestFingerprint(request),
    expected_rules_version: request.rules_version,
    items: request.items,
  }
}

export function prepareHoldCommand(
  command: HoldQuotaCommand
): HoldQuotaPersistenceInput {
  assertShape(command, HOLD_FIELDS, "holdQuota")
  if (typeof command.attempt_id !== "string" || !command.attempt_id) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      "attempt_id must be a non-empty string"
    )
  }
  const request = canonicalize(command)
  return {
    attempt_id: command.attempt_id,
    campaign_id: request.campaign_id,
    subject_id: request.subject_id,
    cart_id: request.cart_id,
    request_hash: createCanonicalRequestFingerprint(request),
    expected_rules_version: request.rules_version,
    items: request.items,
  }
}
