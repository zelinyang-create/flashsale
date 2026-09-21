import {
  defineConfig,
  MikroORM,
} from "@medusajs/framework/mikro-orm/postgresql"
import {
  MikroOrmBaseRepository,
  toMikroORMEntity,
} from "@medusajs/framework/utils"
import * as readline from "readline"
import {
  ActivateAllocationMovementLedgerHandler,
  ClaimAndHoldQuotaHandler,
  ClaimAllocationOutboxEventsHandler,
  ConsumeQuotaSettlementHandler,
  ExpireDueQuotaHandler,
  ExpireQuotaHandler,
  FailAllocationOutboxEventHandler,
  MarkAllocationOutboxPublishedHandler,
  ProvisionAllocationHandler,
  ReleaseQuotaSettlementHandler,
} from "../../application"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationOutboxControl,
  AllocationOutboxEvent,
  AllocationPolicy,
  Capacity,
  CapacityMovement,
  CapacityMovementCheckpoint,
  CapacityMovementControl,
  PurchaseAttempt,
  SubjectAllocation,
} from "../../models"
import {
  AllocationFaultInjector,
  PostgresAllocationAttemptStore,
  PostgresAllocationOutboxStore,
  PostgresCapacityMovementLedgerStore,
} from "../../persistence"
import {
  MULTIPROCESS_PROTOCOL_PREFIX,
  MultiprocessOperation,
  MultiprocessResult,
  WorkerRequest,
  WorkerResponse,
} from "./protocol"

function send(response: WorkerResponse) {
  process.stdout.write(
    `${MULTIPROCESS_PROTOCOL_PREFIX}${JSON.stringify(response)}\n`
  )
}

async function sendAndFlush(response: WorkerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(
      `${MULTIPROCESS_PROTOCOL_PREFIX}${JSON.stringify(response)}\n`,
      (error) => (error ? reject(error) : resolve())
    )
  })
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      error_code:
        "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
    }
  }
  return { message: String(error), error_code: undefined }
}

