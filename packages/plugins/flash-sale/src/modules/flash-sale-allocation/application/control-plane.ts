import { createHash } from "crypto"

import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationControlResult,
  AllocationControlStore,
  AllocationCampaignFenceResult,
  FenceAndCloseCampaignAllocationCommand,
  ProvisionAllocationCommand,
  ProvisionAllocationPersistenceInput,
  ProvisionAllocationItem,
  TransitionAllocationCommand,
} from "./contracts"

const SHA256 = /^[0-9a-f]{64}$/
const POSTGRES_INTEGER_MAX = 2_147_483_647
const CANONICAL_UTC_INSTANT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PROVISION_FIELDS = new Set([
  "campaign_id",
  "rules_version",
  "configuration_hash",
  "starts_at",
  "ends_at",
  "hold_ttl_seconds",
  "per_subject_limit",
  "items",
])
const ITEM_FIELDS = new Set(["campaign_item_id", "quota"])
const TRANSITION_FIELDS = new Set([
  "policy_id",
  "expected_rules_version",
  "expected_version",
])
const FENCE_FIELDS = new Set([
  "campaign_id",
  "disposition",
  "campaign_version",
  "rules_version",
])

function isExactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length !== allowed.size) {
    return false
  }
  const names = new Set<string>()
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return false
    }
    names.add(key)
  }
  return [...required].every((field) => names.has(field))
}

function invalid(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.INVALID_COMMAND,
    message
  )
}

function assertNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || !value) {
    invalid(`${field} must be a non-empty string`)
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    invalid(`${field} must be a positive safe integer`)
  }
}

function normalizeIsoInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !CANONICAL_UTC_INSTANT.test(value)) {
    invalid(`${field} must be an ISO-8601 UTC instant`)
  }
  const year = Number(value.slice(0, 4))
  if (year < 1 || year > 9999) {
    invalid(`${field} year must be between 0001 and 9999`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(`${field} must use canonical ISO-8601 UTC format`)
  }
  return value
}

export type AllocationConfigurationSnapshot = Readonly<{
  campaign_id: string
  rules_version: number
  starts_at: string
  ends_at: string
  hold_ttl_seconds: number
  per_subject_limit: number
  items: readonly ProvisionAllocationItem[]
}>

export function createAllocationConfigurationHash(
  snapshot: AllocationConfigurationSnapshot
): string {
  const items = snapshot.items.map((item) => ({
    campaign_item_id: item.campaign_item_id,
    quota: item.quota,
  }))
  items.sort((left, right) => {
    if (left.campaign_item_id < right.campaign_item_id) {
      return -1
    }
    if (left.campaign_item_id > right.campaign_item_id) {
      return 1
    }
    return 0
  })
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema_version: 1,
        campaign_id: snapshot.campaign_id,
        rules_version: snapshot.rules_version,
        starts_at: snapshot.starts_at,
        ends_at: snapshot.ends_at,
        hold_ttl_seconds: snapshot.hold_ttl_seconds,
        per_subject_limit: snapshot.per_subject_limit,
        items,
      }),
      "utf8"
    )
    .digest("hex")
}

