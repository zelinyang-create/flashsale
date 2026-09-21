import { createHash } from "crypto"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import * as path from "path"
import {
  ClaimAndHoldQuotaCommand,
  ProvisionAllocationCommand,
  createAllocationConfigurationHash,
} from "../application"
import {
  CapacityMovementCheckpointKind,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../../../types"
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
} from "../models"
import FlashSaleAllocationModuleService from "../service"
import { AllocationWorkerFleet } from "./multiprocess/harness"
import {
  MultiprocessOperation,
  MultiprocessResult,
} from "./multiprocess/protocol"

jest.setTimeout(300_000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const unique = (label: string) =>
  `${label}-crash-${process.pid}-${++sequence}`
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")

function fulfilled(result: MultiprocessResult | undefined) {
  expect(result).toMatchObject({ outcome: "fulfilled" })
  if (!result || result.outcome !== "fulfilled") {
    throw new Error(`Expected fulfilled result: ${JSON.stringify(result)}`)
  }
  return result
}

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation-movement-crash",
  moduleModels: [
    AllocationCampaignFence,
    AllocationOutboxControl,
    AllocationOutboxEvent,
    AllocationPolicy,
    Capacity,
    CapacityMovement,
    CapacityMovementCheckpoint,
    CapacityMovementControl,
    PurchaseAttempt,
    AllocationHold,
    SubjectAllocation,
  ],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ MikroOrmWrapper, dbConfig, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    function provisionCommand(
      campaignId: string,
      itemIds: readonly string[]
    ): ProvisionAllocationCommand {
      const snapshot = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 20,
        items: itemIds.map((campaign_item_id) => ({
          campaign_item_id,
          quota: 100,
        })),
      }
      return {
        ...snapshot,
        configuration_hash: createAllocationConfigurationHash(snapshot),
      }
    }

    function holdCommand(
      campaignId: string,
      itemIds: readonly string[]
    ): ClaimAndHoldQuotaCommand {
      const key = unique("hold-key")
      return {
        campaign_id: campaignId,
        subject_id: unique("subject"),
        cart_id: unique("cart"),
        idempotency_key_hash: digest(key),
        expected_rules_version: 1,
        items: itemIds.map((campaign_item_id) => ({
          campaign_item_id,
          quantity: 2,
        })),
      }
    }

    async function provisionOpen(
      campaignId: string,
      itemIds: readonly string[]
    ) {
      const provisioned = await service.provisionAllocation(
        provisionCommand(campaignId, itemIds)
      )
      await service.openAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
      return provisioned
    }

    async function fleet() {
      return await AllocationWorkerFleet.create(
        dbConfig.clientUrl,
        dbConfig.schema ?? "public",
        2
      )
    }

    async function waitForLockWait(
      holderApplicationName: string,
      contenderApplicationName: string,
      label: string
    ): Promise<void> {
      const deadline = Date.now() + 10_000
      let lastObservation: unknown[] = []
      while (Date.now() < deadline) {
        lastObservation = await execute(
          `select a.pid::int, a.application_name, a.state,
                  a.wait_event_type, a.wait_event,
                  pg_blocking_pids(a.pid) as blocking_pids,
                  exists (
                    select 1 from pg_locks waiting
                     where waiting.pid = a.pid
                       and waiting.locktype = 'advisory'
                       and not waiting.granted
                  ) as waiting_on_ungranted_advisory
             from pg_stat_activity a
            where a.application_name in (?, ?)`,
          [holderApplicationName, contenderApplicationName]
        )
        const rows = lastObservation as Array<Record<string, unknown>>
        const holderPids = new Set(
          rows
            .filter(
              (row) => row.application_name === holderApplicationName
            )
            .map((row) => Number(row.pid))
        )
        const waitingContenders = rows.filter(
          (row) =>
            row.application_name === contenderApplicationName &&
            row.wait_event_type === "Lock" &&
            row.waiting_on_ungranted_advisory === true
        )
        const blockersFromHolder = waitingContenders.flatMap((row) =>
          ((row.blocking_pids as unknown[]) ?? [])
            .map(Number)
            .filter((pid) => holderPids.has(pid))
        )
        if (
          waitingContenders.length === 1 &&
          new Set(blockersFromHolder).size === 1
        ) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(
        `${label} did not reach an advisory lock wait blocked by its holder: ${JSON.stringify(lastObservation)}`
      )
    }

    it("rolls back a two-item Hold when the process dies after its first Movement insert", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique("hold-kill-campaign")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      const provisioned = await provisionOpen(campaignId, itemIds)
      const command = holdCommand(campaignId, itemIds)
      const workers = await fleet()
      try {
        const pending = await workers.executeUntilFailpoint(
          0,
          { kind: "claim_and_hold", command },
          "after_first_capacity_movement_append"
        )
        await expect(workers.crash(0)).resolves.toEqual({
          kill_issued: true,
          exited_after_kill: true,
        })
        await expect(pending.result).rejects.toThrow()

        // Exclusive activation replay is the deterministic connection/rollback
        // barrier. No timing sleep is used after TerminateProcess.
        await expect(
          service.activateAllocationMovementLedger({})
        ).resolves.toMatchObject({ replayed: true })
        expect(
          await execute(
            `select
              (select count(*)::int from flash_sale_purchase_attempt
                where campaign_id = ?) as attempts,
              (select count(*)::int from flash_sale_allocation_hold h
                join flash_sale_capacity c on c.id = h.capacity_id
               where c.allocation_policy_id = ?) as holds,
              (select count(*)::int from flash_sale_capacity_movement
                where campaign_id = ?) as movements,
              (select count(*)::int from flash_sale_allocation_outbox_event e
                join flash_sale_purchase_attempt a on a.id = e.aggregate_id
               where a.campaign_id = ?) as events,
              (select sum(held_quantity)::int from flash_sale_capacity
                where allocation_policy_id = ?) as held`,
            [
              campaignId,
              provisioned.policy.id,
              campaignId,
              campaignId,
              provisioned.policy.id,
            ]
          )
        ).toEqual([{ attempts: 0, holds: 0, movements: 0, events: 0, held: 0 }])

        const fresh = fulfilled(
          (await workers.executeOn(1, [
            { kind: "claim_and_hold", command },
          ]))[0]
        )
        expect(fresh).toMatchObject({ replayed: false, status: "held" })
        const replay = fulfilled(
          (await workers.executeOn(1, [
            { kind: "claim_and_hold", command },
          ]))[0]
        )
        expect(replay).toMatchObject({
          replayed: true,
          status: "held",
          attempt_id: fresh.attempt_id,
        })
        expect(
          await execute(
            `select transition_version::int, kind, count(*)::int as count
               from flash_sale_capacity_movement
              where attempt_id = ?
              group by transition_version, kind`,
            [fresh.attempt_id]
          )
        ).toEqual([{ transition_version: 2, kind: "hold", count: 2 }])
      } finally {
        await workers.close()
      }
    })

    it("rolls Consume back when the process dies after Outbox append", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique("consume-kill-campaign")
      const itemIds = [`${campaignId}-item`]
      await provisionOpen(campaignId, itemIds)
      const held = await service.claimAndHoldQuota(
        holdCommand(campaignId, itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = unique("settlement")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      const workers = await fleet()
      try {
        const operation: MultiprocessOperation = {
          kind: "consume_settlement",
          command: {
            attempt_id: held.attempt.id,
            settlement_id: settlementId,
          },
        }
        const pending = await workers.executeUntilFailpoint(
          0,
          operation,
          "after_outbox_append_before_commit"
        )
        await expect(workers.crash(0)).resolves.toEqual({
          kill_issued: true,
          exited_after_kill: true,
        })
        await expect(pending.result).rejects.toThrow()
        await service.activateAllocationMovementLedger({})

        expect(
          await execute(
            `select a.state, a.version::int,
                    count(*) filter (where h.state = 'held')::int as held_holds,
                    sum(c.held_quantity)::int as held,
                    sum(c.consumed_quantity)::int as consumed,
                    (select count(*)::int from flash_sale_capacity_movement m
                      where m.attempt_id = a.id and m.transition_version = 4) as terminal_movements,
                    (select count(*)::int from flash_sale_allocation_outbox_event e
                      where e.aggregate_id = a.id and e.aggregate_version = 4) as terminal_events
               from flash_sale_purchase_attempt a
               join flash_sale_allocation_hold h on h.attempt_id = a.id
               join flash_sale_capacity c on c.id = h.capacity_id
              where a.id = ? group by a.id`,
            [held.attempt.id]
          )
        ).toEqual([
          {
            state: PurchaseAttemptState.QUOTA_COMMITTING,
            version: 3,
            held_holds: 1,
            held: 2,
            consumed: 0,
            terminal_movements: 0,
            terminal_events: 0,
          },
        ])

        const fresh = fulfilled((await workers.executeOn(1, [operation]))[0])
        expect(fresh).toMatchObject({
          replayed: false,
          attempt_state: PurchaseAttemptState.QUOTA_CONSUMED,
        })
        const replay = fulfilled((await workers.executeOn(1, [operation]))[0])
        expect(replay).toMatchObject({ replayed: true })
        expect(
          await execute(
            `select transition_version::int, kind, count(*)::int as count
               from flash_sale_capacity_movement where attempt_id = ?
              group by transition_version, kind order by transition_version`,
            [held.attempt.id]
          )
        ).toEqual([
          { transition_version: 2, kind: "hold", count: 1 },
          { transition_version: 4, kind: "consume", count: 1 },
        ])
      } finally {
        await workers.close()
      }
    })

    it("rejects pending work and closes immediately when the initial kill is not issued", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique("kill-failure-cleanup-campaign")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      await provisionOpen(campaignId, itemIds)
      const workers = await fleet()
      try {
        const pending = await workers.executeUntilFailpoint(
          0,
          {
            kind: "claim_and_hold",
            command: holdCommand(campaignId, itemIds),
          },
          "after_first_capacity_movement_append"
        )
        await expect(
          workers.crash(0, { initialKill: () => false })
        ).rejects.toThrow("Allocation worker kill request was not issued")
        await expect(pending.result).rejects.toThrow(
          "Allocation worker kill request was not issued"
        )
        await expect(
          Promise.race([
            workers.close().then(() => "closed"),
            new Promise<string>((_, reject) =>
              setTimeout(
                () => reject(new Error("failed worker close was not immediate")),
                1_000
              )
            ),
          ])
        ).resolves.toBe("closed")

        // Acquiring the exclusive replay lock proves the cleanup's best-effort
        // kill released the failed worker transaction and connection.
        await expect(
          service.activateAllocationMovementLedger({})
        ).resolves.toMatchObject({ replayed: true })
        expect(
          await execute(
            `select count(*)::int as count
               from flash_sale_purchase_attempt
              where campaign_id = ?`,
            [campaignId]
          )
        ).toEqual([{ count: 0 }])
      } finally {
        await workers.close()
      }
    })

    it("linearizes first activation against an in-flight Hold without losing conservation", async () => {
      const campaignId = unique("activation-writer-campaign")
      const itemIds = [`${campaignId}-item`]
      const provisioned = await provisionOpen(campaignId, itemIds)
      const command = holdCommand(campaignId, itemIds)
      const workers = await fleet()
      try {
        const holder = await workers.executeUntilFailpoint(
          0,
          { kind: "claim_and_hold", command },
          "after_movement_writer_shared_lock"
        )
        const contender = workers.executeOn(1, [
          { kind: "activate_movement_ledger", command: {} },
        ])
        void contender.catch(() => undefined)
        await waitForLockWait(
          workers.applicationName(0),
          workers.applicationName(1),
          "activation contender"
        )
        await expect(workers.crash(0)).resolves.toEqual({
          kill_issued: true,
          exited_after_kill: true,
        })
        await expect(holder.result).rejects.toThrow()

        const activation = fulfilled((await contender)[0])
        expect(activation.replayed).toBe(false)
        const held = fulfilled(
          (await workers.executeOn(1, [
            { kind: "claim_and_hold", command },
          ]))[0]
        )
        expect(held).toMatchObject({ status: "held", replayed: false })
        expect(
          fulfilled(
            (await workers.executeOn(1, [
              { kind: "claim_and_hold", command },
            ]))[0]
          )
        ).toMatchObject({
          attempt_id: held.attempt_id,
          status: "held",
          replayed: true,
        })
        await expect(
          service.activateAllocationMovementLedger({})
        ).resolves.toMatchObject({
          activation_id: activation.activation_id,
          replayed: true,
        })
        const evidence = (await execute(
          `select cp.opening_held_quantity::int as opening_held,
                  count(m.id)::int as hold_movements,
                  coalesce(sum(m.quantity), 0)::int as hold_delta,
                  c.held_quantity::int as materialized_held,
                  a.hold_movement_activation_id
             from flash_sale_capacity c
             join flash_sale_capacity_movement_checkpoint cp on cp.capacity_id = c.id
             join flash_sale_purchase_attempt a on a.campaign_id = ?
             left join flash_sale_capacity_movement m
               on m.attempt_id = a.id and m.kind = 'hold'
            where c.allocation_policy_id = ?
            group by cp.opening_held_quantity, c.held_quantity,
                     a.hold_movement_activation_id`,
          [campaignId, provisioned.policy.id]
        )) as Array<Record<string, unknown>>
        expect(evidence).toHaveLength(1)
        expect(
          Number(evidence[0].opening_held) + Number(evidence[0].hold_delta)
        ).toBe(2)
        expect(evidence[0].materialized_held).toBe(2)
        expect({
          opening_held: evidence[0].opening_held,
          hold_movements: evidence[0].hold_movements,
          bound: evidence[0].hold_movement_activation_id !== null,
        }).toEqual({ opening_held: 0, hold_movements: 1, bound: true })
      } finally {
        await workers.close()
      }
    })

    it("serializes concurrent active Provision and duplicate replay into one valid root", async () => {
      const activated = await service.activateAllocationMovementLedger({})
      const campaignId = unique("provision")
      const command = provisionCommand(campaignId, [`${campaignId}-item`])
      const workers = await fleet()
      try {
        const holder = await workers.executeUntilFailpoint(
          0,
          { kind: "provision_allocation", command },
          "after_provision_campaign_lock"
        )
        const contender = workers.executeOn(1, [
          { kind: "provision_allocation", command },
        ])
        void contender.catch(() => undefined)
        await waitForLockWait(
          workers.applicationName(0),
          workers.applicationName(1),
          "duplicate Provision contender"
        )
        await expect(workers.crash(0)).resolves.toEqual({
          kill_issued: true,
          exited_after_kill: true,
        })
        await expect(holder.result).rejects.toThrow()
        const provisioned = fulfilled((await contender)[0])
        expect(provisioned.replayed).toBe(false)
        expect(
          fulfilled(
            (await workers.executeOn(1, [
              { kind: "provision_allocation", command },
            ]))[0]
          )
        ).toMatchObject({
          replayed: true,
          policy_id: provisioned.policy_id,
          capacity_ids: provisioned.capacity_ids,
        })
        await expect(
          service.activateAllocationMovementLedger({})
        ).resolves.toMatchObject({
          activation_id: activated.activation_id,
          checkpoint_count: 1,
          replayed: true,
        })
        expect(
          await execute(
            `select
              (select count(*)::int from flash_sale_allocation_policy
                where campaign_id = ?) as policies,
              (select count(*)::int from flash_sale_capacity
                where allocation_policy_id = ?) as capacities,
              (select count(*)::int from flash_sale_capacity_movement_checkpoint cp
                join flash_sale_capacity c on c.id = cp.capacity_id
               where c.allocation_policy_id = ?) as checkpoints,
              (select count(*)::int from flash_sale_capacity_movement_checkpoint cp
                join flash_sale_capacity c on c.id = cp.capacity_id
               where c.allocation_policy_id = ? and cp.checkpoint_kind = 'provision') as provision_checkpoints,
              (select count(*)::int from flash_sale_capacity_movement_control) as controls`,
            [
              campaignId,
              provisioned.policy_id,
              provisioned.policy_id,
              provisioned.policy_id,
            ]
          )
        ).toEqual([
          {
            policies: 1,
            capacities: 1,
            checkpoints: 1,
            provision_checkpoints: 1,
            controls: 1,
          },
        ])
      } finally {
        await workers.close()
      }
    })

    it("linearizes first activation against first Provision with one valid checkpoint kind", async () => {
      const campaignId = unique("activation-provision-campaign")
      const command = provisionCommand(campaignId, [`${campaignId}-item`])
      const workers = await fleet()
      try {
        const holder = await workers.executeUntilFailpoint(
          0,
          { kind: "activate_movement_ledger", command: {} },
          "after_movement_ledger_exclusive_lock"
        )
        const contender = workers.executeOn(1, [
          { kind: "provision_allocation", command },
        ])
        void contender.catch(() => undefined)
        await waitForLockWait(
          workers.applicationName(0),
          workers.applicationName(1),
          "first Provision contender"
        )
        await expect(workers.crash(0)).resolves.toEqual({
          kill_issued: true,
          exited_after_kill: true,
        })
        await expect(holder.result).rejects.toThrow()
        const provision = fulfilled((await contender)[0])
        expect(provision.replayed).toBe(false)
        const activation = fulfilled(
          (await workers.executeOn(1, [
            { kind: "activate_movement_ledger", command: {} },
          ]))[0]
        )
        expect(activation.replayed).toBe(false)
        expect(
          fulfilled(
            (await workers.executeOn(1, [
              { kind: "provision_allocation", command },
            ]))[0]
          )
        ).toMatchObject({
          replayed: true,
          policy_id: provision.policy_id,
          capacity_ids: provision.capacity_ids,
        })
        await expect(
          service.activateAllocationMovementLedger({})
        ).resolves.toMatchObject({
          activation_id: activation.activation_id,
          checkpoint_count: 1,
          replayed: true,
        })
        const checkpoints = (await execute(
          `select checkpoint_kind, activated_at, required_after,
                  (activated_at = required_after) as equal_cutover_time,
                  (activated_at >= required_after) as valid_time
             from flash_sale_capacity_movement_checkpoint cp
             cross join flash_sale_capacity_movement_control ctl`
        )) as Array<Record<string, unknown>>
        expect(checkpoints).toHaveLength(1)
        expect(checkpoints[0].checkpoint_kind).toBe(
          CapacityMovementCheckpointKind.CUTOVER
        )
        expect(checkpoints[0].valid_time).toBe(true)
        expect(checkpoints[0].equal_cutover_time).toBe(true)
        expect(
          await execute(
            `select
              (select count(*)::int from flash_sale_capacity) as capacities,
              (select count(*)::int from flash_sale_capacity_movement_checkpoint) as checkpoints,
              (select count(*)::int from flash_sale_capacity_movement) as movements`
          )
        ).toEqual([{ capacities: 1, checkpoints: 1, movements: 0 }])
      } finally {
        await workers.close()
      }
    })
  },
})
