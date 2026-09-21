import { createHash } from "crypto"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { FlashSalePluginModule } from "../../../types"
import {
  CheckoutCommandErrorCode,
  CheckoutExecution,
  CheckoutExecutionItem,
  CheckoutOutboxControl,
  CheckoutOutboxEvent,
  PostgresCheckoutExecutionStore,
} from ".."
import FlashSaleCheckoutModuleService from "../service"

jest.setTimeout(120_000)
let sequence = 0
const command = (label: string) => {
  const suffix = `${process.pid}-${++sequence}-${label}`
  return {
    attempt_id: `attempt-${suffix}`,
    campaign_id: `campaign-${suffix}`,
    subject_id: `subject-${suffix}`,
    cart_id: `cart-${suffix}`,
    command_id: createHash("sha256").update(`command-${suffix}`).digest("hex"),
    request_hash: createHash("sha256").update(`request-${suffix}`).digest("hex"),
    rules_version: 1,
    items: [
      { campaign_item_id: "item-b", variant_id: "variant-b", quantity: 1 },
      { campaign_item_id: "Item-a", variant_id: "variant-a", quantity: 2 },
    ],
  }
}

moduleIntegrationTestRunner<FlashSaleCheckoutModuleService>({
  moduleName: FlashSalePluginModule.CHECKOUT,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-checkout-outbox",
  moduleModels: [CheckoutExecution, CheckoutExecutionItem, CheckoutOutboxControl, CheckoutOutboxEvent],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ service, MikroOrmWrapper }) => {
    const execute = async (sql: string, params: unknown[] = []) =>
      await MikroOrmWrapper.forkManager().execute(sql, params) as any[]
    const events = async (id: string) => await execute(
      `select id, event_name, aggregate_version::int, event_hash, payload
         from flash_sale_checkout_outbox_event where aggregate_id = ?
        order by aggregate_version`, [id]
    )

    it("keeps a contiguous business stream across technical version gaps and UNKNOWN recovery", async () => {
      const input = command("stream")
      const prepared = await service.prepareExecution(input)
      expect(prepared.execution).toMatchObject({
        version: 1, business_version: 1, outbox_stream_started: true,
      })
      const pending = await service.claimCommerceLease({
        execution_id: prepared.execution.id, worker_id: "worker-a", lease_seconds: 30,
      })
      const authorized = await service.authorizeCartCompletion({
        execution_id: prepared.execution.id, worker_id: "worker-a",
        lease_epoch: pending.execution.lease_epoch,
      })
      expect(authorized.execution.version).toBeGreaterThan(
        authorized.execution.business_version
      )
      expect(authorized.execution.business_version).toBe(2)
      const unknown = await service.recordCommerceUnknown({
        execution_id: prepared.execution.id,
        expected_version: authorized.execution.version,
        worker_id: "worker-a",
        lease_epoch: authorized.execution.lease_epoch,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        error_code: "PAYMENT_RESULT_UNKNOWN",
        reconcile_after_seconds: 1,
      })
      const pendingAgain = await service.claimCommerceLease({
        execution_id: prepared.execution.id, worker_id: "worker-b", lease_seconds: 30,
      })
      const authorizedAgain = await service.authorizeCartCompletion({
        execution_id: prepared.execution.id, worker_id: "worker-b",
        lease_epoch: pendingAgain.execution.lease_epoch,
      })
      const succeeded = await service.recordCommerceSucceeded({
        execution_id: prepared.execution.id,
        expected_version: authorizedAgain.execution.version,
        worker_id: "worker-b",
        lease_epoch: authorizedAgain.execution.lease_epoch,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        order_id: `order-${sequence}`,
      })
      await service.completeExecution({
        execution_id: prepared.execution.id,
        expected_version: succeeded.execution.version,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        order_id: succeeded.execution.order_id!,
      })
      expect(unknown.execution.business_version).toBe(3)
      expect((await events(prepared.execution.id)).map((row) => [
        row.aggregate_version, row.event_name,
      ])).toEqual([
        [1, "flash_sale.checkout.prepared.v1"],
        [2, "flash_sale.checkout.commerce_pending.v1"],
        [3, "flash_sale.checkout.commerce_unknown.v1"],
        [4, "flash_sale.checkout.commerce_pending.v1"],
        [5, "flash_sale.checkout.commerce_succeeded.v1"],
        [6, "flash_sale.checkout.completed.v1"],
      ])
    })

    it("starts a legacy execution stream at v1 on its first business transition", async () => {
      const prepared = await service.prepareExecution(command("legacy-stream"))
      await execute(
        "delete from flash_sale_checkout_outbox_event where aggregate_id = ?",
        [prepared.execution.id]
      )
      await execute(
        `update flash_sale_checkout_execution
            set business_version = 0, outbox_stream_started = false,
                business_changed_at = null
          where id = ?`,
        [prepared.execution.id]
      )

      const pending = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-legacy",
        lease_seconds: 30,
      })

      expect(pending.execution).toMatchObject({
        business_version: 1,
        outbox_stream_started: true,
      })
      expect((await events(prepared.execution.id)).map((row) => [
        row.aggregate_version,
        row.event_name,
      ])).toEqual([[1, "flash_sale.checkout.commerce_pending.v1"]])
    })

    it("publishes definitive failure and cancellation as distinct consecutive facts", async () => {
      const prepared = await service.prepareExecution(command("cancel-stream"))
      const pending = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-cancel",
        lease_seconds: 30,
      })
      const authorized = await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-cancel",
        lease_epoch: pending.execution.lease_epoch,
      })
      const failed = await service.recordCommerceDefinitiveFailure({
        execution_id: prepared.execution.id,
        expected_version: authorized.execution.version,
        worker_id: "worker-cancel",
        lease_epoch: authorized.execution.lease_epoch,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
        error_code: "PAYMENT_DECLINED",
      })
      await service.cancelExecution({
        execution_id: prepared.execution.id,
        expected_version: failed.execution.version,
        commerce_transaction_id: prepared.execution.commerce_transaction_id,
      })

      const stream = await events(prepared.execution.id)
      expect(stream.map((row) => [row.aggregate_version, row.event_name])).toEqual([
        [1, "flash_sale.checkout.prepared.v1"],
        [2, "flash_sale.checkout.commerce_pending.v1"],
        [3, "flash_sale.checkout.commerce_definitive_failed.v1"],
        [4, "flash_sale.checkout.canceled.v1"],
      ])
      expect(stream.slice(2).map((row) => row.payload.error_code)).toEqual([
        "PAYMENT_DECLINED",
        "PAYMENT_DECLINED",
      ])
    })

    it("converges 20 response-loss replays to one stable prepared event", async () => {
      const input = command("concurrent")
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.prepareExecution(input))
      )
      const id = results[0].execution.id
      expect(new Set(results.map((result) => result.execution.id)).size).toBe(1)
      const before = await events(id)
      expect(before).toHaveLength(1)
      await service.prepareExecution(input)
      expect(await events(id)).toEqual(before)
    })

    it.each([
      "afterBusinessTransitionBeforeOutbox",
      "afterOutboxAppendBeforeCommit",
    ] as const)("rolls execution and event back at %s", async (failpoint) => {
      const repository = new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() })
      const store = new PostgresCheckoutExecutionStore(repository, {
        [failpoint]: () => { throw new Error(`injected ${failpoint}`) },
      })
      const input = command(failpoint)
      await expect(store.prepareExecution(input)).rejects.toThrow(`injected ${failpoint}`)
      expect(await execute(
        "select count(*)::int count from flash_sale_checkout_execution where cart_id = ?",
        [input.cart_id]
      )).toEqual([{ count: 0 }])
    })

    it("rolls back an execution whose event identifiers cannot be dispatched", async () => {
      const input = command("poison-identifier")
      input.attempt_id = `${input.attempt_id}\npoison`

      await expect(service.prepareExecution(input)).rejects.toMatchObject({
        code: CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
      })
      expect(await execute(
        `select
           (select count(*)::int from flash_sale_checkout_execution where cart_id = ?) as executions,
           (select count(*)::int from flash_sale_checkout_outbox_event) as events`,
        [input.cart_id]
      )).toEqual([{ executions: 0, events: 0 }])
    })

    it("fails every activated replay/read path closed on a missing current event", async () => {
      await service.activateCheckoutOutbox({})
      const input = command("activation")
      const prepared = await service.prepareExecution(input)
      await execute("delete from flash_sale_checkout_outbox_event where aggregate_id = ?", [prepared.execution.id])
      for (const operation of [
        () => service.prepareExecution(input),
        () => service.readExecutionReplay({
          command_id: input.command_id, cart_id: input.cart_id,
          subject_id: input.subject_id, request_hash: input.request_hash,
        }),
        () => service.findExecutionForCart({ cart_id: input.cart_id }),
        () => service.claimCommerceLease({
          execution_id: prepared.execution.id, worker_id: "worker", lease_seconds: 30,
        }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
        })
      }
      const audit = await service.reconcileCheckoutOutbox({ execution_id: prepared.execution.id })
      expect(audit.healthy).toBe(false)
      expect(audit.counts.OUTBOX_CURRENT_EVENT_MISSING).toBe(1)
    })

    it("fails authorization, guard reads, result writes, and terminal replay closed after current-event loss", async () => {
      const input = command("activation-all-entries")
      const prepared = await service.prepareExecution(input)
      const pending = await service.claimCommerceLease({
        execution_id: prepared.execution.id,
        worker_id: "worker-entry",
        lease_seconds: 30,
      })
      const authorized = await service.authorizeCartCompletion({
        execution_id: prepared.execution.id,
        worker_id: "worker-entry",
        lease_epoch: pending.execution.lease_epoch,
      })
      await execute(
        "delete from flash_sale_checkout_outbox_event where aggregate_id = ? and aggregate_version = 2",
        [prepared.execution.id]
      )
      const invariantOperations = [
        () => service.authorizeCartCompletion({
          execution_id: prepared.execution.id,
          worker_id: "worker-entry",
          lease_epoch: pending.execution.lease_epoch,
        }),
        () => service.readCartCompletionAuthorization({
          cart_id: input.cart_id,
          subject_id: input.subject_id,
          campaign_id: input.campaign_id,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          rules_version: input.rules_version,
          items: input.items.map(({ variant_id, quantity }) => ({ variant_id, quantity })),
        }),
        () => service.recordCommerceSucceeded({
          execution_id: prepared.execution.id,
          expected_version: authorized.execution.version,
          worker_id: "worker-entry",
          lease_epoch: pending.execution.lease_epoch,
          commerce_transaction_id: prepared.execution.commerce_transaction_id,
          order_id: "order-entry",
        }),
      ]
      for (const operation of invariantOperations) {
        await expect(operation()).rejects.toMatchObject({
          code: CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
        })
      }

      const terminalInput = command("activation-terminal")
      const terminalPrepared = await service.prepareExecution(terminalInput)
      const terminalPending = await service.claimCommerceLease({
        execution_id: terminalPrepared.execution.id,
        worker_id: "worker-terminal",
        lease_seconds: 30,
      })
      const terminalAuthorized = await service.authorizeCartCompletion({
        execution_id: terminalPrepared.execution.id,
        worker_id: "worker-terminal",
        lease_epoch: terminalPending.execution.lease_epoch,
      })
      const succeeded = await service.recordCommerceSucceeded({
        execution_id: terminalPrepared.execution.id,
        expected_version: terminalAuthorized.execution.version,
        worker_id: "worker-terminal",
        lease_epoch: terminalPending.execution.lease_epoch,
        commerce_transaction_id: terminalPrepared.execution.commerce_transaction_id,
        order_id: "order-terminal",
      })
      const completed = await service.completeExecution({
        execution_id: terminalPrepared.execution.id,
        expected_version: succeeded.execution.version,
        commerce_transaction_id: terminalPrepared.execution.commerce_transaction_id,
        order_id: "order-terminal",
      })
      await execute(
        "delete from flash_sale_checkout_outbox_event where aggregate_id = ? and aggregate_version = ?",
        [terminalPrepared.execution.id, completed.execution.business_version]
      )
      for (const operation of [
        () => service.completeExecution({
          execution_id: terminalPrepared.execution.id,
          expected_version: succeeded.execution.version,
          commerce_transaction_id: terminalPrepared.execution.commerce_transaction_id,
          order_id: "order-terminal",
        }),
        () => service.readExecutionReplay({
          command_id: terminalInput.command_id,
          cart_id: terminalInput.cart_id,
          subject_id: terminalInput.subject_id,
          request_hash: terminalInput.request_hash,
        }),
        () => service.findExecutionForCart({ cart_id: terminalInput.cart_id }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: CheckoutCommandErrorCode.OUTBOX_INVARIANT_VIOLATION,
        })
      }
    })

    it("claims with HOL, exact fences, retry/dead/redrive, and generated CRUD blocked", async () => {
      const prepared = await service.prepareExecution(command("delivery"))
      const claimed = await service.claimCheckoutOutboxEvents({
        worker_id: "publisher-a", limit: 10, lease_seconds: 30, max_attempts: 1,
      })
      expect(claimed.events).toHaveLength(1)
      const event = claimed.events[0]
      await expect(service.markCheckoutOutboxPublished({
        event_id: event.id, worker_id: "publisher-b", lease_epoch: event.lease_epoch,
      })).resolves.toMatchObject({ disposition: "fenced" })
      const dead = await service.failCheckoutOutboxEvent({
        event_id: event.id, worker_id: "publisher-a", lease_epoch: event.lease_epoch,
        retry_after_seconds: 1, error_code: "PERMANENT_TEST_FAILURE", permanent: true,
      })
      expect(dead.disposition).toBe("dead_lettered")
      const redriven = await service.redriveCheckoutOutboxEvent({
        event_id: event.id, event_hash: event.event_hash,
      })
      expect(redriven).toMatchObject({ disposition: "redriven" })
      const reclaimed = await service.claimCheckoutOutboxEvents({
        worker_id: "publisher-c", limit: 1, lease_seconds: 30, max_attempts: 2,
      })
      expect(reclaimed.events[0].id).toBe(event.id)
      await service.markCheckoutOutboxPublished({
        event_id: event.id, worker_id: "publisher-c",
        lease_epoch: reclaimed.events[0].lease_epoch,
      })
      expect((await events(prepared.execution.id))[0].id).toBe(event.id)
      for (const method of ["createCheckoutOutboxEvents", "updateCheckoutOutboxEvents",
        "upsertCheckoutOutboxEvents", "deleteCheckoutOutboxEvents",
        "createCheckoutOutboxControls", "updateCheckoutOutboxControls"] as const) {
        await expect((service as any)[method]({})).rejects.toThrow("Direct checkout CRUD")
      }
    })
  },
})