export function prepareProvisionCommand(
  command: ProvisionAllocationCommand
): ProvisionAllocationPersistenceInput {
  if (
    !isExactRecord(command, PROVISION_FIELDS) ||
    !Array.isArray(command.items)
  ) {
    invalid("provisionAllocation requires an exact snapshot command")
  }
  assertNonEmptyString(command.campaign_id, "campaign_id")
  assertPositiveSafeInteger(
    command.rules_version,
    "rules_version",
    POSTGRES_INTEGER_MAX
  )
  if (
    typeof command.configuration_hash !== "string" ||
    !SHA256.test(command.configuration_hash)
  ) {
    invalid("configuration_hash must be a lowercase SHA-256 digest")
  }
  const startsAt = normalizeIsoInstant(command.starts_at, "starts_at")
  const endsAt = normalizeIsoInstant(command.ends_at, "ends_at")
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    invalid("ends_at must be later than starts_at")
  }
  assertPositiveSafeInteger(command.hold_ttl_seconds, "hold_ttl_seconds", 86400)
  assertPositiveSafeInteger(
    command.per_subject_limit,
    "per_subject_limit",
    POSTGRES_INTEGER_MAX
  )
  if (command.items.length === 0) {
    invalid("items must contain at least one capacity snapshot")
  }
  const seen = new Set<string>()
  const items = command.items.map((item) => {
    if (!isExactRecord(item, ITEM_FIELDS)) {
      invalid("allocation item must contain exactly campaign_item_id and quota")
    }
    assertNonEmptyString(item.campaign_item_id, "campaign_item_id")
    assertPositiveSafeInteger(item.quota, "quota")
    if (seen.has(item.campaign_item_id)) {
      invalid(`duplicate campaign_item_id: ${item.campaign_item_id}`)
    }
    seen.add(item.campaign_item_id)
    return { campaign_item_id: item.campaign_item_id, quota: item.quota }
  })
  items.sort((left, right) => {
    if (left.campaign_item_id < right.campaign_item_id) {
      return -1
    }
    if (left.campaign_item_id > right.campaign_item_id) {
      return 1
    }
    return 0
  })
  const snapshot = {
    campaign_id: command.campaign_id,
    rules_version: command.rules_version,
    starts_at: startsAt,
    ends_at: endsAt,
    hold_ttl_seconds: command.hold_ttl_seconds,
    per_subject_limit: command.per_subject_limit,
    items,
  }
  if (
    createAllocationConfigurationHash(snapshot) !== command.configuration_hash
  ) {
    throw new AllocationCommandError(
      AllocationCommandErrorCode.INVALID_COMMAND,
      "configuration_hash does not match the canonical allocation snapshot"
    )
  }
  return { ...snapshot, configuration_hash: command.configuration_hash }
}

export function prepareTransitionCommand(
  command: TransitionAllocationCommand,
  operation: string
): TransitionAllocationCommand {
  if (!isExactRecord(command, TRANSITION_FIELDS)) {
    invalid(`${operation} requires an exact transition command`)
  }
  assertNonEmptyString(command.policy_id, "policy_id")
  assertPositiveSafeInteger(
    command.expected_rules_version,
    "expected_rules_version",
    POSTGRES_INTEGER_MAX
  )
  assertPositiveSafeInteger(
    command.expected_version,
    "expected_version",
    POSTGRES_INTEGER_MAX
  )
  return {
    policy_id: command.policy_id,
    expected_rules_version: command.expected_rules_version,
    expected_version: command.expected_version,
  }
}

export function prepareFenceAndCloseCommand(
  command: FenceAndCloseCampaignAllocationCommand
): FenceAndCloseCampaignAllocationCommand {
  if (!isExactRecord(command, FENCE_FIELDS)) {
    invalid("fenceAndCloseCampaignAllocation requires an exact command")
  }
  assertNonEmptyString(command.campaign_id, "campaign_id")
  if (command.disposition !== "cancelled" && command.disposition !== "ended") {
    invalid("disposition must be cancelled or ended")
  }
  assertPositiveSafeInteger(
    command.campaign_version,
    "campaign_version",
    POSTGRES_INTEGER_MAX
  )
  assertPositiveSafeInteger(
    command.rules_version,
    "rules_version",
    POSTGRES_INTEGER_MAX
  )
  return {
    campaign_id: command.campaign_id,
    disposition: command.disposition,
    campaign_version: command.campaign_version,
    rules_version: command.rules_version,
  }
}

export class ProvisionAllocationHandler {
  constructor(private readonly store: AllocationControlStore) {}

  async execute(
    command: ProvisionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.store.provisionAllocation(
      prepareProvisionCommand(command)
    )
  }
}

export class OpenAllocationHandler {
  constructor(private readonly store: AllocationControlStore) {}

  async execute(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.store.openAllocation(
      prepareTransitionCommand(command, "openAllocation")
    )
  }
}

export class CloseAllocationHandler {
  constructor(private readonly store: AllocationControlStore) {}

  async execute(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.store.closeAllocation(
      prepareTransitionCommand(command, "closeAllocation")
    )
  }
}

export class FenceAndCloseCampaignAllocationHandler {
  constructor(private readonly store: AllocationControlStore) {}

  async execute(
    command: FenceAndCloseCampaignAllocationCommand
  ): Promise<AllocationCampaignFenceResult> {
    return await this.store.fenceAndCloseCampaignAllocation(
      prepareFenceAndCloseCommand(command)
    )
  }
}
