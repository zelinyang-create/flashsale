import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { createHash } from "crypto"
import { generateEntityId } from "@medusajs/framework/utils"
import {
  CapacityMovementBucket,
  CapacityMovementCheckpointKind,
  CapacityMovementKind,
  PurchaseAttemptState,
} from "../../../types"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  ClaimedAllocationHold,
  ClaimedPurchaseAttempt,
  ProvisionedCapacity,
} from "../application"
import {
  CapacityMovementFingerprintInput,
  createCapacityMovementFingerprint,
} from "../domain"

export const ALLOCATION_MOVEMENT_LEDGER_CONTROL_ID =
  "allocation-movement-ledger"
export const CAPACITY_MOVEMENT_SCHEMA_VERSION = 1 as const
export const ALLOCATION_MOVEMENT_LEDGER_LEGACY_SCHEMA_VERSION = 1 as const
export const ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION = 2 as const
export const ALLOCATION_MOVEMENT_LEDGER_LOCK =
  "flash-sale-allocation-movement-ledger-activation"

export type MovementControlRow = {
  id: string
  activation_id: string
  required_after: Date | string
  schema_version: number | string
  checkpoint_digest: string
  deleted_at: Date | string | null
}

export type MovementCheckpointRow = {
  id: string
  activation_id: string
  capacity_id: string
  campaign_item_id: string
  checkpoint_kind: CapacityMovementCheckpointKind
  shard_no: number | string
  opening_granted_quantity: number | string
  opening_available_quantity: number | string
  opening_held_quantity: number | string
  opening_consumed_quantity: number | string
  capacity_version: number | string
  activated_at: Date | string
  raw_opening_granted_quantity: string
  raw_opening_available_quantity: string
  raw_opening_held_quantity: string
  raw_opening_consumed_quantity: string
  deleted_at: Date | string | null
}

type ExistingMovementRow = {
  capacity_id: string
  attempt_id: string
  campaign_id: string
  subject_id: string
  campaign_item_id: string
  transition_version: number | string
  kind: CapacityMovementKind
  from_bucket: CapacityMovementBucket
  to_bucket: CapacityMovementBucket
  quantity: number | string
  raw_quantity: Record<string, unknown> | string
  fence_token: string
  deleted_at: Date | string | null
}

type MovementTransition = "hold" | "consume" | "release" | "expire"

function invariant(message: string): AllocationCommandError {
  return new AllocationCommandError(
    AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
    message
  )
}

function canonicalInteger(value: number | string): string {
  try {
    return BigInt(value).toString(10)
  } catch {
    return "invalid"
  }
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

function canonicalRaw(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown)
  } catch {
    return "invalid"
  }
}

export function calculateMovementCheckpointDigest(
  rows: MovementCheckpointRow[],
  schemaVersion: number = ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION
): string {
  const tuples = [...rows]
    .sort((left, right) =>
      `${left.capacity_id}\u0000${left.id}`.localeCompare(
        `${right.capacity_id}\u0000${right.id}`
      )
    )
    .map((row) => [
      row.id,
      row.activation_id,
      row.capacity_id,
      row.campaign_item_id,
      ...(schemaVersion >= ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION
        ? [row.checkpoint_kind]
        : []),
      canonicalInteger(row.shard_no),
      canonicalInteger(row.opening_granted_quantity),
      canonicalInteger(row.opening_available_quantity),
      canonicalInteger(row.opening_held_quantity),
      canonicalInteger(row.opening_consumed_quantity),
      canonicalInteger(row.capacity_version),
      asDate(row.activated_at).toISOString(),
      canonicalRaw(row.raw_opening_granted_quantity),
      canonicalRaw(row.raw_opening_available_quantity),
      canonicalRaw(row.raw_opening_held_quantity),
      canonicalRaw(row.raw_opening_consumed_quantity),
    ])
  return createHash("sha256")
    .update(JSON.stringify(tuples), "utf8")
    .digest("hex")
}

function rawQuantityMatches(
  raw: ExistingMovementRow["raw_quantity"],
  quantity: string
): boolean {
  try {
    const value =
      typeof raw === "string"
        ? (JSON.parse(raw) as Record<string, unknown>)
        : raw
    return value.value === quantity && value.precision === 20
  } catch {
    return false
  }
}

