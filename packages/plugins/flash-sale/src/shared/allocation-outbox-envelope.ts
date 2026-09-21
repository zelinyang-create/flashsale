import { createHash } from "crypto"
import { types as nodeTypes } from "util"

export const ALLOCATION_OUTBOX_AGGREGATE_TYPE = "purchase_attempt" as const
export const ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE =
  "capacity_repair_apply" as const
export const ALLOCATION_OUTBOX_SCHEMA_VERSION = 1 as const
export const ALLOCATION_OUTBOX_MAX_PAYLOAD_BYTES = 65_536

export const AllocationOutboxEventName = {
  QUOTA_HELD: "flash_sale.quota.held.v1",
  QUOTA_REJECTED: "flash_sale.quota.rejected.v1",
  QUOTA_COMMITTING: "flash_sale.quota.settlement_started.v1",
  QUOTA_CONSUMED: "flash_sale.quota.consumed.v1",
  QUOTA_RELEASED: "flash_sale.quota.released.v1",
  QUOTA_EXPIRED: "flash_sale.quota.expired.v1",
  CAPACITY_REPAIR_APPLIED: "flash_sale.capacity_repair.applied.v1",
} as const

export const ALLOCATION_OUTBOX_EVENT_NAMES = Object.freeze(
  Object.values(AllocationOutboxEventName)
)

export type AllocationOutboxEventNameValue =
  (typeof ALLOCATION_OUTBOX_EVENT_NAMES)[number]

export type AllocationEventIdentity = Readonly<{
  event_name: AllocationOutboxEventNameValue
  schema_version: typeof ALLOCATION_OUTBOX_SCHEMA_VERSION
  aggregate_type:
    | typeof ALLOCATION_OUTBOX_AGGREGATE_TYPE
    | typeof ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE
  aggregate_id: string
  aggregate_version: number
  payload: Readonly<Record<string, unknown>>
}>

export type AllocationEventWireEnvelope = AllocationEventIdentity &
  Readonly<{
    event_id: string
    event_hash: string
    occurred_at: string
  }>

export class AllocationEventEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AllocationEventEnvelopeError"
  }
}

export function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort(compareUtf16CodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

export function hashAllocationEventIdentity(
  identity: AllocationEventIdentity
): string {
  return createHash("sha256")
    .update(canonicalJson(identity), "utf8")
    .digest("hex")
}

const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,255}$/u
const SHA256 = /^[0-9a-f]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/
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

const EVENT_STATE = Object.freeze({
  [AllocationOutboxEventName.QUOTA_HELD]: "quota_held",
  [AllocationOutboxEventName.QUOTA_REJECTED]: "quota_rejected",
  [AllocationOutboxEventName.QUOTA_COMMITTING]: "quota_committing",
  [AllocationOutboxEventName.QUOTA_CONSUMED]: "quota_consumed",
  [AllocationOutboxEventName.QUOTA_RELEASED]: "quota_released",
  [AllocationOutboxEventName.QUOTA_EXPIRED]: "quota_expired",
} as const)