async function main() {
  const clientUrl = process.env.FLASH_SALE_MP_DATABASE_URL
  if (!clientUrl) {
    throw new Error("FLASH_SALE_MP_DATABASE_URL is required")
  }
  const orm = await MikroORM.init(
    defineConfig({
      clientUrl,
      schema: process.env.FLASH_SALE_MP_SCHEMA ?? "public",
      entities: [
        toMikroORMEntity(AllocationCampaignFence),
        toMikroORMEntity(AllocationOutboxControl),
        toMikroORMEntity(AllocationOutboxEvent),
        toMikroORMEntity(AllocationPolicy),
        toMikroORMEntity(Capacity),
        toMikroORMEntity(CapacityMovement),
        toMikroORMEntity(CapacityMovementCheckpoint),
        toMikroORMEntity(CapacityMovementControl),
        toMikroORMEntity(PurchaseAttempt),
        toMikroORMEntity(AllocationHold),
        toMikroORMEntity(SubjectAllocation),
      ],
      debug: false,
      // Keep enough independent connections to create real overlap without
      // turning this correctness harness into a connection-storm benchmark.
      pool: { min: 1, max: 8 },
      driverOptions: {
        connection: {
          application_name:
            process.env.FLASH_SALE_MP_APPLICATION_NAME ?? "",
        },
      },
    })
  )
  const repository = new MikroOrmBaseRepository({ manager: orm.em })
  const outboxStore = new PostgresAllocationOutboxStore(repository)
  const claimOutbox = new ClaimAllocationOutboxEventsHandler(outboxStore)
  const markOutboxPublished = new MarkAllocationOutboxPublishedHandler(
    outboxStore
  )
  const failOutbox = new FailAllocationOutboxEventHandler(outboxStore)

  async function execute(
    operation: MultiprocessOperation,
    faultInjector?: AllocationFaultInjector
  ): Promise<MultiprocessResult> {
    try {
      const store = new PostgresAllocationAttemptStore(
        repository,
        faultInjector
      )
      if (operation.kind === "activate_movement_ledger") {
        const value = await new ActivateAllocationMovementLedgerHandler(
          new PostgresCapacityMovementLedgerStore(repository, faultInjector)
        ).execute(operation.command)
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "movement_ledger",
          hold_states: [],
          replayed: value.replayed,
          activation_id: value.activation_id,
          checkpoint_count: value.checkpoint_count,
          schema_version: value.schema_version,
        }
      }
      if (operation.kind === "provision_allocation") {
        const value = await new ProvisionAllocationHandler(store).execute(
          operation.command
        )
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "allocation_provision",
          hold_states: [],
          replayed: value.replayed,
          policy_id: value.policy.id,
          capacity_ids: value.capacities.map((capacity) => capacity.id),
        }
      }
      if (operation.kind === "claim_and_hold") {
        const value = await new ClaimAndHoldQuotaHandler(store).execute(
          operation.command
        )
        return {
          outcome: "fulfilled",
          attempt_id: value.attempt.id,
          attempt_state: value.attempt.state,
          hold_states:
            value.status === "held"
              ? value.holds.map((hold) => hold.state)
              : [],
          status: value.status,
          error_code:
            value.status === "rejected" ? value.error_code : undefined,
          replayed: value.replayed,
        }
      }
      if (operation.kind === "expire_due") {
        const value = await new ExpireDueQuotaHandler(store).execute(
          operation.command
        )
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "batch",
          hold_states: [],
          replayed: false,
          ...value,
        }
      }
      if (operation.kind === "claim_outbox") {
        const value = await claimOutbox.execute(operation.command)
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "outbox_batch",
          hold_states: [],
          replayed: false,
          event_ids: value.events.map((event) => event.id),
          outbox_events: value.events.map((event) => ({
            id: event.id,
            lease_epoch: event.lease_epoch,
            lease_owner: event.lease_owner,
          })),
        }
      }
      if (
        operation.kind === "mark_outbox_published" ||
        operation.kind === "fail_outbox"
      ) {
        const value =
          operation.kind === "mark_outbox_published"
            ? await markOutboxPublished.execute(operation.command)
            : await failOutbox.execute(operation.command)
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "outbox_mutation",
          hold_states: [],
          replayed: false,
          event_ids: value.event ? [value.event.id] : [],
          disposition: value.disposition,
        }
      }
      const value =
        operation.kind === "consume_settlement"
          ? await new ConsumeQuotaSettlementHandler(store).execute(
              operation.command
            )
          : operation.kind === "release_settlement"
          ? await new ReleaseQuotaSettlementHandler(store).execute(
              operation.command
            )
          : await new ExpireQuotaHandler(store).execute(operation.command)
      return {
        outcome: "fulfilled",
        attempt_id: value.attempt.id,
        attempt_state: value.attempt.state,
        hold_states: value.holds.map((hold) => hold.state),
        replayed: value.replayed,
      }
    } catch (error) {
      return { outcome: "rejected", ...errorDetails(error) }
    }
  }

  const input = readline.createInterface({ input: process.stdin })
  let queue = Promise.resolve()
  input.on("line", (line) => {
    queue = queue.then(async () => {
      let request: WorkerRequest
      try {
        request = JSON.parse(line) as WorkerRequest
      } catch (error) {
        send({ kind: "fatal", message: errorDetails(error).message })
        return
      }
      if (request.kind === "shutdown") {
        await orm.close(true)
        send({ kind: "result", id: request.id, results: [] })
        input.close()
        return
      }
      if (request.kind === "execute_until_failpoint") {
        const faultInjector: AllocationFaultInjector = {
          hit: async (name, attemptId) => {
            if (name !== request.failpoint) return
            // Await the stream callback before suspending forever. The parent
            // only kills after readline observes this complete protocol line.
            await sendAndFlush({
              kind: "failpoint_reached",
              id: request.id,
              failpoint: name,
              attempt_id: attemptId,
            })
            await new Promise<never>(() => undefined)
          },
        }
        await execute(request.operation, faultInjector)
        send({
          kind: "fatal",
          id: request.id,
          message: `Operation completed without reaching ${request.failpoint}`,
        })
        return
      }
      send({
        kind: "result",
        id: request.id,
        results: await Promise.all(
          request.operations.map((operation) => execute(operation))
        ),
      })
    })
  })
  send({ kind: "ready" })
}

void main().catch((error) => {
  send({ kind: "fatal", message: errorDetails(error).message })
  process.exitCode = 1
})
