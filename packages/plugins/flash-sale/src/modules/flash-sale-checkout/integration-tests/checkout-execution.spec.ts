import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { createHash } from "crypto"
import path from "path"
import { FlashSalePluginModule } from "../../../types"
import {
  CheckoutCommandErrorCode,
  CheckoutExecution,
  CheckoutExecutionItem,
} from ".."
import FlashSaleCheckoutModuleService from "../service"
import { WRITE_COMMAND_REQUIRED } from "../service"

jest.setTimeout(120000)

const moduleModels = [CheckoutExecution, CheckoutExecutionItem]
const pathToMigrations = path.resolve(__dirname, "../migrations")

async function waitForBlockedCheckoutCommand(manager: SqlEntityManager) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = (await manager.execute(
      `select exists(
         select 1 from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query like '%flash_sale_checkout_execution%'
       ) as blocked`
    )) as Array<{ blocked: boolean }>
    if (rows[0]?.blocked) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("checkout command did not block on the execution row")
}

const command = (suffix: string) => ({
  attempt_id: `attempt-${suffix}`,
  campaign_id: "campaign-checkout",
  subject_id: `customer-${suffix}`,
  cart_id: `cart-${suffix}`,
  command_id: createHash("sha256").update(`command-${suffix}`).digest("hex"),
  request_hash: "a".repeat(64),
  rules_version: 3,
  items: [
    { campaign_item_id: "item-b", variant_id: "variant-b", quantity: 2 },
    { campaign_item_id: "item-a", variant_id: "variant-a", quantity: 1 },
  ],
})