function validateRepairAppliedPayload(payload: Record<string, unknown>): void {
  assertExactKeys(
    payload,
    [
      "apply_run_id",
      "plan_run_id",
      "campaign_id",
      "result_digest",
      "action_ids",
      "ticket",
    ],
    "Capacity repair event payload"
  )
  assertSafeJson(payload, "payload")
  if (
    typeof payload.apply_run_id !== "string" ||
    !IDENTIFIER.test(payload.apply_run_id) ||
    typeof payload.plan_run_id !== "string" ||
    !IDENTIFIER.test(payload.plan_run_id) ||
    typeof payload.campaign_id !== "string" ||
    !IDENTIFIER.test(payload.campaign_id) ||
    typeof payload.result_digest !== "string" ||
    !SHA256.test(payload.result_digest) ||
    typeof payload.ticket !== "string" ||
    !IDENTIFIER.test(payload.ticket) ||
    !Array.isArray(payload.action_ids) ||
    payload.action_ids.length < 1 ||
    payload.action_ids.length > 100
  ) {
    throw new AllocationEventEnvelopeError(
      "Capacity repair event payload is invalid"
    )
  }
  let previous: string | null = null
  for (const actionId of payload.action_ids) {
    if (
      typeof actionId !== "string" ||
      !IDENTIFIER.test(actionId) ||
      (previous !== null && compareUtf16CodeUnits(previous, actionId) >= 0)
    ) {
      throw new AllocationEventEnvelopeError(
        "Capacity repair action ids must be unique and canonically sorted"
      )
    }
    previous = actionId
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function envelopeError(message: string): never {
  throw new AllocationEventEnvelopeError(message)
}

function snapshotDescriptors(
  value: object,
  path: string
): {
  isArray: boolean
  prototype: object | null
  descriptors: Record<PropertyKey, PropertyDescriptor>
} {
  try {
    // A Proxy can change its keys, descriptors, prototype, or returned values
    // between observations. It is not an admissible wire representation.
    if (nodeTypes.isProxy(value)) {
      return envelopeError(`${path} must not be a Proxy`)
    }
    const isArray = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >
    return { isArray, prototype, descriptors }
  } catch (error) {
    if (error instanceof AllocationEventEnvelopeError) throw error
    return envelopeError(`${path} properties cannot be inspected`)
  }
}

function assertDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  path: string,
  enumerable: boolean
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (
    !descriptor ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== enumerable
  ) {
    envelopeError(`${path} must contain enumerable data properties`)
  }
}

function snapshotJson(
  value: unknown,
  path: string,
  active = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return envelopeError(`${path} is not finite JSON`)
    }
    return value
  }
  if (typeof value !== "object") {
    return envelopeError(`${path} is not JSON`)
  }
  if (active.has(value)) {
    return envelopeError(`${path} must not be cyclic`)
  }

  active.add(value)
  try {
    const { isArray, prototype, descriptors } = snapshotDescriptors(value, path)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key === "symbol")) {
      return envelopeError(`${path} must not contain symbol properties`)
    }

    if (isArray) {
      if (prototype !== Array.prototype) {
        return envelopeError(`${path} must not contain inherited properties`)
      }
      const lengthDescriptor = descriptors.length
      assertDataDescriptor(lengthDescriptor, `${path}.length`, false)
      const length = lengthDescriptor.value
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        return envelopeError(`${path}.length is invalid`)
      }
      const arrayLength = length as number
      if (
        keys.length !== arrayLength + 1 ||
        keys.some((key) => {
          if (key === "length") return false
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
            return true
          }
          const index = Number(key)
          return !Number.isSafeInteger(index) || index >= arrayLength
        })
      ) {
        return envelopeError(`${path} must be a dense JSON array`)
      }
      const snapshot: unknown[] = []
      for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = descriptors[String(index)]
        assertDataDescriptor(descriptor, `${path}[${index}]`, true)
        snapshot.push(
          snapshotJson(descriptor.value, `${path}[${index}]`, active)
        )
      }
      return Object.freeze(snapshot)
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return envelopeError(`${path} must not contain inherited properties`)
    }
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== "string") {
        return envelopeError(`${path} must not contain symbol properties`)
      }
      const descriptor = descriptors[key]
      assertDataDescriptor(descriptor, `${path}.${key}`, true)
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotJson(descriptor.value, `${path}.${key}`, active),
      })
    }
    return Object.freeze(snapshot)
  } finally {
    active.delete(value)
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string
): void {
  const keys = Object.keys(value).sort(compareUtf16CodeUnits)
  const wanted = [...expected].sort(compareUtf16CodeUnits)
  if (canonicalJson(keys) !== canonicalJson(wanted)) {
    throw new AllocationEventEnvelopeError(`${path} fields are invalid`)
  }
}