function movementRoute(transition: MovementTransition): Readonly<{
  kind: CapacityMovementKind
  from_bucket: CapacityMovementBucket
  to_bucket: CapacityMovementBucket
}> {
  switch (transition) {
    case "hold":
      return {
        kind: CapacityMovementKind.HOLD,
        from_bucket: CapacityMovementBucket.AVAILABLE,
        to_bucket: CapacityMovementBucket.HELD,
      }
    case "consume":
      return {
        kind: CapacityMovementKind.CONSUME,
        from_bucket: CapacityMovementBucket.HELD,
        to_bucket: CapacityMovementBucket.CONSUMED,
      }
    case "release":
      return {
        kind: CapacityMovementKind.RELEASE,
        from_bucket: CapacityMovementBucket.HELD,
        to_bucket: CapacityMovementBucket.AVAILABLE,
      }
    case "expire":
      return {
        kind: CapacityMovementKind.EXPIRE,
        from_bucket: CapacityMovementBucket.HELD,
        to_bucket: CapacityMovementBucket.AVAILABLE,
      }
  }
}

async function loadControl(
  manager: SqlEntityManager,
  forUpdate = false
): Promise<MovementControlRow | undefined> {
  const rows = (await manager.execute(
    `select id, activation_id, required_after, schema_version,
            checkpoint_digest, deleted_at
       from flash_sale_capacity_movement_control
      order by id${forUpdate ? " for update" : ""}`
  )) as MovementControlRow[]
  if (rows.length === 0) return undefined
  if (
    rows.length !== 1 ||
    rows[0].id !== ALLOCATION_MOVEMENT_LEDGER_CONTROL_ID ||
    rows[0].deleted_at !== null ||
    !(
      [
        ALLOCATION_MOVEMENT_LEDGER_LEGACY_SCHEMA_VERSION,
        ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION,
      ] as number[]
    ).includes(Number(rows[0].schema_version)) ||
    !/^[0-9a-f]{64}$/.test(rows[0].checkpoint_digest)
  ) {
    throw invariant("Movement ledger control is not a valid live singleton")
  }
  return rows[0]
}

async function loadPhysicalCheckpoints(
  manager: SqlEntityManager
): Promise<MovementCheckpointRow[]> {
  return (await manager.execute(
    `select id, activation_id, capacity_id, campaign_item_id, checkpoint_kind, shard_no,
            opening_granted_quantity, opening_available_quantity,
            opening_held_quantity, opening_consumed_quantity,
            capacity_version, activated_at,
            raw_opening_granted_quantity::text as raw_opening_granted_quantity,
            raw_opening_available_quantity::text as raw_opening_available_quantity,
            raw_opening_held_quantity::text as raw_opening_held_quantity,
            raw_opening_consumed_quantity::text as raw_opening_consumed_quantity,
            deleted_at
       from flash_sale_capacity_movement_checkpoint
      order by capacity_id, id`
  )) as MovementCheckpointRow[]
}