moduleIntegrationTestRunner<FlashSaleCheckoutModuleService>({
  moduleName: FlashSalePluginModule.CHECKOUT,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-checkout",
  moduleModels,
  pathToMigrations,
  testSuite: ({ service, MikroOrmWrapper }) => {
    const authorizedExecution = async (suffix: string, leaseSeconds = 30) => {
      const input = command(suffix)
      const prepared = await service.prepareExecution(input)
      const workerId = `worker-${suffix}`
      const lease = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: workerId,
        lease_seconds: leaseSeconds,
      })
      const authorized = await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: workerId,
        lease_epoch: lease.execution.lease_epoch,
      })
      return {
        input,
        prepared,
        authorized,
        fence: {
          execution_id: prepared.execution.id,
          expected_version: authorized.execution.version,
          worker_id: workerId,
          lease_epoch: authorized.execution.lease_epoch,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
        },
      }
    }

    it("creates the generated schema and supports down/up from a clean install", async () => {
      const manager = MikroOrmWrapper.forkManager()
      const evidence = await manager.execute(
        `select
          to_regclass('public.flash_sale_checkout_execution') is not null as execution_table,
          to_regclass('public.flash_sale_checkout_execution_item') is not null as item_table,
          exists(select 1 from pg_indexes where indexname =
            'IDX_flash_sale_checkout_active_lease') as lease_index,
          exists(select 1 from pg_constraint where conname =
            'ck_flash_sale_checkout_lease_pair') as lease_check,
          exists(select 1 from pg_constraint where conname =
            'ck_flash_sale_checkout_lease_state') as lease_state_check,
          exists(select 1 from pg_constraint where conname =
            'ck_flash_sale_checkout_success_result') as success_check,
          exists(select 1 from pg_constraint where conname =
            'ck_flash_sale_checkout_unknown_result') as unknown_check,
          exists(select 1 from pg_constraint where conname =
            'ck_flash_sale_checkout_terminal_state') as terminal_check`
      )
      expect(evidence).toEqual([
        {
          execution_table: true,
          item_table: true,
          lease_index: true,
          lease_check: true,
          lease_state_check: true,
          success_check: true,
          unknown_check: true,
          terminal_check: true,
        },
      ])
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      await migrator.down()
      expect(
        await manager.execute(
          `select
             to_regclass('public.flash_sale_checkout_execution') is not null as table_exists,
             exists(select 1 from pg_constraint where conname =
               'ck_flash_sale_checkout_success_result') as success_check`
        )
      ).toEqual([{ table_exists: true, success_check: false }])
      await manager.execute(
        `insert into flash_sale_checkout_execution
          (id, attempt_id, campaign_id, subject_id, cart_id, command_id,
           request_hash, commerce_transaction_id, rules_version, state,
           version, attempt_count, lease_epoch)
         values (?, ?, ?, ?, ?, ?, ?, ?, 1, 'prepared', 1, 0, 0)`,
        [
          "fscheckout_legacy_upgrade",
          "attempt-legacy-upgrade",
          "campaign-legacy-upgrade",
          "subject-legacy-upgrade",
          "cart-legacy-upgrade",
          "raw-legacy-command-id",
          "a".repeat(64),
          "fscommerce_legacy_upgrade",
        ]
      )
      await migrator.up()
      expect(
        await manager.execute(
          `select command_id, commerce_result_hash, terminal_command_hash
             from flash_sale_checkout_execution where id = ?`,
          ["fscheckout_legacy_upgrade"]
        )
      ).toEqual([
        {
          command_id: "raw-legacy-command-id",
          commerce_result_hash: null,
          terminal_command_hash: null,
        },
      ])
    })

    it("converges concurrent identical prepare commands to one execution", async () => {
      const input = command("concurrent")
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.prepareExecution(input))
      )
      expect(new Set(results.map((result) => result.execution.id)).size).toBe(1)
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect(results[0].items.map((item) => item.variant_id)).toEqual([
        "variant-a",
        "variant-b",
      ])
      expect(
        await MikroOrmWrapper.forkManager().execute(
          "select count(*)::int as count from flash_sale_checkout_execution where cart_id = ?",
          [input.cart_id]
        )
      ).toEqual([{ count: 1 }])
    })

    it("rejects identity replay with a different trusted snapshot", async () => {
      const input = command("conflict")
      await service.prepareExecution(input)
      await expect(
        service.prepareExecution({
          ...input,
          request_hash: "f".repeat(64),
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_IDENTITY_CONFLICT,
      })
    })

    it("uses database-time leases and rejects a stale worker epoch", async () => {
      const prepared = await service.prepareExecution(command("lease"))
      const first = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_seconds: 30,
      })
      expect(first.execution.lease_epoch).toBe(1)
      expect(
        (
          await service.claimCommerceLease({
            execution_id: prepared.execution.id,
            worker_id: "worker-a",
            lease_seconds: 30,
          })
        ).replayed
      ).toBe(true)

      await MikroOrmWrapper.forkManager().execute(
        `update flash_sale_checkout_execution
            set lease_until = now() - interval '1 second'
          where id = ?`,
        [prepared.execution.id]
      )
      const second = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-b",
        lease_seconds: 30,
      })
      expect(second.execution.lease_epoch).toBe(2)
      await expect(
        service.authorizeCartCompletion({
          execution_id: prepared.execution.id,
          worker_id: "worker-a",
          lease_epoch: 1,
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_FENCE_REJECTED,
      })
      await expect(
        service.authorizeCartCompletion({
          execution_id: prepared.execution.id,
          worker_id: "worker-b",
          lease_epoch: 2,
        })
      ).resolves.toMatchObject({ execution: { lease_epoch: 2 } })
      await expect(
        service.authorizeCartCompletion({
          execution_id: prepared.execution.id,
          worker_id: "worker-b",
          lease_epoch: 2,
        })
      ).resolves.toMatchObject({
        execution: { completion_authorized_epoch: 2 },
        replayed: true,
      })
    })

    it("authorizes only an exact cart snapshot with an active lease", async () => {
      const input = command("snapshot")
      const prepared = await service.prepareExecution(input)
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_REQUIRED,
      })
      const lease = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-snapshot",
        lease_seconds: 30,
      })
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_REQUIRED,
      })
      await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-snapshot",
        lease_epoch: lease.execution.lease_epoch,
      })
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-b", quantity: 2 },
            { variant_id: "variant-a", quantity: 1 },
          ],
        })
      ).resolves.toMatchObject({
        execution: { id: prepared.execution.id },
      })
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 2 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_SNAPSHOT_CONFLICT,
      })
      await MikroOrmWrapper.forkManager().execute(
        `update flash_sale_checkout_execution
            set lease_until = now() - interval '1 second' where id = ?`,
        [prepared.execution.id]
      )
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_REQUIRED,
      })
    })

    it("clears a stale completion authorization when another worker takes over", async () => {
      const input = command("takeover")
      const prepared = await service.prepareExecution(input)
      const first = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_seconds: 30,
      })
      await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_epoch: first.execution.lease_epoch,
      })
      await MikroOrmWrapper.forkManager().execute(
        `update flash_sale_checkout_execution
            set lease_until = now() - interval '1 second'
          where id = ?`,
        [prepared.execution.id]
      )
      const second = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-b",
        lease_seconds: 30,
      })
      expect(second.execution).toMatchObject({
        lease_epoch: 2,
        completion_authorized_epoch: null,
        completion_authorized_at: null,
      })
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_REQUIRED,
      })
      await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-b",
        lease_epoch: second.execution.lease_epoch,
      })
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).resolves.toMatchObject({
        execution: { lease_epoch: 2, completion_authorized_epoch: 2 },
      })
    })

    it("uses a fresh database clock after a row-lock wait to claim an expired lease", async () => {
      const prepared = await service.prepareExecution(command("clock-claim"))
      await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_seconds: 30,
      })
      let releaseLock!: () => void
      let lockAcquired!: () => void
      const gate = new Promise<void>((resolve) => (releaseLock = resolve))
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve))
      const blocker = MikroOrmWrapper.forkManager().transactional(
        async (transaction) => {
          await transaction.execute(
            `update flash_sale_checkout_execution
                set lease_until = clock_timestamp() + interval '1 second'
              where id = ?`,
            [prepared.execution.id]
          )
          lockAcquired()
          await gate
        }
      )
      await acquired
      const claim = service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-b",
        lease_seconds: 30,
      })
      try {
        const observer = MikroOrmWrapper.forkManager()
        await waitForBlockedCheckoutCommand(observer)
        await observer.execute("select pg_sleep(1.1)")
      } finally {
        releaseLock()
        await blocker
      }
      await expect(claim).resolves.toMatchObject({
        execution: { lease_owner: "worker-b", lease_epoch: 2 },
        replayed: false,
      })
    })

    it("rejects authorization when its lease expires while waiting for the row lock", async () => {
      const prepared = await service.prepareExecution(
        command("clock-authorize")
      )
      const lease = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_seconds: 30,
      })
      let releaseLock!: () => void
      let lockAcquired!: () => void
      const gate = new Promise<void>((resolve) => (releaseLock = resolve))
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve))
      const blocker = MikroOrmWrapper.forkManager().transactional(
        async (transaction) => {
          await transaction.execute(
            `update flash_sale_checkout_execution
                set lease_until = clock_timestamp() + interval '1 second'
              where id = ?`,
            [prepared.execution.id]
          )
          lockAcquired()
          await gate
        }
      )
      await acquired
      const authorization = service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-a",
        lease_epoch: lease.execution.lease_epoch,
      })
      const assertion = expect(authorization).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_LEASE_FENCE_REJECTED,
      })
      try {
        const observer = MikroOrmWrapper.forkManager()
        await waitForBlockedCheckoutCommand(observer)
        await observer.execute("select pg_sleep(1.1)")
      } finally {
        releaseLock()
        await blocker
      }
      await assertion
      expect(
        await MikroOrmWrapper.forkManager().execute(
          `select completion_authorized_epoch
             from flash_sale_checkout_execution where id = ?`,
          [prepared.execution.id]
        )
      ).toEqual([{ completion_authorized_epoch: null }])
    })

    it("binds one order, clears the lease fence, and completes with stable replays", async () => {
      const context = await authorizedExecution("success")
      const succeeded = await service.recordCommerceSucceeded({
        ...context.fence,
        order_id: "order-success",
      })
      expect(succeeded).toMatchObject({
        execution: {
          state: "commerce_succeeded",
          order_id: "order-success",
          lease_owner: null,
          lease_until: null,
          completion_authorized_epoch: null,
          completion_authorized_at: null,
          last_error_code: null,
          next_reconcile_at: null,
        },
        replayed: false,
      })
      expect(succeeded.execution.commerce_resolved_at).toBeInstanceOf(Date)
      expect(succeeded.execution.commerce_result_hash).toMatch(/^[0-9a-f]{64}$/)
      await expect(
        service.recordCommerceSucceeded({
          ...context.fence,
          order_id: "order-success",
        })
      ).resolves.toMatchObject({
        execution: { state: "commerce_succeeded", order_id: "order-success" },
        replayed: true,
      })
      await expect(
        service.recordCommerceSucceeded({
          ...context.fence,
          worker_id: "different-worker",
          order_id: "order-success",
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
      await expect(
        service.recordCommerceSucceeded({
          ...context.fence,
          expected_version: context.fence.expected_version + 1,
          order_id: "order-success",
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
      await expect(
        service.cancelExecution({
          execution_id: succeeded.execution.id,
          expected_version: succeeded.execution.version,
          commerce_transaction_id: succeeded.execution.commerce_transaction_id,
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
      const completed = await service.completeExecution({
        execution_id: succeeded.execution.id,
        expected_version: succeeded.execution.version,
        commerce_transaction_id: succeeded.execution.commerce_transaction_id,
        order_id: "order-success",
      })
      expect(completed).toMatchObject({
        execution: { state: "completed", order_id: "order-success" },
        replayed: false,
      })
      expect(completed.execution.terminal_at).toBeInstanceOf(Date)
      expect(completed.execution.terminal_command_hash).toMatch(
        /^[0-9a-f]{64}$/
      )
      await expect(
        service.completeExecution({
          execution_id: succeeded.execution.id,
          expected_version: succeeded.execution.version,
          commerce_transaction_id: succeeded.execution.commerce_transaction_id,
          order_id: "order-success",
        })
      ).resolves.toMatchObject({
        execution: { state: "completed", order_id: "order-success" },
        replayed: true,
      })
      await expect(
        service.completeExecution({
          execution_id: succeeded.execution.id,
          expected_version: succeeded.execution.version + 1,
          commerce_transaction_id: succeeded.execution.commerce_transaction_id,
          order_id: "order-success",
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
    })

    it("cancels only a definitive failure and never an unknown result", async () => {
      const failedContext = await authorizedExecution("definitive")
      const failed = await service.recordCommerceDefinitiveFailure({
        ...failedContext.fence,
        error_code: "PAYMENT_DECLINED",
      })
      expect(failed).toMatchObject({
        execution: {
          state: "commerce_definitive_failed",
          order_id: null,
          last_error_code: "PAYMENT_DECLINED",
          next_reconcile_at: null,
        },
      })
      expect(failed.execution.commerce_resolved_at).toBeInstanceOf(Date)
      await expect(
        service.cancelExecution({
          execution_id: failed.execution.id,
          expected_version: failed.execution.version,
          commerce_transaction_id: failed.execution.commerce_transaction_id,
        })
      ).resolves.toMatchObject({
        execution: { state: "canceled", last_error_code: "PAYMENT_DECLINED" },
      })

      const unknownContext = await authorizedExecution("unknown")
      const unknown = await service.recordCommerceUnknown({
        ...unknownContext.fence,
        error_code: "PAYMENT_TIMEOUT",
        reconcile_after_seconds: 30,
      })
      expect(unknown).toMatchObject({
        execution: {
          state: "commerce_unknown",
          order_id: null,
          last_error_code: "PAYMENT_TIMEOUT",
          commerce_resolved_at: null,
        },
      })
      expect(unknown.execution.next_reconcile_at).toBeInstanceOf(Date)
      await expect(
        service.recordCommerceUnknown({
          ...unknownContext.fence,
          error_code: "PAYMENT_TIMEOUT",
          reconcile_after_seconds: 31,
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
      await expect(
        service.cancelExecution({
          execution_id: unknown.execution.id,
          expected_version: unknown.execution.version,
          commerce_transaction_id: unknown.execution.commerce_transaction_id,
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_STATE_CONFLICT,
      })
      await expect(
        service.claimCommerceLease({
          execution_id: unknown.execution.id,
          worker_id: "worker-unknown-retry",
          lease_seconds: 30,
        })
      ).resolves.toMatchObject({
        execution: {
          state: "commerce_pending",
          lease_epoch: 2,
          next_reconcile_at: null,
          last_error_code: null,
          commerce_resolved_at: null,
        },
      })
    })

    it.each([
      ["version", { expected_version: 999 }],
      ["worker", { worker_id: "stale-worker" }],
      ["epoch", { lease_epoch: 999 }],
      ["transaction", { commerce_transaction_id: "wrong-transaction" }],
    ])(
      "rejects a commerce result with a stale %s fence",
      async (suffix, patch) => {
        const context = await authorizedExecution(`fence-${suffix}`)
        await expect(
          service.recordCommerceSucceeded({
            ...context.fence,
            ...patch,
            order_id: `order-fence-${suffix}`,
          })
        ).rejects.toMatchObject({
          code:
            suffix === "transaction"
              ? CheckoutCommandErrorCode.COMMERCE_TRANSACTION_CONFLICT
              : CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
        })
      }
    )

    it("requires completion authorization before recording a result", async () => {
      const prepared = await service.prepareExecution(command("no-auth"))
      const lease = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-no-auth",
        lease_seconds: 30,
      })
      await expect(
        service.recordCommerceSucceeded({
          execution_id: prepared.execution.id,
          expected_version: lease.execution.version,
          worker_id: "worker-no-auth",
          lease_epoch: lease.execution.lease_epoch,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          order_id: "order-no-auth",
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
      })
    })

    it("uses a fresh clock after a row-lock wait when recording a result", async () => {
      const context = await authorizedExecution("clock-result")
      let releaseLock!: () => void
      let lockAcquired!: () => void
      const gate = new Promise<void>((resolve) => (releaseLock = resolve))
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve))
      const blocker = MikroOrmWrapper.forkManager().transactional(
        async (transaction) => {
          await transaction.execute(
            `update flash_sale_checkout_execution
                set lease_until = clock_timestamp() + interval '1 second'
              where id = ?`,
            [context.prepared.execution.id]
          )
          lockAcquired()
          await gate
        }
      )
      await acquired
      const result = service.recordCommerceSucceeded({
        ...context.fence,
        order_id: "order-clock-result",
      })
      const assertion = expect(result).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.COMMERCE_RESULT_FENCE_REJECTED,
      })
      try {
        const observer = MikroOrmWrapper.forkManager()
        await waitForBlockedCheckoutCommand(observer)
        await observer.execute("select pg_sleep(1.1)")
      } finally {
        releaseLock()
        await blocker
      }
      await assertion
    })

    it("serializes competing commerce outcomes so exactly one result wins", async () => {
      const context = await authorizedExecution("result-race")
      const results = await Promise.allSettled([
        service.recordCommerceSucceeded({
          ...context.fence,
          order_id: "order-result-race",
        }),
        service.recordCommerceDefinitiveFailure({
          ...context.fence,
          error_code: "PAYMENT_DECLINED",
        }),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
    })

    it("enforces a globally unique successful order binding", async () => {
      const first = await authorizedExecution("order-unique-a")
      const second = await authorizedExecution("order-unique-b")
      const results = await Promise.allSettled([
        service.recordCommerceSucceeded({
          ...first.fence,
          order_id: "order-unique",
        }),
        service.recordCommerceSucceeded({
          ...second.fence,
          order_id: "order-unique",
        }),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      const rejected = results.find((result) => result.status === "rejected")
      expect(rejected).toMatchObject({
        reason: { code: CheckoutCommandErrorCode.ORDER_BINDING_CONFLICT },
      })
    })

    it("reads replay-first by hashed command identity and rejects collisions", async () => {
      const input = command("replay")
      expect(
        await service.readExecutionReplay({
          command_id: input.command_id,
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          request_hash: input.request_hash,
        })
      ).toBeNull()
      const prepared = await service.prepareExecution(input)
      await expect(
        service.readExecutionReplay({
          command_id: input.command_id,
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          request_hash: input.request_hash,
        })
      ).resolves.toMatchObject({ execution: { id: prepared.execution.id } })
      await expect(
        service.readExecutionReplay({
          command_id: input.command_id,
          cart_id: "different-cart",
          subject_id: input.subject_id,
          request_hash: input.request_hash,
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_IDENTITY_CONFLICT,
      })
    })

    it("rejects cart authorization under another commerce transaction", async () => {
      const context = await authorizedExecution("authorization-transaction")
      await expect(
        service.readCartCompletionAuthorization({
          cart_id: context.input.cart_id,
          subject_id: context.input.subject_id,
          campaign_id: context.input.campaign_id,
          commerce_transaction_id: "different-transaction",
          rules_version: context.input.rules_version,
          items: [
            { variant_id: "variant-a", quantity: 1 },
            { variant_id: "variant-b", quantity: 2 },
          ],
        })
      ).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.EXECUTION_SNAPSHOT_CONFLICT,
      })
    })

    it("rejects raw rows that violate result-state constraints", async () => {
      const prepared = await service.prepareExecution(command("constraints"))
      await expect(
        MikroOrmWrapper.forkManager().transactional(async (transaction) => {
          await transaction.execute(
            `update flash_sale_checkout_execution
                set state = 'commerce_succeeded', order_id = null,
                    commerce_resolved_at = clock_timestamp()
              where id = ?`,
            [prepared.execution.id]
          )
        })
      ).rejects.toMatchObject({ code: "23514" })
    })

    it("blocks every generated write CRUD path", async () => {
      const methods = [
        "createCheckoutExecutions",
        "updateCheckoutExecutions",
        "upsertCheckoutExecutions",
        "deleteCheckoutExecutions",
        "softDeleteCheckoutExecutions",
        "restoreCheckoutExecutions",
        "createCheckoutExecutionItems",
        "updateCheckoutExecutionItems",
        "upsertCheckoutExecutionItems",
        "deleteCheckoutExecutionItems",
        "softDeleteCheckoutExecutionItems",
        "restoreCheckoutExecutionItems",
      ] as const
      for (const method of methods) {
        await expect(
          (service[method] as unknown as () => Promise<never>)()
        ).rejects.toMatchObject({ message: WRITE_COMMAND_REQUIRED })
      }
    })
  },
})
