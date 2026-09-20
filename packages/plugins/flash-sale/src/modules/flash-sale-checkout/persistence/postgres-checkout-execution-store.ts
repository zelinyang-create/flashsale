import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/framework/utils"
import { createHash } from "crypto"
import {
  CheckoutExecutionDTO,
  CheckoutExecutionItemDTO,
  CheckoutExecutionState,
} from "../../../types"
import {
  AuthorizeCartCompletionCommand,
  AuthorizeCartCompletionResult,
  CancelExecutionCommand,
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  CheckoutExecutionSnapshot,
  CheckoutExecutionStore,
  CompleteExecutionCommand,
  FindExecutionForCartCommand,
  ClaimCommerceLeaseCommand,
  ClaimCommerceLeaseResult,
  PrepareExecutionCommand,
  PrepareExecutionResult,
  ReadCartCompletionAuthorizationCommand,
  ReadExecutionReplayCommand,
  RecordCommerceDefinitiveFailureCommand,
  RecordCommerceSucceededCommand,
  RecordCommerceUnknownCommand,
  TransitionExecutionResult,
} from "../domain"

type ExecutionRow = Omit<
  CheckoutExecutionDTO,
  | "rules_version"
  | "version"
  | "attempt_count"
  | "lease_epoch"
  | "completion_authorized_epoch"
  | "created_at"
  | "updated_at"
  | "deleted_at"
  | "lease_until"
  | "completion_authorized_at"
  | "next_reconcile_at"
  | "commerce_started_at"
  | "commerce_resolved_at"
  | "terminal_at"
> & {
  rules_version: number | string
  version: number | string
  attempt_count: number | string
  lease_epoch: number | string
  completion_authorized_epoch: number | string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  lease_until: Date | string | null
  next_reconcile_at: Date | string | null
  commerce_started_at: Date | string | null
  completion_authorized_at: Date | string | null
  commerce_resolved_at: Date | string | null
  terminal_at: Date | string | null
}

type ItemRow = Omit<
  CheckoutExecutionItemDTO,
  "quantity" | "created_at" | "updated_at" | "deleted_at"
> & {
  quantity: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

const EXECUTION_COLUMNS = `id, attempt_id, campaign_id, subject_id, cart_id,
  command_id, request_hash, commerce_transaction_id, rules_version, state,
  commerce_result_hash, terminal_command_hash,
  order_id, version, attempt_count, lease_owner, lease_until, lease_epoch,
  completion_authorized_epoch, completion_authorized_at,
  next_reconcile_at, last_error_code, commerce_started_at,
  commerce_resolved_at, terminal_at, created_at, updated_at, deleted_at`
const ITEM_COLUMNS = `id, execution_id, campaign_item_id, variant_id, quantity,
  created_at, updated_at, deleted_at`

const asDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value)
const asNullableDate = (value: Date | string | null) =>
  value === null ? null : asDate(value)