function assertSafeJson(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AllocationEventEnvelopeError(`${path} is not finite JSON`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`))
    return
  }
  if (!plainRecord(value)) {
    throw new AllocationEventEnvelopeError(`${path} is not plain JSON`)
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      throw new AllocationEventEnvelopeError(`${path}.${key} is sensitive`)
    }
    assertSafeJson(nested, `${path}.${key}`)
  }
}

function validateAllocationEventPayload(
  eventName: AllocationOutboxEventNameValue,
  payload: Record<string, unknown>
): void {
  if (eventName === AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED) {
    validateRepairAppliedPayload(payload)
    return
  }
  const state = EVENT_STATE[eventName]
  const fields = [
    "attempt_id",
    "campaign_id",
    "rules_version",
    "state",
    "items",
    ...(state === "quota_committing" || state === "quota_consumed"
      ? ["settlement_id"]
      : []),
    ...(state === "quota_released" ? ["release_kind"] : []),
    ...(state === "quota_rejected" ? ["rejection_code"] : []),
  ]
  assertExactKeys(payload, fields, "Allocation event payload")
  assertSafeJson(payload, "payload")
  if (
    typeof payload.attempt_id !== "string" ||
    !IDENTIFIER.test(payload.attempt_id) ||
    typeof payload.campaign_id !== "string" ||
    !IDENTIFIER.test(payload.campaign_id) ||
    payload.state !== state ||
    !Number.isSafeInteger(payload.rules_version) ||
    (payload.rules_version as number) < 1 ||
    !Array.isArray(payload.items) ||
    payload.items.length === 0
  ) {
    throw new AllocationEventEnvelopeError(
      "Allocation event payload is invalid"
    )
  }
  let previousItemId: string | null = null
  for (const item of payload.items) {
    if (!plainRecord(item)) {
      throw new AllocationEventEnvelopeError("Allocation event item is invalid")
    }
    assertExactKeys(
      item,
      ["campaign_item_id", "quantity"],
      "Allocation event item"
    )
    if (
      typeof item.campaign_item_id !== "string" ||
      !IDENTIFIER.test(item.campaign_item_id) ||
      !Number.isSafeInteger(item.quantity) ||
      (item.quantity as number) < 1 ||
      (previousItemId !== null &&
        compareUtf16CodeUnits(previousItemId, item.campaign_item_id) >= 0)
    ) {
      throw new AllocationEventEnvelopeError(
        "Allocation event items must be unique and canonically sorted"
      )
    }
    previousItemId = item.campaign_item_id
  }
  if (
    (state === "quota_committing" || state === "quota_consumed") &&
    (typeof payload.settlement_id !== "string" ||
      !IDENTIFIER.test(payload.settlement_id))
  ) {
    throw new AllocationEventEnvelopeError("Settlement identity is invalid")
  }
  if (
    state === "quota_released" &&
    payload.release_kind !== "held_cancel" &&
    payload.release_kind !== "settlement_release"
  ) {
    throw new AllocationEventEnvelopeError("Release kind is invalid")
  }
  if (
    state === "quota_rejected" &&
    (typeof payload.rejection_code !== "string" ||
      !ERROR_CODE.test(payload.rejection_code))
  ) {
    throw new AllocationEventEnvelopeError("Rejection code is invalid")
  }
}

export function normalizeAllocationEventWireEnvelope(
  value: unknown
): AllocationEventWireEnvelope {
  const snapshot = snapshotJson(value, "Allocation event")
  if (!plainRecord(snapshot)) {
    throw new AllocationEventEnvelopeError("Allocation event must be an object")
  }
  const expected = [
    "event_id",
    "event_name",
    "schema_version",
    "aggregate_type",
    "aggregate_id",
    "aggregate_version",
    "event_hash",
    "occurred_at",
    "payload",
  ]
  assertExactKeys(snapshot, expected, "Allocation event")
  if (
    typeof snapshot.event_id !== "string" ||
    !IDENTIFIER.test(snapshot.event_id) ||
    typeof snapshot.aggregate_id !== "string" ||
    !IDENTIFIER.test(snapshot.aggregate_id)
  ) {
    throw new AllocationEventEnvelopeError(
      "Allocation event identity is invalid"
    )
  }
  if (
    typeof snapshot.event_name !== "string" ||
    !ALLOCATION_OUTBOX_EVENT_NAMES.includes(
      snapshot.event_name as AllocationOutboxEventNameValue
    ) ||
    snapshot.schema_version !== ALLOCATION_OUTBOX_SCHEMA_VERSION ||
    snapshot.aggregate_type !==
      (snapshot.event_name === AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED
        ? ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE
        : ALLOCATION_OUTBOX_AGGREGATE_TYPE) ||
    !Number.isSafeInteger(snapshot.aggregate_version) ||
    (snapshot.event_name === AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED
      ? snapshot.aggregate_version !== 1
      : (snapshot.aggregate_version as number) < 2) ||
    typeof snapshot.event_hash !== "string" ||
    !SHA256.test(snapshot.event_hash) ||
    typeof snapshot.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(snapshot.occurred_at)) ||
    new Date(snapshot.occurred_at).toISOString() !== snapshot.occurred_at ||
    !plainRecord(snapshot.payload)
  ) {
    throw new AllocationEventEnvelopeError(
      "Allocation event envelope is invalid"
    )
  }
  if (
    Buffer.byteLength(canonicalJson(snapshot.payload), "utf8") >
    ALLOCATION_OUTBOX_MAX_PAYLOAD_BYTES
  ) {
    throw new AllocationEventEnvelopeError(
      "Allocation event payload is too large"
    )
  }
  validateAllocationEventPayload(
    snapshot.event_name as AllocationOutboxEventNameValue,
    snapshot.payload
  )
  const identity: AllocationEventIdentity = {
    event_name: snapshot.event_name as AllocationOutboxEventNameValue,
    schema_version: ALLOCATION_OUTBOX_SCHEMA_VERSION,
    aggregate_type:
      snapshot.aggregate_type as AllocationEventIdentity["aggregate_type"],
    aggregate_id: snapshot.aggregate_id,
    aggregate_version: snapshot.aggregate_version as number,
    payload: snapshot.payload,
  }
  if (hashAllocationEventIdentity(identity) !== snapshot.event_hash) {
    throw new AllocationEventEnvelopeError("Allocation event hash is invalid")
  }
  return snapshot as AllocationEventWireEnvelope
}

export function validateAllocationEventWireEnvelope(
  value: unknown
): asserts value is AllocationEventWireEnvelope {
  normalizeAllocationEventWireEnvelope(value)
}
