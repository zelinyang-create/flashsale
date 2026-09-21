import {
  ActivateCheckoutOutboxCommand,
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutOutboxMutationResult,
  CheckoutOutboxStore,
  ClaimCheckoutOutboxEventsCommand,
  ClaimCheckoutOutboxEventsResult,
  FailCheckoutOutboxEventCommand,
  MarkCheckoutOutboxPublishedCommand,
  RedriveCheckoutOutboxEventCommand,
} from "../domain"

const SHA256 = /^[0-9a-f]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/

function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    ) {
      return null
    }
    const result: Record<string, unknown> = {}
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null
      }
      result[field] = descriptor.value
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value
  )
}

function invalid(operation: string): never {
  throw new CheckoutCommandError(
    CheckoutCommandErrorCode.INVALID_COMMAND,
    `${operation} received an invalid command`
  )
}

export class ActivateCheckoutOutboxHandler {
  constructor(private readonly store: CheckoutOutboxStore) {}
  async execute(command: ActivateCheckoutOutboxCommand) {
    const normalized = exact(command, [])
    if (!normalized) invalid("activateCheckoutOutbox")
    return await this.store.activateOutboxRequired(
      normalized as ActivateCheckoutOutboxCommand
    )
  }
}

export class ClaimCheckoutOutboxEventsHandler {
  constructor(private readonly store: CheckoutOutboxStore) {}
  async execute(
    command: ClaimCheckoutOutboxEventsCommand
  ): Promise<ClaimCheckoutOutboxEventsResult> {
    const normalized = exact(command, [
      "worker_id",
      "limit",
      "lease_seconds",
      "max_attempts",
    ])
    if (
      !normalized ||
      !identifier(normalized.worker_id) ||
      !Number.isSafeInteger(normalized.limit) ||
      Number(normalized.limit) < 1 ||
      Number(normalized.limit) > 100 ||
      !Number.isSafeInteger(normalized.lease_seconds) ||
      Number(normalized.lease_seconds) < 1 ||
      Number(normalized.lease_seconds) > 3600 ||
      !Number.isSafeInteger(normalized.max_attempts) ||
      Number(normalized.max_attempts) < 1 ||
      Number(normalized.max_attempts) > 100
    ) invalid("claimCheckoutOutboxEvents")
    return await this.store.claimOutboxEvents(
      normalized as unknown as ClaimCheckoutOutboxEventsCommand
    )
  }
}

export class MarkCheckoutOutboxPublishedHandler {
  constructor(private readonly store: CheckoutOutboxStore) {}
  async execute(
    command: MarkCheckoutOutboxPublishedCommand
  ): Promise<CheckoutOutboxMutationResult> {
    const normalized = exact(command, ["event_id", "worker_id", "lease_epoch"])
    if (
      !normalized ||
      !identifier(normalized.event_id) ||
      !identifier(normalized.worker_id) ||
      !Number.isSafeInteger(normalized.lease_epoch) ||
      Number(normalized.lease_epoch) < 1
    ) invalid("markCheckoutOutboxPublished")
    return await this.store.markOutboxPublished(
      normalized as unknown as MarkCheckoutOutboxPublishedCommand
    )
  }
}

export class FailCheckoutOutboxEventHandler {
  constructor(private readonly store: CheckoutOutboxStore) {}
  async execute(
    command: FailCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    const normalized = exact(command, [
      "event_id",
      "worker_id",
      "lease_epoch",
      "retry_after_seconds",
      "error_code",
      "permanent",
    ])
    if (
      !normalized ||
      !identifier(normalized.event_id) ||
      !identifier(normalized.worker_id) ||
      !Number.isSafeInteger(normalized.lease_epoch) ||
      Number(normalized.lease_epoch) < 1 ||
      !Number.isSafeInteger(normalized.retry_after_seconds) ||
      Number(normalized.retry_after_seconds) < 1 ||
      Number(normalized.retry_after_seconds) > 86_400 ||
      typeof normalized.error_code !== "string" ||
      !ERROR_CODE.test(normalized.error_code) ||
      typeof normalized.permanent !== "boolean"
    ) invalid("failCheckoutOutboxEvent")
    return await this.store.failOutboxEvent(
      normalized as unknown as FailCheckoutOutboxEventCommand
    )
  }
}

export class RedriveCheckoutOutboxEventHandler {
  constructor(private readonly store: CheckoutOutboxStore) {}
  async execute(
    command: RedriveCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    const normalized = exact(command, ["event_id", "event_hash"])
    if (
      !normalized ||
      !identifier(normalized.event_id) ||
      typeof normalized.event_hash !== "string" ||
      !SHA256.test(normalized.event_hash)
    ) invalid("redriveCheckoutOutboxEvent")
    return await this.store.redriveOutboxEvent(
      normalized as unknown as RedriveCheckoutOutboxEventCommand
    )
  }
}
