import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { generateEntityId } from "@medusajs/framework/utils"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  ClaimedAllocationHold,
  ClaimedPurchaseAttempt,
} from "../application"
import {
  AllocationOutboxEnvelope,
  buildAllocationOutboxEnvelope,
  canonicalJson,
} from "../domain"

type ExistingEnvelopeRow = {
  id: string
  event_name: string
  schema_version: number | string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number | string
  event_hash: string
  payload: Record<string, unknown> | string
}

function invariant(message: string): AllocationCommandError {
  return new AllocationCommandError(
    AllocationCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
    message
  )
}

function payloadOf(row: ExistingEnvelopeRow): Record<string, unknown> {
  return typeof row.payload === "string"
    ? (JSON.parse(row.payload) as Record<string, unknown>)
    : row.payload
}

function envelopeMatches(
  row: ExistingEnvelopeRow,
  expected: AllocationOutboxEnvelope
): boolean {
  return (
    row.event_name === expected.event_name &&
    Number(row.schema_version) === expected.schema_version &&
    row.aggregate_type === expected.aggregate_type &&
    row.aggregate_id === expected.aggregate_id &&
    Number(row.aggregate_version) === expected.aggregate_version &&
    row.event_hash === expected.event_hash &&
    canonicalJson(payloadOf(row)) === canonicalJson(expected.payload)
  )
}

async function findEvent(
  manager: SqlEntityManager,
  envelope: AllocationOutboxEnvelope
): Promise<ExistingEnvelopeRow | undefined> {
  const rows = (await manager.execute(
    `select id, event_name, schema_version, aggregate_type, aggregate_id,
            aggregate_version, event_hash, payload
       from flash_sale_allocation_outbox_event
      where aggregate_type = ? and aggregate_id = ? and aggregate_version = ?
        and deleted_at is null`,
    [
      envelope.aggregate_type,
      envelope.aggregate_id,
      envelope.aggregate_version,
    ]
  )) as ExistingEnvelopeRow[]
  return rows[0]
}

export async function appendAllocationOutboxEvent(
  manager: SqlEntityManager,
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[],
  requestedItems: readonly Readonly<{
    campaign_item_id: string
    quantity: number
  }>[] = []
): Promise<Readonly<{ event_id: string; event_hash: string; replayed: boolean }>> {
  let envelope: AllocationOutboxEnvelope
  try {
    envelope = buildAllocationOutboxEnvelope(attempt, holds, requestedItems)
  } catch (error) {
    throw invariant(
      error instanceof Error
        ? `Allocation outbox envelope is invalid: ${error.message}`
        : "Allocation outbox envelope is invalid"
    )
  }
  const eventId = generateEntityId(undefined, "fsaevt")
  const inserted = (await manager.execute(
    `insert into flash_sale_allocation_outbox_event
      (id, event_name, schema_version, aggregate_type, aggregate_id,
       aggregate_version, event_hash, payload, status, available_at, occurred_at,
       attempt_count, lease_epoch, redrive_count)
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'pending', ?::timestamptz,
             ?::timestamptz, 0, 0, 0)
     on conflict (aggregate_type, aggregate_id, aggregate_version) do nothing
     returning id`,
    [
      eventId,
      envelope.event_name,
      envelope.schema_version,
      envelope.aggregate_type,
      envelope.aggregate_id,
      envelope.aggregate_version,
      envelope.event_hash,
      canonicalJson(envelope.payload),
      attempt.updated_at,
      attempt.updated_at,
    ]
  )) as Array<{ id: string }>
  if (inserted[0]) {
    return { event_id: inserted[0].id, event_hash: envelope.event_hash, replayed: false }
  }
  const existing = await findEvent(manager, envelope)
  if (!existing || !envelopeMatches(existing, envelope)) {
    throw invariant(
      "Allocation outbox aggregate version already contains a different event"
    )
  }
  return { event_id: existing.id, event_hash: existing.event_hash, replayed: true }
}

export async function verifyAllocationOutboxReplay(
  manager: SqlEntityManager,
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[],
  requestedItems: readonly Readonly<{
    campaign_item_id: string
    quantity: number
  }>[] = []
): Promise<void> {
  const controls = (await manager.execute(
    `select required_after from flash_sale_allocation_outbox_control
      where id = ? and deleted_at is null`,
    ["allocation-outbox-required"]
  )) as Array<{ required_after: Date | string }>
  const control = controls[0]
  if (!control) return
  const requiredAfter =
    control.required_after instanceof Date
      ? control.required_after
      : new Date(control.required_after)
  if (attempt.updated_at.getTime() < requiredAfter.getTime()) return

  let expected: AllocationOutboxEnvelope
  try {
    expected = buildAllocationOutboxEnvelope(attempt, holds, requestedItems)
  } catch (error) {
    throw invariant(
      error instanceof Error
        ? `Allocation outbox replay envelope is invalid: ${error.message}`
        : "Allocation outbox replay envelope is invalid"
    )
  }
  const existing = await findEvent(manager, expected)
  if (!existing) {
    throw invariant(
      "Activated allocation attempt replay is missing its current-version outbox event"
    )
  }
  if (!envelopeMatches(existing, expected)) {
    throw invariant(
      "Activated allocation attempt replay conflicts with its current-version outbox event"
    )
  }
}