export function assertMovementCheckpointRows(
  checkpoints: MovementCheckpointRow[],
  control: Pick<
    MovementControlRow,
    "activation_id" | "required_after" | "schema_version"
  >
): void {
  const requiredAfter = asDate(control.required_after).getTime()
  for (const checkpoint of checkpoints) {
    const activatedAt = asDate(checkpoint.activated_at).getTime()
    const granted = canonicalInteger(checkpoint.opening_granted_quantity)
    const available = canonicalInteger(checkpoint.opening_available_quantity)
    const held = canonicalInteger(checkpoint.opening_held_quantity)
    const consumed = canonicalInteger(checkpoint.opening_consumed_quantity)
    const raw = [
      checkpoint.raw_opening_granted_quantity,
      checkpoint.raw_opening_available_quantity,
      checkpoint.raw_opening_held_quantity,
      checkpoint.raw_opening_consumed_quantity,
    ].map((value) => {
      try {
        const parsed = JSON.parse(value) as {
          value?: unknown
          precision?: unknown
        }
        return parsed.precision === 20 && typeof parsed.value === "string"
          ? parsed.value
          : "invalid"
      } catch {
        return "invalid"
      }
    })
    const isProvisionCheckpoint =
      checkpoint.checkpoint_kind === CapacityMovementCheckpointKind.PROVISION
    if (
      checkpoint.deleted_at !== null ||
      checkpoint.activation_id !== control.activation_id ||
      activatedAt < requiredAfter ||
      !Object.values(CapacityMovementCheckpointKind).includes(
        checkpoint.checkpoint_kind
      ) ||
      (Number(control.schema_version) ===
        ALLOCATION_MOVEMENT_LEDGER_LEGACY_SCHEMA_VERSION &&
        checkpoint.checkpoint_kind !==
          CapacityMovementCheckpointKind.CUTOVER) ||
      granted === "invalid" ||
      available === "invalid" ||
      held === "invalid" ||
      consumed === "invalid" ||
      raw[0] !== granted ||
      raw[1] !== available ||
      raw[2] !== held ||
      raw[3] !== consumed ||
      BigInt(granted) <= 0n ||
      BigInt(available) < 0n ||
      BigInt(held) < 0n ||
      BigInt(consumed) < 0n ||
      BigInt(available) + BigInt(held) + BigInt(consumed) !==
        BigInt(granted) ||
      canonicalInteger(checkpoint.shard_no) === "invalid" ||
      Number(checkpoint.shard_no) < 0 ||
      canonicalInteger(checkpoint.capacity_version) === "invalid" ||
      Number(checkpoint.capacity_version) < 1 ||
      (isProvisionCheckpoint &&
        (available !== granted ||
          held !== "0" ||
          consumed !== "0" ||
          Number(checkpoint.capacity_version) !== 1)) ||
      (checkpoint.checkpoint_kind ===
        CapacityMovementCheckpointKind.CUTOVER &&
        activatedAt !== requiredAfter)
    ) {
      throw invariant("Movement ledger checkpoint root is invalid")
    }
  }
}

export function verifyMovementCheckpointRoot(
  checkpoints: MovementCheckpointRow[],
  control: MovementControlRow
): void {
  assertMovementCheckpointRows(checkpoints, control)
  if (
    calculateMovementCheckpointDigest(
      checkpoints,
      Number(control.schema_version)
    ) !== control.checkpoint_digest
  ) {
    throw invariant("Movement ledger checkpoint digest does not match")
  }
}

/**
 * The root is meaningful only when it is a bijection over the physical
 * Capacity population. A soft-deleted Capacity or Checkpoint is retained as
 * evidence and therefore fails closed instead of disappearing from coverage.
 */
export async function assertPhysicalCheckpointCapacityCoverage(
  manager: SqlEntityManager,
  checkpoints: readonly MovementCheckpointRow[]
): Promise<void> {
  const capacities = (await manager.execute(
    `select id, campaign_item_id, shard_no, deleted_at
       from flash_sale_capacity
      order by id`
  )) as Array<{
    id: string
    campaign_item_id: string
    shard_no: number | string
    deleted_at: Date | string | null
  }>
  if (
    capacities.length !== checkpoints.length ||
    capacities.some((capacity) => capacity.deleted_at !== null)
  ) {
    throw invariant(
      "Movement checkpoint root does not cover the physical Capacity set"
    )
  }
  const checkpointByCapacity = new Map(
    checkpoints.map((checkpoint) => [checkpoint.capacity_id, checkpoint] as const)
  )
  if (checkpointByCapacity.size !== checkpoints.length) {
    throw invariant("Movement checkpoint root contains duplicate Capacities")
  }
  for (const capacity of capacities) {
    const checkpoint = checkpointByCapacity.get(capacity.id)
    if (
      !checkpoint ||
      checkpoint.deleted_at !== null ||
      checkpoint.campaign_item_id !== capacity.campaign_item_id ||
      canonicalInteger(checkpoint.shard_no) !==
        canonicalInteger(capacity.shard_no)
    ) {
      throw invariant("Movement checkpoint root Capacity identity drifted")
    }
  }
}

