import {
  defineConfig,
  MikroORM,
  SqlEntityManager,
} from "@medusajs/framework/mikro-orm/postgresql"
import { MedusaError } from "@medusajs/framework/utils"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
} from "../modules/flash-sale-allocation/application"
import { AllocationHoldState, PurchaseAttemptState } from "../types"

export const EXPIRY_DOWNGRADE_AUDIT_CODE =
  "SCHEMA_DOWNGRADE_FROM_EXPIRED" as const

export type ExpiryDowngradeMode = "dry-run" | "execute"

export type ExpiryDowngradeReport = Readonly<{
  mode: ExpiryDowngradeMode
  attempts: number
  holds: number
  audit_code: typeof EXPIRY_DOWNGRADE_AUDIT_CODE
}>

export type DowngradeAttemptRow = {
  id: string
  state: PurchaseAttemptState
  version: number | string
}

export type DowngradeHoldRow = {
  id: string
  attempt_id: string
  state: AllocationHoldState
  version: number | string
}

function invariant(message: string): AllocationCommandError {
  return new AllocationCommandError(
    AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION,
    message
  )
}

/**
 * Locks an arbitrary candidate set with two scalar JSONB parameters. Passing a
 * JavaScript array directly through MikroORM/Knex expands it into one bind per
 * element, which fails at PostgreSQL's 65,535-parameter protocol limit.
 * JSONB keeps the bind count constant and never interpolates identifiers into
 * SQL. Attempt locks are fully acquired before Hold locks.
 */
export async function lockExpiryDowngradeCandidates(
  transaction: SqlEntityManager,
  candidateIds: readonly string[]
): Promise<
  Readonly<{
    attempts: readonly DowngradeAttemptRow[]
    holds: readonly DowngradeHoldRow[]
  }>
> {
  if (candidateIds.length === 0) {
    return { attempts: [], holds: [] }
  }
  const encodedIds = JSON.stringify(candidateIds)
  const attempts = (await transaction.execute(
    `select id, state, version
       from flash_sale_purchase_attempt
      where id in (
        select value from jsonb_array_elements_text(?::jsonb) as candidate(value)
      )
      order by id for update`,
    [encodedIds]
  )) as DowngradeAttemptRow[]
  const holds = (await transaction.execute(
    `select id, attempt_id, state, version
       from flash_sale_allocation_hold
      where attempt_id in (
        select value from jsonb_array_elements_text(?::jsonb) as candidate(value)
      )
      order by attempt_id, campaign_item_id, id for update`,
    [encodedIds]
  )) as DowngradeHoldRow[]
  return { attempts, holds }
}

/**
 * Offline compatibility preparation for rolling back the expiry-state schema.
 * The caller must stop API writes and expiry/settlement workers first. All
 * candidate Attempts are locked before their Holds, validated, and converted
 * in one transaction. Counters are intentionally untouched: expiry already
 * returned HELD quota to AVAILABLE.
 */
