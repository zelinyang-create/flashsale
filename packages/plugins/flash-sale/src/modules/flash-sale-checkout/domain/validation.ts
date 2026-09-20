import {
  AuthorizeCartCompletionCommand,
  CancelExecutionCommand,
  CartSnapshotItemInput,
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutSnapshotItemInput,
  ClaimCommerceLeaseCommand,
  CompleteExecutionCommand,
  FindExecutionForCartCommand,
  PrepareExecutionCommand,
  ReadExecutionReplayCommand,
  ReadCartCompletionAuthorizationCommand,
  RecordCommerceDefinitiveFailureCommand,
  RecordCommerceSucceededCommand,
  RecordCommerceUnknownCommand,
} from "./contracts"

const HASH = /^[a-f0-9]{64}$/
const MAX_IDENTIFIER_LENGTH = 255
const MAX_LEASE_SECONDS = 120
const MAX_RECONCILE_SECONDS = 86400

function invalid(message: string): never {
  throw new CheckoutCommandError(
    CheckoutCommandErrorCode.INVALID_COMMAND,
    message
  )
}

function assertExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.length ||
    keys.some((key) => {
      if (typeof key !== "string" || !fields.includes(key)) {
        return true
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })
  ) {
    invalid(`${label} must contain exactly ${fields.join(", ")}`)
  }
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    invalid(`${field} must be a non-empty string of at most 255 characters`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${field} must be a non-negative safe integer`)
  }
  return Number(value)
}

function normalizeItems<
  T extends CheckoutSnapshotItemInput | CartSnapshotItemInput
>(value: unknown, includeCampaignItem: boolean): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    invalid("items must contain between 1 and 100 entries")
  }
  const normalized = value.map((item, index) => {
    const fields = includeCampaignItem
      ? ["campaign_item_id", "variant_id", "quantity"]
      : ["variant_id", "quantity"]
    assertExactRecord(item, fields, `items[${index}]`)
    return {
      ...(includeCampaignItem
        ? { campaign_item_id: text(item.campaign_item_id, "campaign_item_id") }
        : {}),
      variant_id: text(item.variant_id, "variant_id"),
      quantity: positiveInteger(item.quantity, "quantity"),
    } as T
  })
  const variants = normalized.map((item) => item.variant_id)
  if (new Set(variants).size !== variants.length) {
    invalid("items must not contain duplicate variant_id values")
  }
  if (includeCampaignItem) {
    const campaignItems = normalized.map(
      (item) => (item as CheckoutSnapshotItemInput).campaign_item_id
    )
    if (new Set(campaignItems).size !== campaignItems.length) {
      invalid("items must not contain duplicate campaign_item_id values")
    }
  }
  return normalized.sort((left, right) =>
    left.variant_id.localeCompare(right.variant_id)
  )
}

export function prepareExecutionCommand(
  value: PrepareExecutionCommand
): PrepareExecutionCommand {
  assertExactRecord(
    value,
    [
      "attempt_id",
      "campaign_id",
      "subject_id",
      "cart_id",
      "command_id",
      "request_hash",
      "rules_version",
      "items",
    ],
    "prepareExecution command"
  )
  if (
    typeof value.request_hash !== "string" ||
    !HASH.test(value.request_hash)
  ) {
    throw new CheckoutCommandError(
      CheckoutCommandErrorCode.INVALID_REQUEST_HASH,
      "request_hash must be a lowercase hexadecimal SHA-256 digest"
    )
  }
  if (typeof value.command_id !== "string" || !HASH.test(value.command_id)) {
    throw new CheckoutCommandError(
      CheckoutCommandErrorCode.INVALID_COMMAND,
      "command_id must be a server-derived lowercase hexadecimal SHA-256 digest"
    )
  }
  return {
    attempt_id: text(value.attempt_id, "attempt_id"),
    campaign_id: text(value.campaign_id, "campaign_id"),
    subject_id: text(value.subject_id, "subject_id"),
    cart_id: text(value.cart_id, "cart_id"),
    command_id: text(value.command_id, "command_id"),
    request_hash: value.request_hash,
    rules_version: positiveInteger(value.rules_version, "rules_version"),
    items: normalizeItems<CheckoutSnapshotItemInput>(value.items, true),
  }
}

export function prepareClaimLeaseCommand(
  value: ClaimCommerceLeaseCommand
): ClaimCommerceLeaseCommand {
  assertExactRecord(
    value,
    ["execution_id", "worker_id", "lease_seconds"],
    "claimCommerceLease command"
  )
  const leaseSeconds = positiveInteger(value.lease_seconds, "lease_seconds")
  if (leaseSeconds > MAX_LEASE_SECONDS) {
    invalid(`lease_seconds must not exceed ${MAX_LEASE_SECONDS}`)
  }
  return {
    execution_id: text(value.execution_id, "execution_id"),
    worker_id: text(value.worker_id, "worker_id"),
    lease_seconds: leaseSeconds,
  }
}

export function prepareAuthorizeCommand(
  value: AuthorizeCartCompletionCommand
): AuthorizeCartCompletionCommand {
  assertExactRecord(
    value,
    ["execution_id", "worker_id", "lease_epoch"],
    "authorizeCartCompletion command"
  )
  return {
    execution_id: text(value.execution_id, "execution_id"),
    worker_id: text(value.worker_id, "worker_id"),
    lease_epoch: positiveInteger(value.lease_epoch, "lease_epoch"),
  }
}

export function prepareReadAuthorizationCommand(
  value: ReadCartCompletionAuthorizationCommand
): ReadCartCompletionAuthorizationCommand {
  assertExactRecord(
    value,
    [
      "cart_id",
      "subject_id",
      "campaign_id",
      "commerce_transaction_id",
      "rules_version",
      "items",
    ],
    "readCartCompletionAuthorization command"
  )
  return {
    cart_id: text(value.cart_id, "cart_id"),
    subject_id: text(value.subject_id, "subject_id"),
    campaign_id: text(value.campaign_id, "campaign_id"),
    commerce_transaction_id: text(
      value.commerce_transaction_id,
      "commerce_transaction_id"
    ),
    rules_version: positiveInteger(value.rules_version, "rules_version"),
    items: normalizeItems<CartSnapshotItemInput>(value.items, false),
  }
}

export function prepareFindExecutionForCartCommand(
  value: FindExecutionForCartCommand
): FindExecutionForCartCommand {
  assertExactRecord(value, ["cart_id"], "findExecutionForCart command")
  return { cart_id: text(value.cart_id, "cart_id") }
}

const RESULT_FENCE_FIELDS = [
  "execution_id",
  "expected_version",
  "worker_id",
  "lease_epoch",
  "commerce_transaction_id",
] as const

function resultFence<T extends Record<string, unknown>>(
  value: T,
  fields: readonly string[],
  label: string
) {
  assertExactRecord(value, fields, label)
  return {
    execution_id: text(value.execution_id, "execution_id"),
    expected_version: positiveInteger(
      value.expected_version,
      "expected_version"
    ),
    worker_id: text(value.worker_id, "worker_id"),
    lease_epoch: positiveInteger(value.lease_epoch, "lease_epoch"),
    commerce_transaction_id: text(
      value.commerce_transaction_id,
      "commerce_transaction_id"
    ),
  }
}

export function prepareRecordCommerceSucceededCommand(
  value: RecordCommerceSucceededCommand
): RecordCommerceSucceededCommand {
  return {
    ...resultFence(
      value,
      [...RESULT_FENCE_FIELDS, "order_id"],
      "recordCommerceSucceeded command"
    ),
    order_id: text(value.order_id, "order_id"),
  }
}

export function prepareRecordCommerceDefinitiveFailureCommand(
  value: RecordCommerceDefinitiveFailureCommand
): RecordCommerceDefinitiveFailureCommand {
  return {
    ...resultFence(
      value,
      [...RESULT_FENCE_FIELDS, "error_code"],
      "recordCommerceDefinitiveFailure command"
    ),
    error_code: text(value.error_code, "error_code"),
  }
}

export function prepareRecordCommerceUnknownCommand(
  value: RecordCommerceUnknownCommand
): RecordCommerceUnknownCommand {
  const prepared = resultFence(
    value,
    [...RESULT_FENCE_FIELDS, "error_code", "reconcile_after_seconds"],
    "recordCommerceUnknown command"
  )
  const reconcileAfterSeconds = positiveInteger(
    value.reconcile_after_seconds,
    "reconcile_after_seconds"
  )
  if (reconcileAfterSeconds > MAX_RECONCILE_SECONDS) {
    invalid(`reconcile_after_seconds must not exceed ${MAX_RECONCILE_SECONDS}`)
  }
  return {
    ...prepared,
    error_code: text(value.error_code, "error_code"),
    reconcile_after_seconds: reconcileAfterSeconds,
  }
}

export function prepareCompleteExecutionCommand(
  value: CompleteExecutionCommand
): CompleteExecutionCommand {
  assertExactRecord(
    value,
    ["execution_id", "expected_version", "commerce_transaction_id", "order_id"],
    "completeExecution command"
  )
  return {
    execution_id: text(value.execution_id, "execution_id"),
    expected_version: positiveInteger(
      value.expected_version,
      "expected_version"
    ),
    commerce_transaction_id: text(
      value.commerce_transaction_id,
      "commerce_transaction_id"
    ),
    order_id: text(value.order_id, "order_id"),
  }
}

export function prepareCancelExecutionCommand(
  value: CancelExecutionCommand
): CancelExecutionCommand {
  assertExactRecord(
    value,
    ["execution_id", "expected_version", "commerce_transaction_id"],
    "cancelExecution command"
  )
  return {
    execution_id: text(value.execution_id, "execution_id"),
    expected_version: positiveInteger(
      value.expected_version,
      "expected_version"
    ),
    commerce_transaction_id: text(
      value.commerce_transaction_id,
      "commerce_transaction_id"
    ),
  }
}

export function prepareReadExecutionReplayCommand(
  value: ReadExecutionReplayCommand
): ReadExecutionReplayCommand {
  assertExactRecord(
    value,
    ["command_id", "cart_id", "subject_id", "request_hash"],
    "readExecutionReplay command"
  )
  if (
    typeof value.command_id !== "string" ||
    !HASH.test(value.command_id) ||
    typeof value.request_hash !== "string" ||
    !HASH.test(value.request_hash)
  ) {
    invalid("replay hashes must be lowercase hexadecimal SHA-256 digests")
  }
  return {
    command_id: value.command_id,
    cart_id: text(value.cart_id, "cart_id"),
    subject_id: text(value.subject_id, "subject_id"),
    request_hash: value.request_hash,
  }
}

export { assertExactRecord, nonNegativeInteger }
