import {
  CampaignState,
  TransitionCampaignStateFromSnapshotCommand,
  TransitionCampaignStateWithVersionCommand,
} from "../../../types"

import {
  assertPositiveInteger,
  assertPositiveQuota,
  InvalidCampaignDataError,
} from "./campaign-validation"

const SNAPSHOT_TRANSITION_FIELDS = new Set([
  "campaign_id",
  "target_state",
  "expected_version",
  "expected_rules_version",
  "expected_items",
])
const VERSIONED_TRANSITION_FIELDS = new Set([
  "campaign_id",
  "target_state",
  "expected_version",
  "expected_rules_version",
])
const SNAPSHOT_ITEM_FIELDS = new Set(["campaign_item_id", "quota", "version"])

function invalid(message: string): never {
  throw new InvalidCampaignDataError(message)
}

function assertExactPlainRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  operation: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${operation} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${operation} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.size ||
    keys.some((key) => {
      if (typeof key !== "string" || !fields.has(key)) {
        return true
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })
  ) {
    invalid(`${operation} must contain exactly ${[...fields].join(", ")}`)
  }
}

function assertNonBlankString(field: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${field} is required`)
  }
}

function assertTransitionFields(command: Record<string, unknown>): void {
  assertNonBlankString("campaign_id", command.campaign_id)
  if (
    !Object.values(CampaignState).includes(
      command.target_state as CampaignState
    )
  ) {
    invalid("target_state is invalid")
  }
  assertPositiveInteger("expected_version", command.expected_version)
  assertPositiveInteger(
    "expected_rules_version",
    command.expected_rules_version
  )
}

export function assertSnapshotTransitionCommand(
  command: unknown
): asserts command is TransitionCampaignStateFromSnapshotCommand {
  assertExactPlainRecord(
    command,
    SNAPSHOT_TRANSITION_FIELDS,
    "Snapshot transition command"
  )
  assertTransitionFields(command)
  if (
    !Array.isArray(command.expected_items) ||
    !command.expected_items.length
  ) {
    invalid("expected_items must contain the complete live campaign item set")
  }
  command.expected_items.forEach((item) => {
    assertExactPlainRecord(item, SNAPSHOT_ITEM_FIELDS, "Snapshot item")
    assertNonBlankString("campaign_item_id", item.campaign_item_id)
    assertPositiveQuota(item.quota)
    assertPositiveInteger("item version", item.version)
  })
  const ids = command.expected_items.map((item) => item.campaign_item_id)
  if (new Set(ids).size !== ids.length) {
    invalid("expected_items must contain unique campaign_item_id values")
  }
}

export function assertVersionedTransitionCommand(
  command: unknown
): asserts command is TransitionCampaignStateWithVersionCommand {
  assertExactPlainRecord(
    command,
    VERSIONED_TRANSITION_FIELDS,
    "Versioned transition command"
  )
  assertTransitionFields(command)
}