async function assertCheckpointCoverage(
  manager: SqlEntityManager,
  control: MovementControlRow,
  holds: readonly ClaimedAllocationHold[]
): Promise<void> {
  const capacityIds = [...new Set(holds.map((hold) => hold.capacity_id))].sort()
  if (capacityIds.length === 0) {
    throw invariant("Movement transition has no allocation holds")
  }
  const rows = (await manager.execute(
    `select id, activation_id, capacity_id, campaign_item_id, checkpoint_kind, shard_no,
            opening_granted_quantity, opening_available_quantity,
            opening_held_quantity, opening_consumed_quantity,
            capacity_version, activated_at,
            raw_opening_granted_quantity::text as raw_opening_granted_quantity,
            raw_opening_available_quantity::text as raw_opening_available_quantity,
            raw_opening_held_quantity::text as raw_opening_held_quantity,
            raw_opening_consumed_quantity::text as raw_opening_consumed_quantity,
            deleted_at
       from flash_sale_capacity_movement_checkpoint
      where capacity_id in (${capacityIds.map(() => "?").join(", ")})
      order by capacity_id, id`,
    capacityIds
  )) as MovementCheckpointRow[]
  if (rows.length !== capacityIds.length) {
    throw invariant("Activated movement ledger is missing a capacity checkpoint")
  }
  assertMovementCheckpointRows(rows, control)
  const holdByCapacity = new Map(
    holds.map((hold) => [hold.capacity_id, hold] as const)
  )
  for (let index = 0; index < rows.length; index++) {
    const checkpoint = rows[index]
    const hold = holdByCapacity.get(capacityIds[index])
    if (
      !hold ||
      checkpoint.activation_id !== control.activation_id ||
      checkpoint.capacity_id !== capacityIds[index] ||
      checkpoint.campaign_item_id !== hold.campaign_item_id ||
      checkpoint.deleted_at !== null
    ) {
      throw invariant("Activated movement ledger checkpoint identity drifted")
    }
  }
}

function expectedMovement(
  attempt: ClaimedPurchaseAttempt,
  hold: ClaimedAllocationHold,
  transition: MovementTransition,
  transitionVersion: number
): CapacityMovementFingerprintInput {
  const route = movementRoute(transition)
  return {
    schema_version: CAPACITY_MOVEMENT_SCHEMA_VERSION,
    capacity_id: hold.capacity_id,
    attempt_id: attempt.id,
    campaign_id: attempt.campaign_id,
    subject_id: attempt.subject_id,
    campaign_item_id: hold.campaign_item_id,
    transition_version: transitionVersion,
    ...route,
    quantity: canonicalInteger(hold.quantity),
  }
}

function assertTransitionVersion(
  attempt: ClaimedPurchaseAttempt,
  transition: MovementTransition,
  transitionVersion: number
): void {
  const valid =
    (transition === "hold" &&
      attempt.state !== PurchaseAttemptState.PENDING &&
      attempt.state !== PurchaseAttemptState.QUOTA_REJECTED &&
      transitionVersion === 2) ||
    (transition === "consume" &&
      attempt.state === PurchaseAttemptState.QUOTA_CONSUMED &&
      attempt.settlement_id !== null &&
      transitionVersion === 4) ||
    (transition === "release" &&
      attempt.state === PurchaseAttemptState.QUOTA_RELEASED &&
      transitionVersion === (attempt.settlement_id === null ? 3 : 4)) ||
    (transition === "expire" &&
      attempt.state === PurchaseAttemptState.QUOTA_EXPIRED &&
      attempt.settlement_id === null &&
      transitionVersion === 3)
  if (!valid) {
    throw invariant(
      "Capacity movement transition does not match the resulting attempt version"
    )
  }
}

function movementMatches(
  row: ExistingMovementRow,
  expected: CapacityMovementFingerprintInput,
  fingerprint: string
): boolean {
  return (
    row.deleted_at === null &&
    row.capacity_id === expected.capacity_id &&
    row.attempt_id === expected.attempt_id &&
    row.campaign_id === expected.campaign_id &&
    row.subject_id === expected.subject_id &&
    row.campaign_item_id === expected.campaign_item_id &&
    Number(row.transition_version) === expected.transition_version &&
    row.kind === expected.kind &&
    row.from_bucket === expected.from_bucket &&
    row.to_bucket === expected.to_bucket &&
    canonicalInteger(row.quantity) === expected.quantity &&
    rawQuantityMatches(row.raw_quantity, expected.quantity) &&
    row.fence_token === fingerprint
  )
}

async function loadPhysicalAttemptMovements(
  manager: SqlEntityManager,
  attemptId: string
): Promise<ExistingMovementRow[]> {
  return (await manager.execute(
    `select capacity_id, attempt_id, campaign_id, subject_id,
            campaign_item_id, transition_version, kind, from_bucket,
            to_bucket, quantity, raw_quantity, fence_token, deleted_at
       from flash_sale_capacity_movement
      where attempt_id = ?
      order by transition_version, campaign_item_id, id`,
    [attemptId]
  )) as ExistingMovementRow[]
}

