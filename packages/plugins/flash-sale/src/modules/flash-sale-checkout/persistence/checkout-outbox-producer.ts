import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { generateEntityId } from "@medusajs/framework/utils"
import {
  canonicalJson,
  normalizeCheckoutEventWireEnvelope,
} from "../../../shared"
import {
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutExecutionSnapshot,
  CheckoutOutboxEnvelope,
  buildCheckoutOutboxEnvelope,
} from "../domain"

type ExistingRow = {
  id: string
  event_name: string
  schema_version: number | string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number | string
  event_hash: string
  payload: Record<string, unknown> | string
}

function invariant(message: string): never {
  throw new CheckoutCommandError(
    CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
    message
  )
}

function payload(row: ExistingRow) {
  return typeof row.payload === "string"
    ? (JSON.parse(row.payload) as Record<string, unknown>)
    : row.payload
}

function matches(row: ExistingRow, expected: CheckoutOutboxEnvelope) {
  return (
    row.event_name === expected.event_name &&
    Number(row.schema_version) === expected.schema_version &&
    row.aggregate_type === expected.aggregate_type &&
    row.aggregate_id === expected.aggregate_id &&
    Number(row.aggregate_version) === expected.aggregate_version &&
    row.event_hash === expected.event_hash &&
    canonicalJson(payload(row)) === canonicalJson(expected.payload)
  )
}

async function find(
  manager: SqlEntityManager,
  envelope: CheckoutOutboxEnvelope
) {
  const rows = (await manager.execute(
    `select id, event_name, schema_version, aggregate_type, aggregate_id,
            aggregate_version, event_hash, payload
       from flash_sale_checkout_outbox_event
      where aggregate_type = ? and aggregate_id = ? and aggregate_version = ?
        and deleted_at is null`,
    [envelope.aggregate_type, envelope.aggregate_id, envelope.aggregate_version]
  )) as ExistingRow[]
  return rows[0]
}

export async function appendCheckoutOutboxEvent(
  manager: SqlEntityManager,
  snapshot: CheckoutExecutionSnapshot
) {
  let envelope: CheckoutOutboxEnvelope
  try {
    envelope = buildCheckoutOutboxEnvelope(snapshot)
  } catch (error) {
    return invariant(
      error instanceof Error
        ? `Checkout outbox envelope is invalid: ${error.message}`
        : "Checkout outbox envelope is invalid"
    )
  }
  const occurredAt = snapshot.execution.business_changed_at
  if (!occurredAt) invariant("Checkout business transition timestamp is missing")
  const id = generateEntityId(undefined, "fscevt")
  let normalized: ReturnType<typeof normalizeCheckoutEventWireEnvelope>
  try {
    normalized = normalizeCheckoutEventWireEnvelope({
      event_id: id,
      ...envelope,
      occurred_at: occurredAt.toISOString(),
    })
  } catch (error) {
    return invariant(
      error instanceof Error
        ? `Checkout outbox wire envelope is invalid: ${error.message}`
        : "Checkout outbox wire envelope is invalid"
    )
  }
  const inserted = (await manager.execute(
    `insert into flash_sale_checkout_outbox_event
      (id, event_name, schema_version, aggregate_type, aggregate_id,
       aggregate_version, event_hash, payload, status, available_at,
       occurred_at, attempt_count, lease_epoch, redrive_count)
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'pending', ?::timestamptz,
             ?::timestamptz, 0, 0, 0)
     on conflict (aggregate_type, aggregate_id, aggregate_version) do nothing
     returning id`,
    [
      id,
      normalized.event_name,
      normalized.schema_version,
      normalized.aggregate_type,
      normalized.aggregate_id,
      normalized.aggregate_version,
      normalized.event_hash,
      canonicalJson(normalized.payload),
      occurredAt,
      occurredAt,
    ]
  )) as Array<{ id: string }>
  if (inserted[0]) {
    return { event_id: inserted[0].id, event_hash: normalized.event_hash, replayed: false }
  }
  const existing = await find(manager, envelope)
  if (!existing || !matches(existing, envelope)) {
    invariant("Checkout business version already contains a different event")
  }
  return { event_id: existing.id, event_hash: existing.event_hash, replayed: true }
}

export async function verifyCheckoutOutboxReplay(
  manager: SqlEntityManager,
  snapshot: CheckoutExecutionSnapshot
): Promise<void> {
  const controls = (await manager.execute(
    `select required_after from flash_sale_checkout_outbox_control
      where id = ? and deleted_at is null`,
    ["checkout-outbox-required"]
  )) as Array<{ required_after: Date | string }>
  const requiredAfter = controls[0]
    ? new Date(controls[0].required_after)
    : null
  const execution = snapshot.execution
  if (!execution.outbox_stream_started) {
    if (execution.business_version !== 0 || execution.business_changed_at) {
      invariant("Checkout outbox stream marker is internally inconsistent")
    }
    if (
      requiredAfter &&
      execution.created_at.getTime() >= requiredAfter.getTime()
    ) {
      invariant("Post-activation checkout execution is missing its outbox stream")
    }
    return
  }
  let expected: CheckoutOutboxEnvelope
  try {
    expected = buildCheckoutOutboxEnvelope(snapshot)
  } catch (error) {
    return invariant(
      error instanceof Error
        ? `Checkout outbox replay envelope is invalid: ${error.message}`
        : "Checkout outbox replay envelope is invalid"
    )
  }
  const existing = await find(manager, expected)
  if (!existing) {
    invariant("Checkout replay is missing its current business-version outbox event")
  }
  if (!matches(existing, expected)) {
    invariant("Checkout replay conflicts with its current outbox event")
  }
}