function mapExecution(row: ExecutionRow): CheckoutExecutionDTO {
  return {
    ...row,
    rules_version: Number(row.rules_version),
    version: Number(row.version),
    attempt_count: Number(row.attempt_count),
    lease_epoch: Number(row.lease_epoch),
    completion_authorized_epoch:
      row.completion_authorized_epoch === null
        ? null
        : Number(row.completion_authorized_epoch),
    lease_until: asNullableDate(row.lease_until),
    next_reconcile_at: asNullableDate(row.next_reconcile_at),
    commerce_started_at: asNullableDate(row.commerce_started_at),
    completion_authorized_at: asNullableDate(row.completion_authorized_at),
    commerce_resolved_at: asNullableDate(row.commerce_resolved_at),
    terminal_at: asNullableDate(row.terminal_at),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function mapItem(row: ItemRow): CheckoutExecutionItemDTO {
  return {
    ...row,
    quantity: Number(row.quantity),
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    deleted_at: asNullableDate(row.deleted_at),
  }
}

function conflict(code: CheckoutCommandErrorCode, message: string): never {
  throw new CheckoutCommandError(code, message)
}

export class PostgresCheckoutExecutionStore implements CheckoutExecutionStore {
  constructor(private readonly baseRepository: DAL.RepositoryService) {}

  async prepareExecution(
    command: PrepareExecutionCommand
  ): Promise<PrepareExecutionResult> {
    return await this.transaction(async (manager) => {
      const id = generateEntityId(undefined, "fscheckout")
      const inserted = (await manager.execute(
        `insert into flash_sale_checkout_execution
          (id, attempt_id, campaign_id, subject_id, cart_id, command_id,
           request_hash, commerce_transaction_id, rules_version, state,
           version, attempt_count, lease_epoch)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0)
         on conflict do nothing
         returning ${EXECUTION_COLUMNS}`,
        [
          id,
          command.attempt_id,
          command.campaign_id,
          command.subject_id,
          command.cart_id,
          command.command_id,
          command.request_hash,
          generateEntityId(undefined, "fscommerce"),
          command.rules_version,
          CheckoutExecutionState.PREPARED,
        ]
      )) as ExecutionRow[]

      if (inserted[0]) {
        for (const item of command.items) {
          await manager.execute(
            `insert into flash_sale_checkout_execution_item
              (id, execution_id, campaign_item_id, variant_id, quantity,
               raw_quantity)
             values (?, ?, ?, ?, ?, jsonb_build_object('value', ?::text,
                                                       'precision', 20))`,
            [
              generateEntityId(undefined, "fscheckoutitem"),
              id,
              item.campaign_item_id,
              item.variant_id,
              item.quantity,
              item.quantity,
            ]
          )
        }
        return {
          ...(await this.snapshot(manager, inserted[0])),
          replayed: false,
        }
      }

      const existing = await this.findIdentityCollision(manager, command)
      if (!existing) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_IDENTITY_CONFLICT,
          "Checkout execution identity conflicted with a concurrent command"
        )
      }
      const snapshot = await this.snapshot(manager, existing)
      this.assertPrepareReplay(snapshot, command)
      return { ...snapshot, replayed: true }
    })
  }

  async claimCommerceLease(
    command: ClaimCommerceLeaseCommand
  ): Promise<ClaimCommerceLeaseResult> {
    return await this.transaction(async (manager) => {
      const current = await this.lockExecution(manager, command.execution_id)
      if (!current) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_NOT_FOUND,
          "Checkout execution was not found"
        )
      }
      const now = await this.databaseNow(manager)
      if (
        current.state === CheckoutExecutionState.COMMERCE_PENDING &&
        current.lease_owner === command.worker_id &&
        current.lease_until &&
        asDate(current.lease_until).getTime() > now.getTime()
      ) {
        return {
          ...(await this.snapshot(manager, current)),
          replayed: true,
        }
      }
      if (
        current.state === CheckoutExecutionState.COMMERCE_PENDING &&
        current.lease_until &&
        asDate(current.lease_until).getTime() > now.getTime()
      ) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_LEASE_ACTIVE,
          "Checkout execution already has an active commerce lease"
        )
      }
      if (
        current.state !== CheckoutExecutionState.PREPARED &&
        current.state !== CheckoutExecutionState.COMMERCE_PENDING &&
        current.state !== CheckoutExecutionState.COMMERCE_UNKNOWN
      ) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
          `Cannot claim commerce lease from ${current.state}`
        )
      }
      const rows = (await manager.execute(
        `update flash_sale_checkout_execution
            set state = ?, lease_owner = ?,
                lease_until = ?::timestamptz + (? * interval '1 second'),
                lease_epoch = lease_epoch + 1,
                completion_authorized_epoch = null,
                completion_authorized_at = null,
                next_reconcile_at = null,
                last_error_code = null,
                commerce_resolved_at = null,
                commerce_result_hash = null,
                attempt_count = attempt_count + 1,
                commerce_started_at = coalesce(commerce_started_at, ?::timestamptz),
                version = version + 1, updated_at = ?::timestamptz
          where id = ? and version = ? and state = ?
          returning ${EXECUTION_COLUMNS}`,
        [
          CheckoutExecutionState.COMMERCE_PENDING,
          command.worker_id,
          now,
          command.lease_seconds,
          now,
          now,
          current.id,
          Number(current.version),
          current.state,
        ]
      )) as ExecutionRow[]
      if (!rows[0]) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_LEASE_FENCE_REJECTED,
          "Commerce lease claim lost its compare-and-set race"
        )
      }
      return { ...(await this.snapshot(manager, rows[0])), replayed: false }
    })
  }

  async authorizeCartCompletion(
    command: AuthorizeCartCompletionCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.transaction(async (manager) => {
      const current = await this.lockExecution(manager, command.execution_id)
      if (!current) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_NOT_FOUND,
          "Checkout execution was not found"
        )
      }
      const now = await this.databaseNow(manager)
      if (
        current.state !== CheckoutExecutionState.COMMERCE_PENDING ||
        current.lease_owner !== command.worker_id ||
        Number(current.lease_epoch) !== command.lease_epoch ||
        !current.lease_until ||
        asDate(current.lease_until).getTime() <= now.getTime()
      ) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_LEASE_FENCE_REJECTED,
          "Commerce lease is missing, expired, or owned by another epoch"
        )
      }
      if (Number(current.completion_authorized_epoch) === command.lease_epoch) {
        return {
          ...(await this.snapshot(manager, current)),
          replayed: true,
        }
      }
      const rows = (await manager.execute(
        `update flash_sale_checkout_execution
            set completion_authorized_epoch = lease_epoch,
                completion_authorized_at = ?::timestamptz,
                version = version + 1, updated_at = ?::timestamptz
          where id = ? and deleted_at is null and state = ? and version = ?
            and lease_owner = ? and lease_epoch = ?
          returning ${EXECUTION_COLUMNS}`,
        [
          now,
          now,
          command.execution_id,
          CheckoutExecutionState.COMMERCE_PENDING,
          Number(current.version),
          command.worker_id,
          command.lease_epoch,
        ]
      )) as ExecutionRow[]
      if (!rows[0]) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_LEASE_FENCE_REJECTED,
          "Commerce authorization lost its compare-and-set race"
        )
      }
      return { ...(await this.snapshot(manager, rows[0])), replayed: false }
    })
  }

  async readCartCompletionAuthorization(
    command: ReadCartCompletionAuthorizationCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.transaction(async (manager) => {
      const rows = (await manager.execute(
        `select ${EXECUTION_COLUMNS}, lease_until > clock_timestamp() as lease_active
           from flash_sale_checkout_execution
          where cart_id = ? and deleted_at is null
          limit 1`,
        [command.cart_id]
      )) as Array<ExecutionRow & { lease_active: boolean }>
      const execution = rows[0]
      if (!execution) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_NOT_FOUND,
          "Checkout execution was not found for the cart"
        )
      }
      if (
        execution.state !== CheckoutExecutionState.COMMERCE_PENDING ||
        !execution.lease_owner ||
        Number(execution.completion_authorized_epoch) !==
          Number(execution.lease_epoch) ||
        !execution.lease_active
      ) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_LEASE_REQUIRED,
          "An active COMMERCE_PENDING lease is required"
        )
      }
      const snapshot = await this.snapshot(manager, execution)
      if (
        execution.subject_id !== command.subject_id ||
        execution.campaign_id !== command.campaign_id ||
        execution.commerce_transaction_id !== command.commerce_transaction_id ||
        Number(execution.rules_version) !== command.rules_version ||
        JSON.stringify(this.cartItems(snapshot.items)) !==
          JSON.stringify(command.items)
      ) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_SNAPSHOT_CONFLICT,
          "Current cart does not match the trusted checkout snapshot"
        )
      }
      return { ...snapshot, replayed: true }
    })
  }

  async findExecutionForCart(
    command: FindExecutionForCartCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.transaction(async (manager) => {
      const rows = (await manager.execute(
        `select ${EXECUTION_COLUMNS} from flash_sale_checkout_execution
          where cart_id = ? and deleted_at is null limit 1`,
        [command.cart_id]
      )) as ExecutionRow[]
      return rows[0] ? await this.snapshot(manager, rows[0]) : null
    })
  }

  async recordCommerceSucceeded(
    command: RecordCommerceSucceededCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceResult(command, {
      state: CheckoutExecutionState.COMMERCE_SUCCEEDED,
      orderId: command.order_id,
      errorCode: null,
      reconcileAfterSeconds: null,
    })
  }

  async recordCommerceDefinitiveFailure(
    command: RecordCommerceDefinitiveFailureCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceResult(command, {
      state: CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED,
      orderId: null,
      errorCode: command.error_code,
      reconcileAfterSeconds: null,
    })
  }

  async recordCommerceUnknown(
    command: RecordCommerceUnknownCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceResult(command, {
      state: CheckoutExecutionState.COMMERCE_UNKNOWN,
      orderId: null,
      errorCode: command.error_code,
      reconcileAfterSeconds: command.reconcile_after_seconds,
    })
  }

  async completeExecution(
    command: CompleteExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.transaction(async (manager) => {
      const terminalCommandHash = this.hashCommand([
        "completeExecution",
        command.execution_id,
        command.expected_version,
        command.commerce_transaction_id,
        command.order_id,
      ])
      const current = await this.requireLockedExecution(
        manager,
        command.execution_id
      )
      this.assertCommerceTransaction(current, command.commerce_transaction_id)
      if (current.state === CheckoutExecutionState.COMPLETED) {
        if (current.terminal_command_hash !== terminalCommandHash) {
          conflict(
            CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
            "Checkout completion replay does not match the persisted command"
          )
        }
        return { ...(await this.snapshot(manager, current)), replayed: true }
      }
      if (
        current.state !== CheckoutExecutionState.COMMERCE_SUCCEEDED ||
        current.order_id !== command.order_id
      ) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
          `Cannot complete checkout execution from ${current.state}`
        )
      }
      if (Number(current.version) !== command.expected_version) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Checkout completion version fence was rejected"
        )
      }
      const now = await this.databaseNow(manager)
      const rows = (await manager.execute(
        `update flash_sale_checkout_execution
            set state = ?, terminal_at = ?::timestamptz,
                terminal_command_hash = ?,
                version = version + 1, updated_at = ?::timestamptz
          where id = ? and deleted_at is null and state = ? and version = ?
            and commerce_transaction_id = ? and order_id = ?
          returning ${EXECUTION_COLUMNS}`,
        [
          CheckoutExecutionState.COMPLETED,
          now,
          terminalCommandHash,
          now,
          current.id,
          CheckoutExecutionState.COMMERCE_SUCCEEDED,
          command.expected_version,
          command.commerce_transaction_id,
          command.order_id,
        ]
      )) as ExecutionRow[]
      if (!rows[0]) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Checkout completion lost its compare-and-set race"
        )
      }
      return { ...(await this.snapshot(manager, rows[0])), replayed: false }
    })
  }

  async cancelExecution(
    command: CancelExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.transaction(async (manager) => {
      const terminalCommandHash = this.hashCommand([
        "cancelExecution",
        command.execution_id,
        command.expected_version,
        command.commerce_transaction_id,
      ])
      const current = await this.requireLockedExecution(
        manager,
        command.execution_id
      )
      this.assertCommerceTransaction(current, command.commerce_transaction_id)
      if (current.state === CheckoutExecutionState.CANCELED) {
        if (current.terminal_command_hash !== terminalCommandHash) {
          conflict(
            CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
            "Checkout cancellation replay does not match the persisted command"
          )
        }
        return { ...(await this.snapshot(manager, current)), replayed: true }
      }
      if (current.state !== CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
          `Cannot cancel checkout execution from ${current.state}`
        )
      }
      if (Number(current.version) !== command.expected_version) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Checkout cancellation version fence was rejected"
        )
      }
      const now = await this.databaseNow(manager)
      const rows = (await manager.execute(
        `update flash_sale_checkout_execution
            set state = ?, terminal_at = ?::timestamptz,
                terminal_command_hash = ?,
                version = version + 1, updated_at = ?::timestamptz
          where id = ? and deleted_at is null and state = ? and version = ?
            and commerce_transaction_id = ? and order_id is null
          returning ${EXECUTION_COLUMNS}`,
        [
          CheckoutExecutionState.CANCELED,
          now,
          terminalCommandHash,
          now,
          current.id,
          CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED,
          command.expected_version,
          command.commerce_transaction_id,
        ]
      )) as ExecutionRow[]
      if (!rows[0]) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Checkout cancellation lost its compare-and-set race"
        )
      }
      return { ...(await this.snapshot(manager, rows[0])), replayed: false }
    })
  }

  async readExecutionReplay(
    command: ReadExecutionReplayCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.transaction(async (manager) => {
      const rows = (await manager.execute(
        `select ${EXECUTION_COLUMNS} from flash_sale_checkout_execution
          where command_id = ? and deleted_at is null limit 1`,
        [command.command_id]
      )) as ExecutionRow[]
      const current = rows[0]
      if (!current) {
        return null
      }
      if (
        current.cart_id !== command.cart_id ||
        current.subject_id !== command.subject_id ||
        current.request_hash !== command.request_hash
      ) {
        conflict(
          CheckoutCommandErrorCode.EXECUTION_IDENTITY_CONFLICT,
          "Checkout replay identity does not match the persisted execution"
        )
      }
      return await this.snapshot(manager, current)
    })
  }

  private async recordCommerceResult(
    command:
      | RecordCommerceSucceededCommand
      | RecordCommerceDefinitiveFailureCommand
      | RecordCommerceUnknownCommand,
    result: Readonly<{
      state:
        | CheckoutExecutionState.COMMERCE_SUCCEEDED
        | CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED
        | CheckoutExecutionState.COMMERCE_UNKNOWN
      orderId: string | null
      errorCode: string | null
      reconcileAfterSeconds: number | null
    }>
  ): Promise<TransitionExecutionResult> {
    return await this.transaction(async (manager) => {
      const commerceResultHash = this.hashCommand([
        "recordCommerceResult",
        result.state,
        command.execution_id,
        command.expected_version,
        command.worker_id,
        command.lease_epoch,
        command.commerce_transaction_id,
        result.orderId,
        result.errorCode,
        result.reconcileAfterSeconds,
      ])
      const current = await this.requireLockedExecution(
        manager,
        command.execution_id
      )
      this.assertCommerceTransaction(current, command.commerce_transaction_id)

      const replayStates: CheckoutExecutionState[] =
        result.state === CheckoutExecutionState.COMMERCE_SUCCEEDED
          ? [
              CheckoutExecutionState.COMMERCE_SUCCEEDED,
              CheckoutExecutionState.COMPLETED,
            ]
          : result.state === CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED
          ? [
              CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED,
              CheckoutExecutionState.CANCELED,
            ]
          : [CheckoutExecutionState.COMMERCE_UNKNOWN]
      if (replayStates.includes(current.state)) {
        if (current.commerce_result_hash !== commerceResultHash) {
          conflict(
            CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
            "Commerce result replay does not match the persisted result"
          )
        }
        return { ...(await this.snapshot(manager, current)), replayed: true }
      }

      const now = await this.databaseNow(manager)
      if (
        current.state !== CheckoutExecutionState.COMMERCE_PENDING ||
        Number(current.version) !== command.expected_version ||
        current.lease_owner !== command.worker_id ||
        Number(current.lease_epoch) !== command.lease_epoch ||
        Number(current.completion_authorized_epoch) !== command.lease_epoch ||
        !current.lease_until ||
        asDate(current.lease_until).getTime() <= now.getTime()
      ) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Commerce result state, version, worker, lease, or authorization fence was rejected"
        )
      }
      const nextReconcileAt = result.reconcileAfterSeconds
        ? new Date(now.getTime() + result.reconcileAfterSeconds * 1000)
        : null
      const commerceResolvedAt =
        result.state === CheckoutExecutionState.COMMERCE_UNKNOWN ? null : now
      let rows: ExecutionRow[]
      try {
        rows = (await manager.execute(
          `update flash_sale_checkout_execution
              set state = ?, order_id = ?, next_reconcile_at = ?::timestamptz,
                  last_error_code = ?, commerce_resolved_at = ?::timestamptz,
                  commerce_result_hash = ?,
                  lease_owner = null, lease_until = null,
                  completion_authorized_epoch = null,
                  completion_authorized_at = null,
                  version = version + 1, updated_at = ?::timestamptz
            where id = ? and deleted_at is null and state = ? and version = ?
              and lease_owner = ? and lease_epoch = ?
              and completion_authorized_epoch = ?
              and commerce_transaction_id = ?
              and lease_until > ?::timestamptz
            returning ${EXECUTION_COLUMNS}`,
          [
            result.state,
            result.orderId,
            nextReconcileAt,
            result.errorCode,
            commerceResolvedAt,
            commerceResultHash,
            now,
            current.id,
            CheckoutExecutionState.COMMERCE_PENDING,
            command.expected_version,
            command.worker_id,
            command.lease_epoch,
            command.lease_epoch,
            command.commerce_transaction_id,
            now,
          ]
        )) as ExecutionRow[]
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          conflict(
            CheckoutCommandErrorCode.ORDER_BINDING_CONFLICT,
            "Commerce order is already bound to another checkout execution"
          )
        }
        throw error
      }
      if (!rows[0]) {
        conflict(
          CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
          "Commerce result lost its compare-and-set race"
        )
      }
      return { ...(await this.snapshot(manager, rows[0])), replayed: false }
    })
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

  private async databaseNow(manager: SqlEntityManager): Promise<Date> {
    const rows = (await manager.execute(
      "select clock_timestamp() as fresh_now"
    )) as Array<{
      fresh_now: Date | string
    }>
    return asDate(rows[0].fresh_now)
  }

  private async lockExecution(manager: SqlEntityManager, id: string) {
    const rows = (await manager.execute(
      `select ${EXECUTION_COLUMNS} from flash_sale_checkout_execution
        where id = ? and deleted_at is null for update`,
      [id]
    )) as ExecutionRow[]
    return rows[0]
  }

  private async requireLockedExecution(
    manager: SqlEntityManager,
    id: string
  ): Promise<ExecutionRow> {
    const execution = await this.lockExecution(manager, id)
    if (!execution) {
      conflict(
        CheckoutCommandErrorCode.EXECUTION_NOT_FOUND,
        "Checkout execution was not found"
      )
    }
    return execution
  }

  private assertCommerceTransaction(
    execution: ExecutionRow,
    commerceTransactionId: string
  ): void {
    if (execution.commerce_transaction_id !== commerceTransactionId) {
      conflict(
        CheckoutCommandErrorCode.COMMERCE_TRANSACTION_CONFLICT,
        "Commerce transaction does not match the checkout execution"
      )
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    )
  }

  private hashCommand(parts: readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  }

  private async findById(manager: SqlEntityManager, id: string) {
    const rows = (await manager.execute(
      `select ${EXECUTION_COLUMNS} from flash_sale_checkout_execution
        where id = ? and deleted_at is null limit 1`,
      [id]
    )) as ExecutionRow[]
    return rows[0]
  }

  private async findIdentityCollision(
    manager: SqlEntityManager,
    command: PrepareExecutionCommand
  ) {
    const rows = (await manager.execute(
      `select ${EXECUTION_COLUMNS} from flash_sale_checkout_execution
        where deleted_at is null and
              (attempt_id = ? or cart_id = ? or command_id = ?)
        order by created_at asc limit 2`,
      [command.attempt_id, command.cart_id, command.command_id]
    )) as ExecutionRow[]
    if (rows.length !== 1) {
      return undefined
    }
    return rows[0]
  }

  private async snapshot(
    manager: SqlEntityManager,
    execution: ExecutionRow
  ): Promise<CheckoutExecutionSnapshot> {
    const rows = (await manager.execute(
      `select ${ITEM_COLUMNS} from flash_sale_checkout_execution_item
        where execution_id = ? and deleted_at is null
        order by variant_id asc`,
      [execution.id]
    )) as ItemRow[]
    return {
      execution: mapExecution(execution),
      items: rows.map(mapItem),
    }
  }

  private assertPrepareReplay(
    snapshot: CheckoutExecutionSnapshot,
    command: PrepareExecutionCommand
  ): void {
    const execution = snapshot.execution
    const identityMatches =
      execution.attempt_id === command.attempt_id &&
      execution.campaign_id === command.campaign_id &&
      execution.subject_id === command.subject_id &&
      execution.cart_id === command.cart_id &&
      execution.command_id === command.command_id &&
      execution.request_hash === command.request_hash &&
      execution.rules_version === command.rules_version
    const items = snapshot.items.map((item) => ({
      campaign_item_id: item.campaign_item_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }))
    if (
      !identityMatches ||
      JSON.stringify(items) !== JSON.stringify(command.items)
    ) {
      conflict(
        CheckoutCommandErrorCode.EXECUTION_IDENTITY_CONFLICT,
        "Checkout execution identity was already used for another snapshot"
      )
    }
  }

  private cartItems(items: readonly CheckoutExecutionItemDTO[]) {
    return items.map((item) => ({
      variant_id: item.variant_id,
      quantity: item.quantity,
    }))
  }
}