function verifyExactMovementSet(
  rows: ExistingMovementRow[],
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[],
  transition: MovementTransition,
  transitionVersion: number
): void {
  if (rows.length !== holds.length) {
    throw invariant(
      "Activated allocation replay has an incomplete or extra capacity movement set"
    )
  }
  const expectedByItem = new Map(
    holds.map((hold) => {
      const expected = expectedMovement(
        attempt,
        hold,
        transition,
        transitionVersion
      )
      return [expected.campaign_item_id, expected] as const
    })
  )
  if (expectedByItem.size !== holds.length) {
    throw invariant("Movement transition contains duplicate hold item identities")
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const expected = expectedByItem.get(row.campaign_item_id)
    if (
      !expected ||
      seen.has(row.campaign_item_id) ||
      !movementMatches(
        row,
        expected,
        createCapacityMovementFingerprint(expected)
      )
    ) {
      throw invariant(
        "Activated allocation replay is missing, extra, deleted, or conflicts with its capacity movement"
      )
    }
    seen.add(row.campaign_item_id)
  }
  if (seen.size !== expectedByItem.size) {
    throw invariant("Activated allocation replay movement item set drifted")
  }
}

type ExpectedMovementTransition = Readonly<{
  transition: MovementTransition
  transitionVersion: number
  activationBinding: string | null
}>

function expectedAttemptMovementTransitions(
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[]
): ExpectedMovementTransition[] {
  const terminalBindingMustBeNull =
    attempt.state === PurchaseAttemptState.PENDING ||
    attempt.state === PurchaseAttemptState.QUOTA_REJECTED ||
    attempt.state === PurchaseAttemptState.QUOTA_HELD ||
    attempt.state === PurchaseAttemptState.QUOTA_COMMITTING
  const expectedVersion =
    attempt.state === PurchaseAttemptState.PENDING
      ? 1
      : attempt.state === PurchaseAttemptState.QUOTA_REJECTED ||
        attempt.state === PurchaseAttemptState.QUOTA_HELD
      ? 2
      : attempt.state === PurchaseAttemptState.QUOTA_COMMITTING ||
        attempt.state === PurchaseAttemptState.QUOTA_EXPIRED
      ? 3
      : attempt.state === PurchaseAttemptState.QUOTA_CONSUMED
      ? 4
      : attempt.settlement_id === null
      ? 3
      : 4

  if (
    attempt.version !== expectedVersion ||
    ((attempt.state === PurchaseAttemptState.PENDING ||
      attempt.state === PurchaseAttemptState.QUOTA_REJECTED) &&
      attempt.hold_movement_activation_id !== null) ||
    (terminalBindingMustBeNull &&
      attempt.terminal_movement_activation_id !== null) ||
    (!terminalBindingMustBeNull &&
      attempt.hold_movement_activation_id !== null &&
      attempt.terminal_movement_activation_id === null)
  ) {
    throw invariant("Attempt state, version, and movement bindings disagree")
  }

  if (
    attempt.state === PurchaseAttemptState.PENDING ||
    attempt.state === PurchaseAttemptState.QUOTA_REJECTED
  ) {
    return []
  }
  if (holds.length === 0) {
    throw invariant("Movement-bearing attempt has no allocation holds")
  }

  const expected: ExpectedMovementTransition[] = [
    {
      transition: "hold",
      transitionVersion: 2,
      activationBinding: attempt.hold_movement_activation_id,
    },
  ]
  if (attempt.state === PurchaseAttemptState.QUOTA_CONSUMED) {
    expected.push({
      transition: "consume",
      transitionVersion: 4,
      activationBinding: attempt.terminal_movement_activation_id,
    })
  } else if (attempt.state === PurchaseAttemptState.QUOTA_RELEASED) {
    expected.push({
      transition: "release",
      transitionVersion: expectedVersion,
      activationBinding: attempt.terminal_movement_activation_id,
    })
  } else if (attempt.state === PurchaseAttemptState.QUOTA_EXPIRED) {
    expected.push({
      transition: "expire",
      transitionVersion: 3,
      activationBinding: attempt.terminal_movement_activation_id,
    })
  }
  return expected
}

/**
 * Writers take the shared form of the activation lock. The activation command
 * takes the exclusive form, so the cutover cannot bisect a balance mutation.
 */
