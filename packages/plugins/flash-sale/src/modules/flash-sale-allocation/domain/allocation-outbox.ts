import { createHash } from "crypto"
import { PurchaseAttemptState } from "../../../types"
import {
  ClaimedAllocationHold,
  ClaimedPurchaseAttempt,
} from "../application/contracts"

export const ALLOCATION_OUTBOX_AGGREGATE_TYPE = "purchase_attempt" as const
export const ALLOCATION_OUTBOX_SCHEMA_VERSION = 1 as const
export const ALLOCATION_OUTBOX_MAX_PAYLOAD_BYTES = 65_536

export const AllocationOutboxEventName = {
  QUOTA_HELD: "flash_sale.quota.held.v1",
  QUOTA_REJECTED: "flash_sale.quota.rejected.v1",
  QUOTA_COMMITTING: "flash_sale.quota.settlement_started.v1",
  QUOTA_CONSUMED: "flash_sale.quota.consumed.v1",
  QUOTA_RELEASED: "flash_sale.quota.released.v1",
  QUOTA_EXPIRED: "flash_sale.quota.expired.v1",
} as const

export type AllocationOutboxReleaseKind =
  | "held_cancel"
  | "settlement_release"

export type AllocationOutboxPayload = Readonly<{
  attempt_id: string
  campaign_id: string
  rules_version: number
  state: Exclude<PurchaseAttemptState, PurchaseAttemptState.PENDING>
  items: readonly Readonly<{
    campaign_item_id: string
    quantity: number
  }>[]
  settlement_id?: string
  release_kind?: AllocationOutboxReleaseKind
  rejection_code?: string
}>

export type AllocationOutboxEnvelope = Readonly<{
  event_name: string
  schema_version: typeof ALLOCATION_OUTBOX_SCHEMA_VERSION
  aggregate_type: typeof ALLOCATION_OUTBOX_AGGREGATE_TYPE
  aggregate_id: string
  aggregate_version: number
  payload: AllocationOutboxPayload
  event_hash: string
}>

export class AllocationOutboxValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AllocationOutboxValidationError"
  }
}

// ECMAScript relational comparison is a locale-independent lexicographic
// comparison of UTF-16 code units. Do not replace this with localeCompare.
export function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const SENSITIVE_KEYS = new Set([
  "idempotency_key",
  "idempotency_key_hash",
  "request_hash",
  "command_id",
  "token",
  "worker_id",
  "lease_owner",
  "lease_epoch",
  "payment",
  "payment_id",
  "raw_error",
  "subject_id",
])

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function assertPayloadSafe(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPayloadSafe(entry, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== "object") {
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      throw new AllocationOutboxValidationError(
        `Sensitive allocation outbox field is forbidden: ${path}.${key}`
      )
    }
    assertPayloadSafe(nested, `${path}.${key}`)
  }
}

export function validateAllocationOutboxPayload(
  payload: AllocationOutboxPayload
): void {
  assertPayloadSafe(payload)
  const bytes = Buffer.byteLength(canonicalJson(payload), "utf8")
  if (bytes > ALLOCATION_OUTBOX_MAX_PAYLOAD_BYTES) {
    throw new AllocationOutboxValidationError(
      "Allocation outbox payload exceeds 65536 bytes"
    )
  }
}

function eventNameFor(state: PurchaseAttemptState): string {
  switch (state) {
    case PurchaseAttemptState.QUOTA_HELD:
      return AllocationOutboxEventName.QUOTA_HELD
    case PurchaseAttemptState.QUOTA_REJECTED:
      return AllocationOutboxEventName.QUOTA_REJECTED
    case PurchaseAttemptState.QUOTA_COMMITTING:
      return AllocationOutboxEventName.QUOTA_COMMITTING
    case PurchaseAttemptState.QUOTA_CONSUMED:
      return AllocationOutboxEventName.QUOTA_CONSUMED
    case PurchaseAttemptState.QUOTA_RELEASED:
      return AllocationOutboxEventName.QUOTA_RELEASED
    case PurchaseAttemptState.QUOTA_EXPIRED:
      return AllocationOutboxEventName.QUOTA_EXPIRED
    default:
      throw new AllocationOutboxValidationError(
        `No allocation outbox event exists for state ${state}`
      )
  }
}

export function buildAllocationOutboxEnvelope(
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[],
  requestedItems: readonly Readonly<{
    campaign_item_id: string
    quantity: number
  }>[] = []
): AllocationOutboxEnvelope {
  if (attempt.state === PurchaseAttemptState.PENDING) {
    throw new AllocationOutboxValidationError(
      "Pending attempts do not produce allocation outbox events"
    )
  }
  if (
    (attempt.state === PurchaseAttemptState.QUOTA_COMMITTING ||
      attempt.state === PurchaseAttemptState.QUOTA_CONSUMED) &&
    !attempt.settlement_id
  ) {
    throw new AllocationOutboxValidationError(
      `${attempt.state} outbox facts require a settlement_id`
    )
  }
  if (
    attempt.state === PurchaseAttemptState.QUOTA_REJECTED &&
    !attempt.last_error_code
  ) {
    throw new AllocationOutboxValidationError(
      "quota_rejected outbox facts require a rejection code"
    )
  }
  const payload: AllocationOutboxPayload = {
    attempt_id: attempt.id,
    campaign_id: attempt.campaign_id,
    rules_version: attempt.rules_version,
    state: attempt.state,
    items: (holds.length > 0 ? holds : requestedItems)
      .map((item) => ({
        campaign_item_id: item.campaign_item_id,
        quantity: item.quantity,
      }))
      .sort((left, right) =>
        compareUtf16CodeUnits(left.campaign_item_id, right.campaign_item_id)
      ),
    ...(attempt.settlement_id
      ? { settlement_id: attempt.settlement_id }
      : {}),
    ...(attempt.state === PurchaseAttemptState.QUOTA_RELEASED
      ? {
          release_kind: attempt.settlement_id
            ? ("settlement_release" as const)
            : ("held_cancel" as const),
        }
      : {}),
    ...(attempt.state === PurchaseAttemptState.QUOTA_REJECTED &&
    attempt.last_error_code
      ? { rejection_code: attempt.last_error_code }
      : {}),
  }
  validateAllocationOutboxPayload(payload)
  const identity = {
    event_name: eventNameFor(attempt.state),
    schema_version: ALLOCATION_OUTBOX_SCHEMA_VERSION,
    aggregate_type: ALLOCATION_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: attempt.id,
    aggregate_version: attempt.version,
    payload,
  }
  return {
    ...identity,
    event_hash: createHash("sha256")
      .update(canonicalJson(identity), "utf8")
      .digest("hex"),
  }
}
