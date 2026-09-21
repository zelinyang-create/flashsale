import { createHash } from "crypto"
import { types as nodeTypes } from "util"
import { canonicalJson, compareUtf16CodeUnits } from "./allocation-outbox-envelope"

export const CHECKOUT_OUTBOX_AGGREGATE_TYPE = "checkout_execution" as const
export const CHECKOUT_OUTBOX_SCHEMA_VERSION = 1 as const
export const CHECKOUT_OUTBOX_MAX_PAYLOAD_BYTES = 65_536

export const CheckoutOutboxEventName = {
  PREPARED: "flash_sale.checkout.prepared.v1",
  COMMERCE_PENDING: "flash_sale.checkout.commerce_pending.v1",
  COMMERCE_SUCCEEDED: "flash_sale.checkout.commerce_succeeded.v1",
  COMMERCE_DEFINITIVE_FAILED:
    "flash_sale.checkout.commerce_definitive_failed.v1",
  COMMERCE_UNKNOWN: "flash_sale.checkout.commerce_unknown.v1",
  COMPLETED: "flash_sale.checkout.completed.v1",
  CANCELED: "flash_sale.checkout.canceled.v1",
} as const

export const CHECKOUT_OUTBOX_EVENT_NAMES = Object.freeze(
  Object.values(CheckoutOutboxEventName)
)
export type CheckoutOutboxEventNameValue =
  (typeof CHECKOUT_OUTBOX_EVENT_NAMES)[number]

export type CheckoutEventIdentity = Readonly<{
  event_name: CheckoutOutboxEventNameValue
  schema_version: typeof CHECKOUT_OUTBOX_SCHEMA_VERSION
  aggregate_type: typeof CHECKOUT_OUTBOX_AGGREGATE_TYPE
  aggregate_id: string
  aggregate_version: number
  payload: Readonly<Record<string, unknown>>
}>

export type CheckoutEventWireEnvelope = CheckoutEventIdentity &
  Readonly<{
    event_id: string
    event_hash: string
    occurred_at: string
  }>

export class CheckoutEventEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CheckoutEventEnvelopeError"
  }
}

const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,255}$/u
const SHA256 = /^[0-9a-f]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const EVENT_STATE = Object.freeze({
  [CheckoutOutboxEventName.PREPARED]: "prepared",
  [CheckoutOutboxEventName.COMMERCE_PENDING]: "commerce_pending",
  [CheckoutOutboxEventName.COMMERCE_SUCCEEDED]: "commerce_succeeded",
  [CheckoutOutboxEventName.COMMERCE_DEFINITIVE_FAILED]:
    "commerce_definitive_failed",
  [CheckoutOutboxEventName.COMMERCE_UNKNOWN]: "commerce_unknown",
  [CheckoutOutboxEventName.COMPLETED]: "completed",
  [CheckoutOutboxEventName.CANCELED]: "canceled",
} as const)

function error(message: string): never {
  throw new CheckoutEventEnvelopeError(message)
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function dataDescriptor(
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
    error(`${path} must be an enumerable data property`)
  }
}

function snapshotJson(
  value: unknown,
  path: string,
  active = new WeakSet<object>()
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) error(`${path} is not finite JSON`)
    return value
  }
  if (typeof value !== "object") error(`${path} is not JSON`)
  if (active.has(value)) error(`${path} must not be cyclic`)
  active.add(value)
  try {
    if (nodeTypes.isProxy(value)) error(`${path} must not be a Proxy`)
    const isArray = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key === "symbol")) {
      error(`${path} must not contain symbol properties`)
    }
    if (isArray) {
      if (prototype !== Array.prototype) error(`${path} has an invalid prototype`)
      dataDescriptor(descriptors.length, `${path}.length`, false)
      const length = descriptors.length.value
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        error(`${path}.length is invalid`)
      }
      if (keys.length !== (length as number) + 1) error(`${path} must be dense`)
      const result: unknown[] = []
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)]
        dataDescriptor(descriptor, `${path}[${index}]`, true)
        result.push(snapshotJson(descriptor.value, `${path}[${index}]`, active))
      }
      return Object.freeze(result)
    }
    if (prototype !== Object.prototype && prototype !== null) {
      error(`${path} has inherited properties`)
    }
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== "string") error(`${path} has a symbol property`)
      const descriptor = descriptors[key]
      dataDescriptor(descriptor, `${path}.${key}`, true)
      result[key] = snapshotJson(descriptor.value, `${path}.${key}`, active)
    }
    return Object.freeze(result)
  } catch (caught) {
    if (caught instanceof CheckoutEventEnvelopeError) throw caught
    return error(`${path} properties cannot be inspected`)
  } finally {
    active.delete(value)
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string
) {
  if (
    canonicalJson(Object.keys(value).sort(compareUtf16CodeUnits)) !==
    canonicalJson([...expected].sort(compareUtf16CodeUnits))
  ) {
    error(`${path} fields are invalid`)
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value)
}