export async function lockAllocationMovementWriter(
  manager: SqlEntityManager
): Promise<void> {
  await manager.execute(
    "select pg_advisory_xact_lock_shared(hashtextextended(?::text, 0))",
    [ALLOCATION_MOVEMENT_LEDGER_LOCK]
  )
}

export async function lockMovementLedgerForCapacityProvision(
  manager: SqlEntityManager
): Promise<MovementControlRow | undefined> {
  const control = await loadControl(manager, true)
  if (control) {
    const checkpoints = await loadPhysicalCheckpoints(manager)
    verifyMovementCheckpointRoot(checkpoints, control)
    await assertPhysicalCheckpointCapacityCoverage(manager, checkpoints)
  }
  return control
}

export async function currentMovementActivationId(
  manager: SqlEntityManager
): Promise<string | null> {
  return (await loadControl(manager))?.activation_id ?? null
}

export async function appendProvisionedCapacityCheckpoints(
  manager: SqlEntityManager,
  control: MovementControlRow | undefined,
  capacities: readonly ProvisionedCapacity[]
): Promise<void> {
  if (!control) return
  // The old root was verified while locking Control before any policy or
  // checkpoint mutation. Never roll a new digest over a tampered old root.
  const nowRows = (await manager.execute(
    "select clock_timestamp() as activated_at"
  )) as Array<{ activated_at: Date | string }>
  const activatedAt = asDate(nowRows[0].activated_at)
  for (const capacity of [...capacities].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const granted = canonicalInteger(capacity.granted_quantity)
    await manager.execute(
      `insert into flash_sale_capacity_movement_checkpoint
        (id, activation_id, capacity_id, campaign_item_id, checkpoint_kind, shard_no,
         opening_granted_quantity, opening_available_quantity,
         opening_held_quantity, opening_consumed_quantity, capacity_version,
         activated_at, raw_opening_granted_quantity,
         raw_opening_available_quantity, raw_opening_held_quantity,
         raw_opening_consumed_quantity)
       values (?, ?, ?, ?, ?, ?, ?::numeric, ?::numeric, 0, 0, 1,
               ?::timestamptz,
               jsonb_build_object('value', ?, 'precision', 20),
               jsonb_build_object('value', ?, 'precision', 20),
               jsonb_build_object('value', '0', 'precision', 20),
               jsonb_build_object('value', '0', 'precision', 20))`,
      [
        generateEntityId(undefined, "fsmovcp"),
        control.activation_id,
        capacity.id,
        capacity.campaign_item_id,
        CapacityMovementCheckpointKind.PROVISION,
        capacity.shard_no,
        granted,
        granted,
        activatedAt,
        granted,
        granted,
      ]
    )
  }
  const checkpoints = await loadPhysicalCheckpoints(manager)
  assertMovementCheckpointRows(checkpoints, {
    activation_id: control.activation_id,
    required_after: control.required_after,
    schema_version: ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION,
  })
  const nextDigest = calculateMovementCheckpointDigest(
    checkpoints,
    ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION
  )
  const updated = (await manager.execute(
    `update flash_sale_capacity_movement_control
        set schema_version = ?, checkpoint_digest = ?, updated_at = now()
      where id = ? and activation_id = ? and schema_version = ?
        and checkpoint_digest = ?
        and deleted_at is null
      returning id`,
    [
      ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION,
      nextDigest,
      ALLOCATION_MOVEMENT_LEDGER_CONTROL_ID,
      control.activation_id,
      Number(control.schema_version),
      control.checkpoint_digest,
    ]
  )) as Array<{ id: string }>
  if (!updated[0]) {
    throw invariant("Movement ledger checkpoint root CAS failed")
  }
  control.schema_version = ALLOCATION_MOVEMENT_LEDGER_CURRENT_SCHEMA_VERSION
  control.checkpoint_digest = nextDigest
  verifyMovementCheckpointRoot(checkpoints, control)
}

export async function verifyProvisionedCapacityCheckpoints(
  manager: SqlEntityManager,
  capacities: readonly ProvisionedCapacity[]
): Promise<void> {
  const control = await loadControl(manager, true)
  if (!control) return
  const checkpoints = await loadPhysicalCheckpoints(manager)
  verifyMovementCheckpointRoot(checkpoints, control)
  await assertPhysicalCheckpointCapacityCoverage(manager, checkpoints)
  const checkpointByCapacity = new Map(
    checkpoints.map((checkpoint) => [checkpoint.capacity_id, checkpoint] as const)
  )
  for (const capacity of capacities) {
    const checkpoint = checkpointByCapacity.get(capacity.id)
    if (
      !checkpoint ||
      checkpoint.campaign_item_id !== capacity.campaign_item_id ||
      Number(checkpoint.shard_no) !== capacity.shard_no
    ) {
      throw invariant("Provision replay is missing its capacity checkpoint")
    }
  }
}

