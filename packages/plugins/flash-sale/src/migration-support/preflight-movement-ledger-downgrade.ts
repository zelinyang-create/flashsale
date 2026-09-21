import {
  defineConfig,
  MikroORM,
  SqlEntityManager,
} from "@medusajs/framework/mikro-orm/postgresql"
import { MedusaError } from "@medusajs/framework/utils"

const ACTIVATION_LOCK = "flash-sale-allocation-movement-ledger-activation"

const MOVEMENT_TABLES = [
  "flash_sale_capacity_movement",
  "flash_sale_capacity_movement_checkpoint",
  "flash_sale_capacity_movement_control",
] as const

export type MovementLedgerDowngradeReport = Readonly<{
  movement_rows: number
  checkpoint_rows: number
  control_rows: number
  safe: true
}>

type CountRow = {
  movement_rows: number | string
  checkpoint_rows: number | string
  control_rows: number | string
}

function unsafeDowngrade(row: CountRow): MedusaError {
  return new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "Movement-ledger schema downgrade is unsafe: " +
      `movement=${row.movement_rows}, checkpoint=${row.checkpoint_rows}, ` +
      `control=${row.control_rows}; all three physical tables must be empty`
  )
}

/**
 * Acquires the locks used by the offline downgrade preflight and inspects
 * physical rows, including soft-deleted rows. Keep all work that depends on
 * these locks inside the caller's transaction callback.
 */
export async function lockAndInspectMovementLedgerDowngrade(
  transaction: SqlEntityManager
): Promise<MovementLedgerDowngradeReport> {
  await transaction.execute(
    "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
    [ACTIVATION_LOCK]
  )
  await transaction.execute(
    `lock table ${MOVEMENT_TABLES.map((table) => `"${table}"`).join(
      ", "
    )} in access exclusive mode`
  )
  const rows = (await transaction.execute(
    `select
       (select count(*) from flash_sale_capacity_movement) as movement_rows,
       (select count(*) from flash_sale_capacity_movement_checkpoint) as checkpoint_rows,
       (select count(*) from flash_sale_capacity_movement_control) as control_rows`
  )) as CountRow[]
  const row = rows[0] ?? {
    movement_rows: 0,
    checkpoint_rows: 0,
    control_rows: 0,
  }
  if (
    Number(row.movement_rows) !== 0 ||
    Number(row.checkpoint_rows) !== 0 ||
    Number(row.control_rows) !== 0
  ) {
    throw unsafeDowngrade(row)
  }
  return {
    movement_rows: 0,
    checkpoint_rows: 0,
    control_rows: 0,
    safe: true,
  }
}

/**
 * Fail-closed offline preflight for dropping the Movement Ledger schema.
 * API and worker processes must already be stopped. A successful preview is
 * not an authorization token: its locks end with this transaction, and the
 * migration's own guard must re-check physical emptiness during `down`.
 */
export async function preflightMovementLedgerSchemaDowngrade(
  manager: SqlEntityManager
): Promise<MovementLedgerDowngradeReport> {
  return await manager.transactional(async (transaction) => {
    await transaction.execute("set local lock_timeout = '10s'")
    return await lockAndInspectMovementLedgerDowngrade(transaction)
  })
}

async function runCli(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "This preflight accepts no arguments"
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
    const report = await preflightMovementLedgerSchemaDowngrade(
      orm.em.fork() as SqlEntityManager
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
