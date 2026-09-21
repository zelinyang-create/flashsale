import { createHash } from "crypto"
import { CapacityMovementBucket, CapacityMovementKind } from "../../../types"
import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"

const IDENTIFIER_MAX = 255
const POSITIVE_DECIMAL = /^(?:0*[1-9][0-9]*)$/
const SHA256 = /^[0-9a-f]{64}$/

export type CapacityMovementFingerprintInput = Readonly<{
  schema_version: 1
  capacity_id: string
  attempt_id: string
  campaign_id: string
  subject_id: string
  campaign_item_id: string
  transition_version: number
  kind: CapacityMovementKind
  from_bucket: CapacityMovementBucket
  to_bucket: CapacityMovementBucket
  quantity: string
}>

export type CapacityMovementInput = CapacityMovementFingerprintInput &
  Readonly<{ fence_token: string }>

/**
 * The persisted token is a content fingerprint of the immutable movement
 * tuple. It is not a worker lease/fencing epoch and callers may not supply an
 * unrelated SHA-256 value.
 */
export type CapacityMovementFingerprintToken = string

const ROUTES: Readonly<
  Record<
    CapacityMovementKind,
    readonly [CapacityMovementBucket, CapacityMovementBucket]
  >
> = {
  [CapacityMovementKind.HOLD]: [
    CapacityMovementBucket.AVAILABLE,
    CapacityMovementBucket.HELD,
  ],
  [CapacityMovementKind.CONSUME]: [
    CapacityMovementBucket.HELD,
    CapacityMovementBucket.CONSUMED,
  ],
  [CapacityMovementKind.RELEASE]: [
    CapacityMovementBucket.HELD,
    CapacityMovementBucket.AVAILABLE,
  ],
  [CapacityMovementKind.EXPIRE]: [
    CapacityMovementBucket.HELD,
    CapacityMovementBucket.AVAILABLE,
  ],
}

function fail(message: string): never {
  throw new AllocationDomainError(
    AllocationDomainErrorCode.INVALID_CAPACITY_MOVEMENT,
    message
  )
}

function normalizedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > IDENTIFIER_MAX ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${field} must be a bounded, trimmed identifier`)
  }
  return value
}

/**
 * Produces the immutable ledger tuple. Quantity remains a decimal string so a
 * PostgreSQL bigint/numeric value is never rounded through JavaScript Number.
 */
export function normalizeCapacityMovementFingerprint(
  input: CapacityMovementFingerprintInput
): CapacityMovementFingerprintInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("movement must be an object")
  }
  if (input.schema_version !== 1) fail("schema_version must be 1")
  if (
    !Number.isSafeInteger(input.transition_version) ||
    input.transition_version < 1
  ) {
    fail("transition_version must be a positive safe integer")
  }
  if (
    typeof input.quantity !== "string" ||
    !POSITIVE_DECIMAL.test(input.quantity)
  ) {
    fail("quantity must be a positive decimal string")
  }
  const route = ROUTES[input.kind]
  if (
    !route ||
    route[0] !== input.from_bucket ||
    route[1] !== input.to_bucket
  ) {
    fail("movement kind and bucket route do not match")
  }
  return Object.freeze({
    schema_version: 1,
    capacity_id: normalizedIdentifier(input.capacity_id, "capacity_id"),
    attempt_id: normalizedIdentifier(input.attempt_id, "attempt_id"),
    campaign_id: normalizedIdentifier(input.campaign_id, "campaign_id"),
    subject_id: normalizedIdentifier(input.subject_id, "subject_id"),
    campaign_item_id: normalizedIdentifier(
      input.campaign_item_id,
      "campaign_item_id"
    ),
    transition_version: input.transition_version,
    kind: input.kind,
    from_bucket: input.from_bucket,
    to_bucket: input.to_bucket,
    quantity: BigInt(input.quantity).toString(10),
  })
}

export function createCapacityMovementFingerprint(
  input: CapacityMovementFingerprintInput
): CapacityMovementFingerprintToken {
  const normalized = normalizeCapacityMovementFingerprint(input)
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex")
}

export function validateCapacityMovement(
  input: CapacityMovementInput
): CapacityMovementInput {
  const normalized = normalizeCapacityMovementFingerprint(input)
  if (
    typeof input.fence_token !== "string" ||
    !SHA256.test(input.fence_token)
  ) {
    fail("fence_token must be a lowercase SHA-256 digest")
  }
  const expected = createCapacityMovementFingerprint(normalized)
  if (input.fence_token !== expected) {
    fail("fence_token must equal the immutable movement tuple fingerprint")
  }
  return Object.freeze({ ...normalized, fence_token: input.fence_token })
}
