import { createHash } from "crypto"
import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/framework/utils"
import {
  ActivateAllocationMovementLedgerCommand,
  ActivateAllocationMovementLedgerResult,
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationMovementLedgerStore,
} from "../application"

const CONTROL_ID = "allocation-movement-ledger"
const SCHEMA_VERSION = 1 as const
const ACTIVATION_LOCK = "flash-sale-allocation-movement-ledger-activation"
const SHA256 = /^[0-9a-f]{64}$/

type CapacityBaselineRow = {
  id: string
  campaign_item_id: string
  shard_no: number | string
  granted_quantity: number | string
  held_quantity: number | string
  consumed_quantity: number | string
  version: number | string
  raw_granted_value: string | null
  raw_held_value: string | null
  raw_consumed_value: string | null
  raw_granted_precision: string | null
  raw_held_precision: string | null
  raw_consumed_precision: string | null
  policy_id: string | null
  aggregate_held: number | string
  aggregate_consumed: number | string
  invalid_hold_count: number | string
}

type ControlRow = {
  id: string
  activation_id: string
  required_after: Date | string
  schema_version: number | string
  checkpoint_digest: string
  deleted_at: Date | string | null
}

type CheckpointRow = {
  id: string
  activation_id: string
  capacity_id: string
  campaign_item_id: string
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

type PhysicalCounts = {
  movements: number | string
  checkpoints: number | string
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const canonicalInteger = (value: number | string): string => {
  try {
    return BigInt(value).toString(10)
  } catch {
    return "invalid"
  }
}

const canonicalRaw = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value) as unknown)
  } catch {
    return "invalid"
  }
}

