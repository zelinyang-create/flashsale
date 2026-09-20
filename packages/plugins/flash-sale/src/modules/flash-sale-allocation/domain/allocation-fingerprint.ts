import { createHash } from "crypto"

import {
  AllocationItemInput,
  NormalizedAllocationItem,
  normalizeAllocationItems,
} from "./allocation-input"
import { AllocationDomainError, AllocationDomainErrorCode } from "./errors"

export type AllocationRequestFingerprintInput = Readonly<{
  schema_version: number
  campaign_id: string
  subject_id: string
  cart_id: string | null
  rules_version: number
  items: readonly AllocationItemInput[]
}>

type CanonicalAllocationRequest = Readonly<{
  schema_version: number
  campaign_id: string
  subject_id: string
  cart_id: string | null
  rules_version: number
  items: readonly NormalizedAllocationItem[]
}>

function assertNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.INVALID_FINGERPRINT_FIELD,
      `${field} must be a non-empty string`
    )
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  field: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AllocationDomainError(
      AllocationDomainErrorCode.INVALID_FINGERPRINT_FIELD,
      `${field} must be a positive safe integer`
    )
  }
}

/**
 * Produces the exact JSON-ready request representation hashed by
 * createCanonicalRequestFingerprint. It deliberately excludes idempotency
 * keys, admission tokens, and other credentials.
 */
export function canonicalizeAllocationRequest(
  input: AllocationRequestFingerprintInput
): CanonicalAllocationRequest {
  assertPositiveSafeInteger(input.schema_version, "schema_version")
  assertNonEmptyString(input.campaign_id, "campaign_id")
  assertNonEmptyString(input.subject_id, "subject_id")
  if (input.cart_id !== null) {
    assertNonEmptyString(input.cart_id, "cart_id")
  }
  assertPositiveSafeInteger(input.rules_version, "rules_version")

  return {
    schema_version: input.schema_version,
    campaign_id: input.campaign_id,
    subject_id: input.subject_id,
    cart_id: input.cart_id,
    rules_version: input.rules_version,
    items: normalizeAllocationItems(input.items),
  }
}

/**
 * Deterministic SHA-256 hash for the immutable business request. Normalized
 * item ordering means equivalent carts share a fingerprint regardless of the
 * caller's item order.
 */
export function createCanonicalRequestFingerprint(
  input: AllocationRequestFingerprintInput
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeAllocationRequest(input)), "utf8")
    .digest("hex")
}

export const createRequestFingerprint = createCanonicalRequestFingerprint
