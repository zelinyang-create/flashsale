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
  ClaimAndHoldQuotaHandler,
  ConsumeQuotaSettlementHandler,
  ExpireDueQuotaHandler,
  ExpireQuotaHandler,
  ReleaseQuotaSettlementHandler,
} from "../../application"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationPolicy,
  Capacity,
  PurchaseAttempt,
  SubjectAllocation,
} from "../../models"
import { PostgresAllocationAttemptStore } from "../../persistence"
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
        toMikroORMEntity(AllocationPolicy),
        toMikroORMEntity(Capacity),
        toMikroORMEntity(PurchaseAttempt),
        toMikroORMEntity(AllocationHold),
        toMikroORMEntity(SubjectAllocation),
      ],
      debug: false,
      // Keep enough independent connections to create real overlap without
      // turning this correctness harness into a connection-storm benchmark.
      pool: { min: 1, max: 8 },
    })
  )
  const repository = new MikroOrmBaseRepository({ manager: orm.em })
  const store = new PostgresAllocationAttemptStore(repository)
  const claimAndHold = new ClaimAndHoldQuotaHandler(store)
  const consumeSettlement = new ConsumeQuotaSettlementHandler(store)
  const releaseSettlement = new ReleaseQuotaSettlementHandler(store)
  const expire = new ExpireQuotaHandler(store)
  const expireDue = new ExpireDueQuotaHandler(store)

  async function execute(
    operation: MultiprocessOperation
  ): Promise<MultiprocessResult> {
    try {
      if (operation.kind === "claim_and_hold") {
        const value = await claimAndHold.execute(operation.command)
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
        const value = await expireDue.execute(operation.command)
        return {
          outcome: "fulfilled",
          attempt_id: "",
          attempt_state: "batch",
          hold_states: [],
          replayed: false,
          ...value,
        }
      }
      const value =
        operation.kind === "consume_settlement"
          ? await consumeSettlement.execute(operation.command)
          : operation.kind === "release_settlement"
          ? await releaseSettlement.execute(operation.command)
          : await expire.execute(operation.command)
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
      send({
        kind: "result",
        id: request.id,
        results: await Promise.all(request.operations.map(execute)),
      })
    })
  })
  send({ kind: "ready" })
}

void main().catch((error) => {
  send({ kind: "fatal", message: errorDetails(error).message })
  process.exitCode = 1
})
