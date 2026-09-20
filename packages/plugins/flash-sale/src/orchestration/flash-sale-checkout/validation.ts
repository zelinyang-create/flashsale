import {
  FlashSaleCheckoutItem,
  FlashSaleCheckoutOrchestrationError,
  FlashSaleCheckoutOrchestrationErrorCode,
  ServerCanonicalFlashSaleCheckoutCommand,
} from "./contracts"

const HASH = /^[0-9a-f]{64}$/
const MAX_IDENTIFIER_LENGTH = 255
const MAX_SECONDS = 86400
const MAX_COMMERCE_LEASE_SECONDS = 120
const COMMAND_FIELDS = [
  "campaign_id",
  "subject_id",
  "cart_id",
  "command_id",
  "rules_version",
  "items",
] as const

function invalid(message: string): never {
  throw new FlashSaleCheckoutOrchestrationError(
    FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND,
    message
  )
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
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

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    invalid(`${field} must be a non-empty bounded string`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`)
  }
  return Number(value)
}

function boundedSeconds(value: unknown, field: string): number {
  const seconds = positiveInteger(value, field)
  if (seconds > MAX_SECONDS) {
    invalid(`${field} must not exceed ${MAX_SECONDS}`)
  }
  return seconds
}

function items(value: unknown): readonly FlashSaleCheckoutItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    invalid("items must contain between 1 and 100 entries")
  }
  const normalized = value.map((item, index) => {
    exactRecord(
      item,
      ["campaign_item_id", "variant_id", "quantity"],
      `items[${index}]`
    )
    return {
      campaign_item_id: identifier(
        item.campaign_item_id,
        `items[${index}].campaign_item_id`
      ),
      variant_id: identifier(item.variant_id, `items[${index}].variant_id`),
      quantity: positiveInteger(item.quantity, `items[${index}].quantity`),
    }
  })
  if (
    new Set(normalized.map((item) => item.campaign_item_id)).size !==
      normalized.length ||
    new Set(normalized.map((item) => item.variant_id)).size !==
      normalized.length
  ) {
    invalid("items must have unique campaign_item_id and variant_id values")
  }
  return normalized.sort((left, right) =>
    left.variant_id.localeCompare(right.variant_id)
  )
}

export function prepareServerCanonicalFlashSaleCheckoutCommand(
  value: ServerCanonicalFlashSaleCheckoutCommand
): ServerCanonicalFlashSaleCheckoutCommand {
  exactRecord(value, COMMAND_FIELDS, "flash-sale checkout command")
  if (typeof value.command_id !== "string" || !HASH.test(value.command_id)) {
    invalid("command_id must be a server-derived lowercase SHA-256 digest")
  }
  return {
    campaign_id: identifier(value.campaign_id, "campaign_id"),
    subject_id: identifier(value.subject_id, "subject_id"),
    cart_id: identifier(value.cart_id, "cart_id"),
    command_id: value.command_id,
    rules_version: positiveInteger(value.rules_version, "rules_version"),
    items: items(value.items),
  }
}

export function prepareOrchestratorSeconds(
  value: unknown,
  field: string
): number {
  return boundedSeconds(value, field)
}

export function prepareCommerceLeaseSeconds(value: unknown): number {
  const seconds = positiveInteger(value, "lease_seconds")
  if (seconds > MAX_COMMERCE_LEASE_SECONDS) {
    invalid(`lease_seconds must not exceed ${MAX_COMMERCE_LEASE_SECONDS}`)
  }
  return seconds
}

export function prepareWorkerId(value: unknown): string {
  return identifier(value, "worker_id")
}
