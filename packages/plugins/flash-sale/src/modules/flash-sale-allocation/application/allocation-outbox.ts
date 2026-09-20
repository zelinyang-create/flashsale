import {
  ActivateAllocationOutboxCommand,
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationOutboxMutationResult,
  AllocationOutboxStore,
  ClaimAllocationOutboxEventsCommand,
  ClaimAllocationOutboxEventsResult,
  FailAllocationOutboxEventCommand,
  MarkAllocationOutboxPublishedCommand,
  RedriveAllocationOutboxEventCommand,
} from "./contracts"

const SHA256 = /^[0-9a-f]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const IDENTIFIER_MAX = 255

function normalizeExactRecord(
  value: unknown,
  fields: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
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

    // Snapshot data descriptors rather than reading properties. This rejects
    // accessors and prevents a getter/proxy from changing a command between
    // validation and the store call.
    const normalized: Record<string, unknown> = {}
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        "get" in descriptor ||
        "set" in descriptor
      ) {
        return null
      }
      normalized[field] = descriptor.value
    }
    return Object.freeze(normalized)
  } catch {
    return null
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX &&
    value.trim() === value
  )
}

function invalid(operation: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.INVALID_COMMAND,
    `${operation} received an invalid command`
  )
}

export class ActivateAllocationOutboxHandler {
  constructor(private readonly store: AllocationOutboxStore) {}

  async execute(command: ActivateAllocationOutboxCommand) {
    const normalized = normalizeExactRecord(command, [])
    if (!normalized) invalid("activateAllocationOutbox")
    return await this.store.activateOutboxRequired(
      normalized as ActivateAllocationOutboxCommand
    )
  }
}

export class ClaimAllocationOutboxEventsHandler {
  constructor(private readonly store: AllocationOutboxStore) {}

  async execute(
    command: ClaimAllocationOutboxEventsCommand
  ): Promise<ClaimAllocationOutboxEventsResult> {
    const normalized = normalizeExactRecord(command, [
      "worker_id",
      "limit",
      "lease_seconds",
      "max_attempts",
    ])
    if (
      !normalized ||
      !identifier(normalized.worker_id) ||
      !Number.isSafeInteger(normalized.limit) ||
      (normalized.limit as number) < 1 ||
      (normalized.limit as number) > 100 ||
      !Number.isSafeInteger(normalized.lease_seconds) ||
      (normalized.lease_seconds as number) < 1 ||
      (normalized.lease_seconds as number) > 3600 ||
      !Number.isSafeInteger(normalized.max_attempts) ||
      (normalized.max_attempts as number) < 1 ||
      (normalized.max_attempts as number) > 100
    ) {
      invalid("claimAllocationOutboxEvents")
    }
    return await this.store.claimOutboxEvents(
      normalized as unknown as ClaimAllocationOutboxEventsCommand
    )
  }
}

export class MarkAllocationOutboxPublishedHandler {
  constructor(private readonly store: AllocationOutboxStore) {}

  async execute(
    command: MarkAllocationOutboxPublishedCommand
  ): Promise<AllocationOutboxMutationResult> {
    const normalized = normalizeExactRecord(command, [
      "event_id",
      "worker_id",
      "lease_epoch",
    ])
    if (
      !normalized ||
      !identifier(normalized.event_id) ||
      !identifier(normalized.worker_id) ||
      !Number.isSafeInteger(normalized.lease_epoch) ||
      (normalized.lease_epoch as number) < 1
    ) {
      invalid("markAllocationOutboxPublished")
    }
    return await this.store.markOutboxPublished(
      normalized as unknown as MarkAllocationOutboxPublishedCommand
    )
  }
}

export class FailAllocationOutboxEventHandler {
  constructor(private readonly store: AllocationOutboxStore) {}

  async execute(
    command: FailAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    const normalized = normalizeExactRecord(command, [
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
      (normalized.lease_epoch as number) < 1 ||
      !Number.isSafeInteger(normalized.retry_after_seconds) ||
      (normalized.retry_after_seconds as number) < 1 ||
      (normalized.retry_after_seconds as number) > 86_400 ||
      typeof normalized.error_code !== "string" ||
      !ERROR_CODE.test(normalized.error_code) ||
      typeof normalized.permanent !== "boolean"
    ) {
      invalid("failAllocationOutboxEvent")
    }
    return await this.store.failOutboxEvent(
      normalized as unknown as FailAllocationOutboxEventCommand
    )
  }
}

export class RedriveAllocationOutboxEventHandler {
  constructor(private readonly store: AllocationOutboxStore) {}

  async execute(
    command: RedriveAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    const normalized = normalizeExactRecord(command, ["event_id", "event_hash"])
    if (
      !normalized ||
      !identifier(normalized.event_id) ||
      typeof normalized.event_hash !== "string" ||
      !SHA256.test(normalized.event_hash)
    ) {
      invalid("redriveAllocationOutboxEvent")
    }
    return await this.store.redriveOutboxEvent(
      normalized as unknown as RedriveAllocationOutboxEventCommand
    )
  }
}