function validatePayload(
  eventName: CheckoutOutboxEventNameValue,
  payload: Record<string, unknown>
) {
  const state = EVENT_STATE[eventName]
  const expected = [
    "execution_id",
    "attempt_id",
    "campaign_id",
    "rules_version",
    "state",
    "items",
    ...(state === "commerce_succeeded" || state === "completed"
      ? ["order_id"]
      : []),
    ...(state === "commerce_definitive_failed" ||
    state === "commerce_unknown" ||
    state === "canceled"
      ? ["error_code"]
      : []),
  ]
  exactKeys(payload, expected, "Checkout event payload")
  if (
    !identifier(payload.execution_id) ||
    !identifier(payload.attempt_id) ||
    !identifier(payload.campaign_id) ||
    payload.state !== state ||
    !Number.isSafeInteger(payload.rules_version) ||
    (payload.rules_version as number) < 1 ||
    !Array.isArray(payload.items) ||
    payload.items.length < 1 ||
    payload.items.length > 100
  ) {
    error("Checkout event payload is invalid")
  }
  let previous: string | null = null
  for (const item of payload.items) {
    if (!plain(item)) error("Checkout event item is invalid")
    exactKeys(
      item,
      ["campaign_item_id", "variant_id", "quantity"],
      "Checkout event item"
    )
    const sortKey = `${String(item.campaign_item_id)}\u0000${String(item.variant_id)}`
    if (
      !identifier(item.campaign_item_id) ||
      !identifier(item.variant_id) ||
      !Number.isSafeInteger(item.quantity) ||
      (item.quantity as number) < 1 ||
      (previous !== null && compareUtf16CodeUnits(previous, sortKey) >= 0)
    ) {
      error("Checkout event items must be unique and canonically sorted")
    }
    previous = sortKey
  }
  if (
    (state === "commerce_succeeded" || state === "completed") &&
    !identifier(payload.order_id)
  ) {
    error("Checkout event order identity is invalid")
  }
  if (
    (state === "commerce_definitive_failed" ||
      state === "commerce_unknown" ||
      state === "canceled") &&
    (typeof payload.error_code !== "string" || !ERROR_CODE.test(payload.error_code))
  ) {
    error("Checkout event error code is invalid")
  }
}

export function hashCheckoutEventIdentity(identity: CheckoutEventIdentity) {
  return createHash("sha256")
    .update(canonicalJson(identity), "utf8")
    .digest("hex")
}

export function normalizeCheckoutEventWireEnvelope(
  value: unknown
): CheckoutEventWireEnvelope {
  const snapshot = snapshotJson(value, "Checkout event")
  if (!plain(snapshot)) error("Checkout event must be an object")
  exactKeys(
    snapshot,
    [
      "event_id",
      "event_name",
      "schema_version",
      "aggregate_type",
      "aggregate_id",
      "aggregate_version",
      "event_hash",
      "occurred_at",
      "payload",
    ],
    "Checkout event"
  )
  if (
    !identifier(snapshot.event_id) ||
    !identifier(snapshot.aggregate_id) ||
    typeof snapshot.event_name !== "string" ||
    !CHECKOUT_OUTBOX_EVENT_NAMES.includes(
      snapshot.event_name as CheckoutOutboxEventNameValue
    ) ||
    snapshot.schema_version !== CHECKOUT_OUTBOX_SCHEMA_VERSION ||
    snapshot.aggregate_type !== CHECKOUT_OUTBOX_AGGREGATE_TYPE ||
    !Number.isSafeInteger(snapshot.aggregate_version) ||
    (snapshot.aggregate_version as number) < 1 ||
    typeof snapshot.event_hash !== "string" ||
    !SHA256.test(snapshot.event_hash) ||
    typeof snapshot.occurred_at !== "string" ||
    new Date(snapshot.occurred_at).toISOString() !== snapshot.occurred_at ||
    !plain(snapshot.payload)
  ) {
    error("Checkout event envelope is invalid")
  }
  if (
    Buffer.byteLength(canonicalJson(snapshot.payload), "utf8") >
    CHECKOUT_OUTBOX_MAX_PAYLOAD_BYTES
  ) {
    error("Checkout event payload is too large")
  }
  validatePayload(
    snapshot.event_name as CheckoutOutboxEventNameValue,
    snapshot.payload
  )
  const identity: CheckoutEventIdentity = {
    event_name: snapshot.event_name as CheckoutOutboxEventNameValue,
    schema_version: CHECKOUT_OUTBOX_SCHEMA_VERSION,
    aggregate_type: CHECKOUT_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: snapshot.aggregate_id,
    aggregate_version: snapshot.aggregate_version as number,
    payload: snapshot.payload,
  }
  if (hashCheckoutEventIdentity(identity) !== snapshot.event_hash) {
    error("Checkout event hash is invalid")
  }
  return snapshot as CheckoutEventWireEnvelope
}

export function validateCheckoutEventWireEnvelope(
  value: unknown
): asserts value is CheckoutEventWireEnvelope {
  normalizeCheckoutEventWireEnvelope(value)
}