export async function prepareExpirySchemaDowngrade(
  manager: SqlEntityManager,
  mode: ExpiryDowngradeMode
): Promise<ExpiryDowngradeReport> {
  if (mode !== "dry-run" && mode !== "execute") {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "Expiry schema downgrade mode must be dry-run or execute"
    )
  }
  return await manager.transactional(async (transaction) => {
    await transaction.execute(
      "set local transaction isolation level read committed"
    )
    await transaction.execute("set local lock_timeout = '10s'")

    const committing = (await transaction.execute(
      `select id from flash_sale_purchase_attempt
        where state = ? and deleted_at is null order by id limit 1`,
      [PurchaseAttemptState.QUOTA_COMMITTING]
    )) as Array<{ id: string }>
    if (committing[0]) {
      throw invariant(
        `Schema downgrade requires every QUOTA_COMMITTING Attempt to be resolved first; found ${committing[0].id}`
      )
    }

    const identities = (await transaction.execute(
      `select distinct a.id
         from flash_sale_purchase_attempt a
        where a.state = ?
           or exists (
             select 1 from flash_sale_allocation_hold h
              where h.attempt_id = a.id and h.state = ?
           )
        order by a.id`,
      [PurchaseAttemptState.QUOTA_EXPIRED, AllocationHoldState.EXPIRED]
    )) as Array<{ id: string }>
    if (identities.length === 0) {
      return {
        mode,
        attempts: 0,
        holds: 0,
        audit_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
      }
    }

    const ids = identities.map((identity) => identity.id)
    // Global downgrade lock order: all Attempts, then all Holds.
    const { attempts, holds } = await lockExpiryDowngradeCandidates(
      transaction,
      ids
    )

    if (attempts.length !== identities.length) {
      throw invariant("Expiry downgrade candidate Attempt set changed")
    }
    const holdsByAttempt = new Map<string, DowngradeHoldRow[]>()
    for (const hold of holds) {
      const attemptHolds = holdsByAttempt.get(hold.attempt_id) ?? []
      attemptHolds.push(hold)
      holdsByAttempt.set(hold.attempt_id, attemptHolds)
    }
    for (const attempt of attempts) {
      const attemptHolds = holdsByAttempt.get(attempt.id) ?? []
      if (attempt.state !== PurchaseAttemptState.QUOTA_EXPIRED) {
        throw invariant(
          `Expiry downgrade found EXPIRED Hold under ${attempt.state} Attempt ${attempt.id}`
        )
      }
      if (
        attemptHolds.length === 0 ||
        attemptHolds.some((hold) => hold.state !== AllocationHoldState.EXPIRED)
      ) {
        throw invariant(
          `Expiry downgrade requires every Hold of Attempt ${attempt.id} to be EXPIRED`
        )
      }
    }

    if (mode === "execute") {
      for (const hold of holds) {
        const updated = (await transaction.execute(
          `update flash_sale_allocation_hold
              set state = ?, version = version + 1, updated_at = now()
            where id = ? and state = ? and version = ?
            returning id`,
          [
            AllocationHoldState.RELEASED,
            hold.id,
            AllocationHoldState.EXPIRED,
            Number(hold.version),
          ]
        )) as Array<{ id: string }>
        if (!updated[0]) {
          throw invariant(`Expiry downgrade Hold CAS failed for ${hold.id}`)
        }
      }
      for (const attempt of attempts) {
        const updated = (await transaction.execute(
          `update flash_sale_purchase_attempt
              set state = ?, last_error_code = ?, version = version + 1,
                  updated_at = now()
            where id = ? and state = ? and version = ?
            returning id`,
          [
            PurchaseAttemptState.QUOTA_RELEASED,
            EXPIRY_DOWNGRADE_AUDIT_CODE,
            attempt.id,
            PurchaseAttemptState.QUOTA_EXPIRED,
            Number(attempt.version),
          ]
        )) as Array<{ id: string }>
        if (!updated[0]) {
          throw invariant(
            `Expiry downgrade Attempt CAS failed for ${attempt.id}`
          )
        }
      }
    }

    return {
      mode,
      attempts: attempts.length,
      holds: holds.length,
      audit_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
    }
  })
}

async function runCli(): Promise<void> {
  const argument = process.argv[2]
  const mode: ExpiryDowngradeMode =
    argument === "--dry-run"
      ? "dry-run"
      : argument === "--execute"
      ? "execute"
      : (() => {
          throw new MedusaError(
            MedusaError.Types.INVALID_ARGUMENT,
            "Pass exactly one of --dry-run or --execute"
          )
        })()
  if (process.argv.length !== 3) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "Pass exactly one of --dry-run or --execute"
    )
  }
  const clientUrl = process.env.DATABASE_URL
  if (!clientUrl) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "DATABASE_URL is required"
    )
  }
  const orm = await MikroORM.init(
    defineConfig({
      clientUrl,
      schema: process.env.DB_SCHEMA ?? "public",
      entities: [],
      discovery: { warnWhenNoEntities: false },
    })
  )
  try {
    const report = await prepareExpirySchemaDowngrade(
      orm.em.fork() as SqlEntityManager,
      mode
    )
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    await orm.close(true)
  }
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