/** Hashes every immutable checkpoint field in an explicit, stable order. */
const checkpointDigest = (rows: CheckpointRow[]): string => {
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

export class PostgresCapacityMovementLedgerStore
  implements AllocationMovementLedgerStore
{
  constructor(private readonly baseRepository: DAL.RepositoryService) {}

  async activateMovementLedger(
    _input: ActivateAllocationMovementLedgerCommand
  ): Promise<ActivateAllocationMovementLedgerResult> {
    return await this.transaction(async (manager) => {
      await manager.execute(
        "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
        [ACTIVATION_LOCK]
      )

      // Physical rows are intentional here: soft deletion must not make
      // corruption look like a pristine, pre-activation database.
      const controls = (await manager.execute(
        `select id, activation_id, required_after, schema_version,
                checkpoint_digest, deleted_at
           from flash_sale_capacity_movement_control
          order by id
          for update`
      )) as ControlRow[]
      if (controls.length > 0) {
        if (
          controls.length !== 1 ||
          controls[0].id !== CONTROL_ID ||
          controls[0].deleted_at !== null
        ) {
          throw this.invariant(
            "Movement ledger must have exactly one live fixed control row"
          )
        }
        return await this.replay(manager, controls[0])
      }

      const counts = (await manager.execute(
        `select
           (select count(*) from flash_sale_capacity_movement) as movements,
           (select count(*) from flash_sale_capacity_movement_checkpoint) as checkpoints`
      )) as PhysicalCounts[]
      if (
        Number(counts[0]?.movements ?? 0) !== 0 ||
        Number(counts[0]?.checkpoints ?? 0) !== 0
      ) {
        throw this.invariant(
          "Pre-activation movement ledger tables must be physically empty"
        )
      }

      // The control row is written last, so its presence is the commit marker
      // for a complete baseline.
      await manager.execute(
        `select id from flash_sale_capacity
          where deleted_at is null order by id for update`
      )
      const capacities = (await manager.execute(
        `select c.id, c.campaign_item_id, c.shard_no,
                c.granted_quantity, c.held_quantity, c.consumed_quantity,
                c.version, c.raw_granted_quantity->>'value' as raw_granted_value,
                c.raw_held_quantity->>'value' as raw_held_value,
                c.raw_consumed_quantity->>'value' as raw_consumed_value,
                c.raw_granted_quantity->>'precision' as raw_granted_precision,
                c.raw_held_quantity->>'precision' as raw_held_precision,
                c.raw_consumed_quantity->>'precision' as raw_consumed_precision,
                p.id as policy_id,
                coalesce(sum(h.quantity) filter (
                  where h.deleted_at is null and h.state = 'held'), 0) as aggregate_held,
                coalesce(sum(h.quantity) filter (
                  where h.deleted_at is null and h.state = 'consumed'), 0) as aggregate_consumed,
                count(h.id) filter (
                  where h.deleted_at is null and (
                    h.campaign_item_id is distinct from c.campaign_item_id or
                    h.raw_quantity->>'value' is null or
                    h.raw_quantity->>'value' !~ '^(0|[1-9][0-9]*)$' or
                    h.raw_quantity->>'value' <> h.quantity::text or
                    h.raw_quantity->>'precision' is distinct from '20'
                  )) as invalid_hold_count
           from flash_sale_capacity c
           left join flash_sale_allocation_policy p
             on p.id = c.allocation_policy_id and p.deleted_at is null
           left join flash_sale_allocation_hold h on h.capacity_id = c.id
          where c.deleted_at is null
          group by c.id, p.id
          order by c.id`
      )) as CapacityBaselineRow[]

      this.assertConsistentBaseline(capacities)
      const nowRows = (await manager.execute(
        "select clock_timestamp() as activated_at"
      )) as Array<{ activated_at: Date | string }>
      const activatedAt = asDate(nowRows[0].activated_at)
      const activationId = generateEntityId(undefined, "fsmovact")

      for (const capacity of capacities) {
        const granted = canonicalInteger(capacity.granted_quantity)
        const held = canonicalInteger(capacity.held_quantity)
        const consumed = canonicalInteger(capacity.consumed_quantity)
        const available = (
          BigInt(granted) -
          BigInt(held) -
          BigInt(consumed)
        ).toString(10)
        await manager.execute(
          `insert into flash_sale_capacity_movement_checkpoint
            (id, activation_id, capacity_id, campaign_item_id, shard_no,
             opening_granted_quantity, opening_available_quantity,
             opening_held_quantity, opening_consumed_quantity,
             capacity_version, activated_at, raw_opening_granted_quantity,
             raw_opening_available_quantity, raw_opening_held_quantity,
             raw_opening_consumed_quantity)
           values (?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric,
                   ?::numeric, ?, ?::timestamptz,
                   jsonb_build_object('value', ?, 'precision', 20),
                   jsonb_build_object('value', ?, 'precision', 20),
                   jsonb_build_object('value', ?, 'precision', 20),
                   jsonb_build_object('value', ?, 'precision', 20))`,
          [
            generateEntityId(undefined, "fsmovcp"),
            activationId,
            capacity.id,
            capacity.campaign_item_id,
            Number(capacity.shard_no),
            granted,
            available,
            held,
            consumed,
            Number(capacity.version),
            activatedAt,
            granted,
            available,
            held,
            consumed,
          ]
        )
      }

      const checkpoints = await this.loadPhysicalCheckpoints(manager)
      this.assertCheckpointSet(checkpoints, activationId, activatedAt)
      const digest = checkpointDigest(checkpoints)
      await manager.execute(
        `insert into flash_sale_capacity_movement_control
          (id, activation_id, required_after, schema_version, checkpoint_digest)
         values (?, ?, ?::timestamptz, ?, ?)`,
        [CONTROL_ID, activationId, activatedAt, SCHEMA_VERSION, digest]
      )
      return {
        activation_id: activationId,
        required_after: activatedAt,
        schema_version: SCHEMA_VERSION,
        checkpoint_count: checkpoints.length,
        replayed: false,
      }
    })
  }

  private assertConsistentBaseline(capacities: CapacityBaselineRow[]): void {
    for (const capacity of capacities) {
      const granted = canonicalInteger(capacity.granted_quantity)
      const held = canonicalInteger(capacity.held_quantity)
      const consumed = canonicalInteger(capacity.consumed_quantity)
      if (
        capacity.policy_id === null ||
        granted === "invalid" ||
        held === "invalid" ||
        consumed === "invalid" ||
        capacity.raw_granted_value !== granted ||
        capacity.raw_held_value !== held ||
        capacity.raw_consumed_value !== consumed ||
        capacity.raw_granted_precision !== "20" ||
        capacity.raw_held_precision !== "20" ||
        capacity.raw_consumed_precision !== "20" ||
        Number(capacity.invalid_hold_count) !== 0 ||
        BigInt(granted) <= 0n ||
        BigInt(held) < 0n ||
        BigInt(consumed) < 0n ||
        BigInt(held) + BigInt(consumed) > BigInt(granted) ||
        canonicalInteger(capacity.aggregate_held) !== held ||
        canonicalInteger(capacity.aggregate_consumed) !== consumed ||
        !Number.isSafeInteger(Number(capacity.shard_no)) ||
        Number(capacity.shard_no) < 0 ||
        !Number.isSafeInteger(Number(capacity.version)) ||
        Number(capacity.version) < 1
      ) {
        throw this.invariant(
          `Capacity ${capacity.id} is inconsistent at movement-ledger activation`
        )
      }
    }
  }

  private async replay(
    manager: SqlEntityManager,
    control: ControlRow
  ): Promise<ActivateAllocationMovementLedgerResult> {
    if (
      Number(control.schema_version) !== SCHEMA_VERSION ||
      !SHA256.test(control.checkpoint_digest)
    ) {
      throw this.invariant("Movement ledger control is not supported or valid")
    }
    const checkpoints = await this.loadPhysicalCheckpoints(manager)
    const requiredAfter = asDate(control.required_after)
    this.assertCheckpointSet(checkpoints, control.activation_id, requiredAfter)
    if (checkpointDigest(checkpoints) !== control.checkpoint_digest) {
      throw this.invariant("Movement ledger checkpoint digest does not match")
    }
    return {
      activation_id: control.activation_id,
      required_after: requiredAfter,
      schema_version: SCHEMA_VERSION,
      checkpoint_count: checkpoints.length,
      replayed: true,
    }
  }

  private async loadPhysicalCheckpoints(
    manager: SqlEntityManager
  ): Promise<CheckpointRow[]> {
    return (await manager.execute(
      `select id, activation_id, capacity_id, campaign_item_id, shard_no,
              opening_granted_quantity, opening_available_quantity,
              opening_held_quantity, opening_consumed_quantity,
              capacity_version, activated_at,
              raw_opening_granted_quantity::text as raw_opening_granted_quantity,
              raw_opening_available_quantity::text as raw_opening_available_quantity,
              raw_opening_held_quantity::text as raw_opening_held_quantity,
              raw_opening_consumed_quantity::text as raw_opening_consumed_quantity,
              deleted_at
         from flash_sale_capacity_movement_checkpoint
        order by capacity_id, id
        for update`
    )) as CheckpointRow[]
  }

  private assertCheckpointSet(
    checkpoints: CheckpointRow[],
    activationId: string,
    activatedAt: Date
  ): void {
    for (const checkpoint of checkpoints) {
      const granted = canonicalInteger(checkpoint.opening_granted_quantity)
      const available = canonicalInteger(checkpoint.opening_available_quantity)
      const held = canonicalInteger(checkpoint.opening_held_quantity)
      const consumed = canonicalInteger(checkpoint.opening_consumed_quantity)
      const rawValues = [
        checkpoint.raw_opening_granted_quantity,
        checkpoint.raw_opening_available_quantity,
        checkpoint.raw_opening_held_quantity,
        checkpoint.raw_opening_consumed_quantity,
      ].map((raw) => {
        try {
          const value = JSON.parse(raw) as {
            value?: unknown
            precision?: unknown
          }
          return value.precision === 20 && typeof value.value === "string"
            ? value.value
            : "invalid"
        } catch {
          return "invalid"
        }
      })
      if (
        checkpoint.deleted_at !== null ||
        checkpoint.activation_id !== activationId ||
        asDate(checkpoint.activated_at).getTime() !== activatedAt.getTime() ||
        granted === "invalid" ||
        available === "invalid" ||
        held === "invalid" ||
        consumed === "invalid" ||
        granted !== rawValues[0] ||
        available !== rawValues[1] ||
        held !== rawValues[2] ||
        consumed !== rawValues[3] ||
        BigInt(granted) <= 0n ||
        BigInt(available) < 0n ||
        BigInt(held) < 0n ||
        BigInt(consumed) < 0n ||
        BigInt(available) + BigInt(held) + BigInt(consumed) !==
          BigInt(granted) ||
        canonicalInteger(checkpoint.shard_no) === "invalid" ||
        Number(checkpoint.shard_no) < 0 ||
        canonicalInteger(checkpoint.capacity_version) === "invalid" ||
        Number(checkpoint.capacity_version) < 1
      ) {
        throw this.invariant("Movement ledger checkpoint content is invalid")
      }
    }
  }

  private async transaction<T>(
    operation: (manager: SqlEntityManager) => Promise<T>
  ): Promise<T> {
    return await this.baseRepository.transaction<SqlEntityManager>(
      async (manager) => {
        await manager.execute(
          "set local transaction isolation level read committed"
        )
        await manager.execute("set local lock_timeout = '3s'")
        return await operation(manager)
      }
    )
  }

  private invariant(message: string): AllocationCommandError {
    return new AllocationCommandError(
      AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      message
    )
  }
}