export async function appendCapacityMovements(
  manager: SqlEntityManager,
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[],
  transition: MovementTransition,
  afterFirstAppend?: () => void | Promise<void>
): Promise<void> {
  const control = await loadControl(manager)
  const activationBinding =
    transition === "hold"
      ? attempt.hold_movement_activation_id
      : attempt.terminal_movement_activation_id
  if (
    (control === undefined && activationBinding !== null) ||
    (control !== undefined && activationBinding !== control.activation_id)
  ) {
    throw invariant("Fresh movement activation binding does not match Control")
  }
  const existing = await loadPhysicalAttemptMovements(manager, attempt.id)
  if (
    existing.some(
      (row) => Number(row.transition_version) === attempt.version
    )
  ) {
    throw invariant("Fresh capacity transition already has physical movements")
  }
  if (!control) return
  await assertCheckpointCoverage(manager, control, holds)
  assertTransitionVersion(attempt, transition, attempt.version)

  const sortedHolds = [...holds].sort((left, right) =>
    left.campaign_item_id.localeCompare(right.campaign_item_id)
  )
  for (let index = 0; index < sortedHolds.length; index++) {
    const hold = sortedHolds[index]
    const expected = expectedMovement(
      attempt,
      hold,
      transition,
      attempt.version
    )
    const fingerprint = createCapacityMovementFingerprint(expected)
    const inserted = (await manager.execute(
      `insert into flash_sale_capacity_movement
        (id, capacity_id, attempt_id, campaign_id, subject_id,
         campaign_item_id, transition_version, kind, from_bucket, to_bucket,
         quantity, fence_token, raw_quantity, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?,
               jsonb_build_object('value', ?, 'precision', 20),
               clock_timestamp(), clock_timestamp())
       on conflict (attempt_id, campaign_item_id, transition_version) do nothing
       returning id`,
      [
        generateEntityId(undefined, "fsmov"),
        expected.capacity_id,
        expected.attempt_id,
        expected.campaign_id,
        expected.subject_id,
        expected.campaign_item_id,
        expected.transition_version,
        expected.kind,
        expected.from_bucket,
        expected.to_bucket,
        expected.quantity,
        fingerprint,
        expected.quantity,
      ]
    )) as Array<{ id: string }>
    if (!inserted[0]) {
      throw invariant(
        "Fresh capacity transition conflicts with an existing movement"
      )
    }
    if (index === 0 && sortedHolds.length > 1) {
      await afterFirstAppend?.()
    }
  }
}

export async function verifyCapacityMovementHistory(
  manager: SqlEntityManager,
  attempt: ClaimedPurchaseAttempt,
  holds: readonly ClaimedAllocationHold[]
): Promise<void> {
  // One physical read gives set closure over every version and kind.
  const rows = await loadPhysicalAttemptMovements(manager, attempt.id)
  const transitions = expectedAttemptMovementTransitions(attempt, holds)
  const boundTransitions = transitions.filter(
    (transition) => transition.activationBinding !== null
  )
  if (rows.length !== boundTransitions.length * holds.length) {
    throw invariant(
      "Attempt movement history is incomplete or contains an extra physical row"
    )
  }
  if (boundTransitions.length === 0) return

  const control = await loadControl(manager)
  if (
    !control ||
    boundTransitions.some(
      (transition) => transition.activationBinding !== control.activation_id
    )
  ) {
    throw invariant("Attempt movement activation binding does not match Control")
  }
  await assertCheckpointCoverage(manager, control, holds)

  for (const expectedTransition of boundTransitions) {
    assertTransitionVersion(
      attempt,
      expectedTransition.transition,
      expectedTransition.transitionVersion
    )
    verifyExactMovementSet(
      rows.filter(
        (row) =>
          Number(row.transition_version) ===
          expectedTransition.transitionVersion
      ),
      attempt,
      holds,
      expectedTransition.transition,
      expectedTransition.transitionVersion
    )
  }
}
