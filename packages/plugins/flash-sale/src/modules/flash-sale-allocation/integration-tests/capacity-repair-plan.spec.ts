import { createHash } from "crypto"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import * as path from "path"
import {
  ProvisionAllocationCommand,
  createAllocationConfigurationHash,
  prepareDryRunCapacityRepairCommand,
} from "../application"
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
  CapacityRepairAction,
  CapacityRepairIdentity,
  CapacityRepairRun,
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import FlashSaleAllocationModuleService from "../service"
import {
  MovementCheckpointRow,
  calculateMovementCheckpointDigest,
  PostgresCapacityRepairPlanStore,
} from "../persistence"
import { FlashSalePluginModule } from "../../../types"

jest.setTimeout(180_000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const unique = (label: string) => `${label}-repair-${process.pid}-${++sequence}`
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-capacity-repair-plan",
  moduleModels: [
    AllocationCampaignFence,
    AllocationOutboxControl,
    AllocationOutboxEvent,
    AllocationPolicy,
    Capacity,
    CapacityMovement,
    CapacityMovementCheckpoint,
    CapacityMovementControl,
    CapacityRepairAction,
    CapacityRepairIdentity,
    CapacityRepairRun,
    PurchaseAttempt,
    AllocationHold,
    SubjectAllocation,
  ],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ MikroOrmWrapper, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    function command(campaignId: string): ProvisionAllocationCommand {
      const snapshot = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 100,
        items: [
          { campaign_item_id: `${campaignId}-a`, quota: 100 },
          { campaign_item_id: `${campaignId}-b`, quota: 100 },
        ],
      }
      return {
        ...snapshot,
        configuration_hash: createAllocationConfigurationHash(snapshot),
      }
    }

    const dryRun = (identity: string, campaignId?: string) =>
      service.dryRunCapacityRepair({
        request_id: identity,
        campaign_id: campaignId,
        actor: "operator-1",
        reason: "capacity reconciliation dry run",
        ticket: "INC-3C",
      })

    async function businessSnapshot(): Promise<Record<string, string | null>> {
      const tables = [
        "flash_sale_allocation_policy",
        "flash_sale_capacity",
        "flash_sale_capacity_movement_checkpoint",
        "flash_sale_capacity_movement_control",
        "flash_sale_purchase_attempt",
        "flash_sale_allocation_hold",
        "flash_sale_subject_allocation",
        "flash_sale_capacity_movement",
        "flash_sale_allocation_outbox_event",
        "flash_sale_allocation_outbox_control",
      ]
      const snapshot: Record<string, string | null> = {}
      for (const table of tables) {
        const rows = (await execute(
          `select coalesce(jsonb_agg(to_jsonb(source) order by source.id), '[]'::jsonb)::text as snapshot
             from ${table} source`
        )) as Array<{ snapshot: string | null }>
        snapshot[table] = rows[0]?.snapshot ?? null
      }
      return snapshot
    }

    async function waitForAdvisoryBlock(
      holderApplicationName: string,
      waiterApplicationName: string
    ): Promise<{ holder_pid: number; waiter_pid: number }> {
      const deadline = Date.now() + 5_000
      for (;;) {
        const rows = (await execute(
          `select holder.pid as holder_pid, waiter.pid as waiter_pid,
                  waiter.wait_event_type,
                  pg_blocking_pids(waiter.pid) as blockers,
                  bool_or(
                    holder_lock.granted and not waiter_lock.granted
                    and holder_lock.locktype = 'advisory'
                    and waiter_lock.locktype = 'advisory'
                    and holder_lock.database is not distinct from waiter_lock.database
                    and holder_lock.classid is not distinct from waiter_lock.classid
                    and holder_lock.objid is not distinct from waiter_lock.objid
                    and holder_lock.objsubid is not distinct from waiter_lock.objsubid
                    and holder_lock.mode = waiter_lock.mode
                  ) as exact_lock_tuple
             from pg_stat_activity holder
             join pg_stat_activity waiter on true
             join pg_locks holder_lock on holder_lock.pid = holder.pid
             join pg_locks waiter_lock on waiter_lock.pid = waiter.pid
            where holder.application_name = ? and waiter.application_name = ?
            group by holder.pid, waiter.pid, waiter.wait_event_type`,
          [holderApplicationName, waiterApplicationName]
        )) as Array<{
          holder_pid: number
          waiter_pid: number
          wait_event_type: string | null
          blockers: number[]
          exact_lock_tuple: boolean
        }>
        const match = rows.find(
          (row) =>
            row.wait_event_type === "Lock" &&
            row.exact_lock_tuple === true &&
            row.blockers.includes(row.holder_pid)
        )
        if (match) return match
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for exact repair advisory lock evidence")
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    async function safeFixture(label: string) {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique(label)
      const provisioned = await service.provisionAllocation(command(campaignId))
      const capacityId = provisioned.capacities[0].id
      await execute(
        `update flash_sale_capacity
            set held_quantity = 1,
                raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
          where id = ?`,
        [capacityId]
      )
      return { campaignId, capacityId }
    }

    async function refreshCheckpointDigest() {
      const checkpoints = (await execute(
        `select id, activation_id, capacity_id, campaign_item_id, checkpoint_kind,
                shard_no, opening_granted_quantity, opening_available_quantity,
                opening_held_quantity, opening_consumed_quantity, capacity_version,
                activated_at,
                raw_opening_granted_quantity::text as raw_opening_granted_quantity,
                raw_opening_available_quantity::text as raw_opening_available_quantity,
                raw_opening_held_quantity::text as raw_opening_held_quantity,
                raw_opening_consumed_quantity::text as raw_opening_consumed_quantity,
                deleted_at
           from flash_sale_capacity_movement_checkpoint order by capacity_id, id`
      )) as MovementCheckpointRow[]
      await execute(
        `update flash_sale_capacity_movement_control set checkpoint_digest = ?`,
        [calculateMovementCheckpointDigest(checkpoints, 2)]
      )
    }

    it("persists a safe immutable plan without changing business or ledger rows", async () => {
      const fixture = await safeFixture("safe")
      const before = await businessSnapshot()
      const result = await dryRun(unique("request"), fixture.campaignId)
      expect(result).toMatchObject({
        disposition: "fresh",
        status: "planned",
        classification: "safe_repair",
        actions: [
          expect.objectContaining({
            capacity_id: fixture.capacityId,
            before_held_quantity: "1",
            expected_held_quantity: "0",
            status: "proposed",
          }),
        ],
      })
      expect(await businessSnapshot()).toEqual(before)
    })

    it("returns not_activated and persists no Action", async () => {
      const result = await dryRun(unique("not-activated"))
      expect(result).toMatchObject({
        disposition: "fresh",
        status: "not_activated",
        classification: null,
        actions: [],
      })
    })

    it("persists multi-capacity BigInt evidence without Number coercion", async () => {
      const huge = "900719925474099300000"
      const held = "900719925474099299999"
      await service.activateAllocationMovementLedger({})
      const campaignId = unique("bigint")
      const provisioned = await service.provisionAllocation(command(campaignId))
      const capacityIds = provisioned.capacities.map((row) => row.id)
      await execute(
        `update flash_sale_capacity
            set granted_quantity = ?::numeric,
                held_quantity = ?::numeric,
                raw_granted_quantity = jsonb_build_object('value', ?, 'precision', 20),
                raw_held_quantity = jsonb_build_object('value', ?, 'precision', 20)
          where id in (?, ?)`,
        [huge, held, huge, held, capacityIds[0], capacityIds[1]]
      )
      await execute(
        `update flash_sale_capacity_movement_checkpoint
            set opening_granted_quantity = ?::numeric,
                opening_available_quantity = ?::numeric,
                raw_opening_granted_quantity = jsonb_build_object('value', ?, 'precision', 20),
                raw_opening_available_quantity = jsonb_build_object('value', ?, 'precision', 20)
          where capacity_id in (?, ?)`,
        [huge, huge, huge, huge, capacityIds[0], capacityIds[1]]
      )
      await refreshCheckpointDigest()
      const result = await dryRun(unique("bigint-request"), campaignId)
      expect(result.status).toBe("planned")
      expect(result.actions).toHaveLength(2)
      expect(result.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            before_granted_quantity: huge,
            before_held_quantity: held,
            expected_granted_quantity: huge,
            expected_held_quantity: "0",
          }),
        ])
      )
    })

    it("persists every Action and full evidence beyond the public sample limit", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique("full-evidence")
      const items = Array.from({ length: 105 }, (_, index) => ({
        campaign_item_id: `${campaignId}-item-${String(index).padStart(3, "0")}`,
        quota: 100,
      }))
      const snapshot = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 100,
        items,
      }
      await service.provisionAllocation({
        ...snapshot,
        configuration_hash: createAllocationConfigurationHash(snapshot),
      })
      await execute(
        `update flash_sale_capacity capacity
            set held_quantity = 1,
                raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
           from flash_sale_allocation_policy policy
          where capacity.allocation_policy_id = policy.id
            and policy.campaign_id = ?`,
        [campaignId]
      )
      const result = await dryRun(unique("full-evidence-request"), campaignId)
      expect(result.actions).toHaveLength(105)
      const rows = (await execute(
        `select issue_count,
                jsonb_array_length(issue_manifest) as issue_manifest_count,
                jsonb_array_length(evidence_manifest #> '{physical,capacities}') as capacity_count,
                jsonb_array_length(evidence_manifest #> '{projection,expected_capacities}') as expected_count,
                (select count(*)::integer from flash_sale_capacity_repair_action where run_id = ?) as action_count
           from flash_sale_capacity_repair_run where id = ?`,
        [result.run_id, result.run_id]
      )) as Array<Record<string, number>>
      expect(rows).toEqual([
        expect.objectContaining({
          issue_count: 105,
          issue_manifest_count: 105,
          capacity_count: 105,
          expected_count: 105,
          action_count: 105,
        }),
      ])
    })

    it("records root corruption as manual-required without a fake Action", async () => {
      await service.activateAllocationMovementLedger({})
      await service.provisionAllocation(command(unique("manual")))
      await execute(
        `update flash_sale_capacity_movement_control set checkpoint_digest = ?`,
        ["0".repeat(64)]
      )
      await expect(dryRun(unique("manual-request"))).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        actions: [],
      })
    })

    it("replays exactly and rejects command or evidence drift", async () => {
      const fixture = await safeFixture("replay")
      const request = unique("replay-request")
      const fresh = await dryRun(request, fixture.campaignId)
      const replay = await dryRun(request, fixture.campaignId)
      expect(replay).toMatchObject({
        disposition: "replay",
        run_id: fresh.run_id,
        evidence_digest: fresh.evidence_digest,
      })
      await expect(
        service.dryRunCapacityRepair({
          request_id: request,
          campaign_id: fixture.campaignId,
          actor: "operator-1",
          reason: "different reason",
          ticket: "INC-3C",
        })
      ).rejects.toMatchObject({
        code: "REPAIR_PLAN_INVARIANT_VIOLATION",
      })
      await execute(
        `update flash_sale_capacity
            set held_quantity = 2,
                raw_held_quantity = jsonb_build_object('value', '2', 'precision', 20)
          where id = ?`,
        [fixture.capacityId]
      )
      await expect(dryRun(request, fixture.campaignId)).rejects.toMatchObject({
        code: "REPAIR_PLAN_INVARIANT_VIOLATION",
      })
    })

    it.each(["softdelete", "missing", "drift", "extra"])(
      "fails %s physical Action replay closed",
      async (tamper) => {
        const fixture = await safeFixture(`action-${tamper}`)
        const request = unique(`action-request-${tamper}`)
        const fresh = await dryRun(request, fixture.campaignId)
        if (tamper === "softdelete") {
          await execute(
            `update flash_sale_capacity_repair_action set deleted_at = now() where run_id = ?`,
            [fresh.run_id]
          )
        } else if (tamper === "missing") {
          await execute(`delete from flash_sale_capacity_repair_action where run_id = ?`, [fresh.run_id])
        } else if (tamper === "drift") {
          await execute(
            `update flash_sale_capacity_repair_action set before_held_quantity = '9' where run_id = ?`,
            [fresh.run_id]
          )
        } else {
          await execute(
            `insert into flash_sale_capacity_repair_action
              (id, run_id, capacity_id, before_granted_quantity,
               before_held_quantity, before_consumed_quantity,
               before_raw_granted_quantity, before_raw_held_quantity,
               before_raw_consumed_quantity, expected_granted_quantity,
               expected_held_quantity, expected_consumed_quantity,
               expected_raw_granted_quantity, expected_raw_held_quantity,
               expected_raw_consumed_quantity, issue_codes, classification,
               evidence_digest, status)
             select ?, run_id, 'extra-capacity', before_granted_quantity,
                    before_held_quantity, before_consumed_quantity,
                    before_raw_granted_quantity, before_raw_held_quantity,
                    before_raw_consumed_quantity, expected_granted_quantity,
                    expected_held_quantity, expected_consumed_quantity,
                    expected_raw_granted_quantity, expected_raw_held_quantity,
                    expected_raw_consumed_quantity, issue_codes, classification,
                    evidence_digest, status
               from flash_sale_capacity_repair_action where run_id = ? limit 1`,
            [`fsrepact_${digest(unique("extra")).slice(0, 26)}`, fresh.run_id]
          )
        }
        await expect(dryRun(request, fixture.campaignId)).rejects.toMatchObject({
          code: "REPAIR_PLAN_INVARIANT_VIOLATION",
        })
      }
    )

    it.each(["softdelete", "issue-drift"])(
      "fails %s physical Run replay closed",
      async (tamper) => {
        const fixture = await safeFixture(`run-${tamper}`)
        const request = unique(`run-request-${tamper}`)
        const fresh = await dryRun(request, fixture.campaignId)
        if (tamper === "softdelete") {
          await execute(
            `update flash_sale_capacity_repair_run set deleted_at = now() where id = ?`,
            [fresh.run_id]
          )
        } else {
          await execute(
            `update flash_sale_capacity_repair_run set issue_codes = '["tampered"]'::jsonb where id = ?`,
            [fresh.run_id]
          )
        }
        await expect(dryRun(request, fixture.campaignId)).rejects.toMatchObject({
          code: "REPAIR_PLAN_INVARIANT_VIOLATION",
        })
      }
    )

    it.each([
      ["registry-id", "update flash_sale_capacity_repair_identity set id = id || '-tampered' where run_id = ?"],
      ["run-created-at", "update flash_sale_capacity_repair_run set created_at = created_at + interval '1 second' where id = ?"],
      ["action-updated-at", "update flash_sale_capacity_repair_action set updated_at = updated_at + interval '1 second' where run_id = ?"],
    ])("fails %s audit-field replay closed", async (_label, sql) => {
      const fixture = await safeFixture(`audit-field-${_label}`)
      const request = unique(`audit-field-request-${_label}`)
      const fresh = await dryRun(request, fixture.campaignId)
      await execute(sql, [fresh.run_id])
      await expect(dryRun(request, fixture.campaignId)).rejects.toMatchObject({
        code: "REPAIR_PLAN_INVARIANT_VIOLATION",
      })
    })

    it("detects a hard-deleted Run through the independent identity registry", async () => {
      const fixture = await safeFixture("hard-delete-run")
      const request = unique("hard-delete-run-request")
      const fresh = await dryRun(request, fixture.campaignId)
      await execute(`delete from flash_sale_capacity_repair_action where run_id = ?`, [
        fresh.run_id,
      ])
      await execute(`delete from flash_sale_capacity_repair_run where id = ?`, [
        fresh.run_id,
      ])
      await expect(dryRun(request, fixture.campaignId)).rejects.toMatchObject({
        code: "REPAIR_PLAN_INVARIANT_VIOLATION",
      })
      expect(
        await execute(
          `select count(*)::integer as count
             from flash_sale_capacity_repair_identity where run_id = ?`,
          [fresh.run_id]
        )
      ).toEqual([{ count: 1 }])
    })

    it("proves an identical contender waits on the exact advisory lock tuple", async () => {
      const fixture = await safeFixture("concurrent")
      const request = unique("concurrent-request")
      const prepared = prepareDryRunCapacityRepairCommand({
        request_id: request,
        campaign_id: fixture.campaignId,
        actor: "operator-1",
        reason: "capacity reconciliation dry run",
        ticket: "INC-3C",
      })
      const holderName = unique("repair-holder")
      const waiterName = unique("repair-waiter")
      let releaseHolder!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      let holderReached!: () => void
      const reached = new Promise<void>((resolve) => {
        holderReached = resolve
      })
      const holder = new PostgresCapacityRepairPlanStore(
        new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() }),
        {
          application_name: holderName,
          after_session_lock: async () => {
            holderReached()
            await holderGate
          },
        }
      )
      const waiter = new PostgresCapacityRepairPlanStore(
        new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() }),
        { application_name: waiterName }
      )
      const first = holder.dryRunCapacityRepair(prepared)
      await reached
      const second = waiter.dryRunCapacityRepair(prepared)
      let lockEvidence: { holder_pid: number; waiter_pid: number }
      try {
        lockEvidence = await waitForAdvisoryBlock(holderName, waiterName)
      } finally {
        releaseHolder()
      }
      const results = await Promise.all([first, second])
      expect(results.map((row) => row.disposition).sort()).toEqual([
        "fresh",
        "replay",
      ])
      expect(new Set(results.map((row) => row.run_id))).toHaveProperty("size", 1)
      expect(
        await execute(
          `select
             (select count(*)::integer from flash_sale_capacity_repair_identity where run_id = ?) as identities,
             (select count(*)::integer from flash_sale_capacity_repair_run where id = ?) as runs,
             (select count(*)::integer from pg_stat_activity where application_name in (?, ?)) as named_sessions,
             (select count(*)::integer from pg_locks where locktype = 'advisory' and pid in (?, ?)) as residual_locks`,
          [
            results[0].run_id,
            results[0].run_id,
            holderName,
            waiterName,
            lockEvidence.holder_pid,
            lockEvidence.waiter_pid,
          ]
        )
      ).toEqual([
        { identities: 1, runs: 1, named_sessions: 0, residual_locks: 0 },
      ])
    })

    it("bounds lock wait and leaves the pinned connection reusable", async () => {
      const fixture = await safeFixture("lock-timeout")
      const request = unique("lock-timeout-request")
      const command = {
        request_id: request,
        campaign_id: fixture.campaignId,
        actor: "operator-1",
        reason: "capacity reconciliation dry run",
        ticket: "INC-3C",
      }
      const prepared = prepareDryRunCapacityRepairCommand(command)
      const holderName = unique("timeout-holder")
      const waiterName = unique("timeout-waiter")
      let releaseHolder!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      let holderReached!: () => void
      const reached = new Promise<void>((resolve) => {
        holderReached = resolve
      })
      const holder = new PostgresCapacityRepairPlanStore(
        new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() }),
        {
          application_name: holderName,
          after_session_lock: async () => {
            holderReached()
            await holderGate
          },
        }
      )
      const waiter = new PostgresCapacityRepairPlanStore(
        new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() }),
        { application_name: waiterName }
      )
      const first = holder.dryRunCapacityRepair(prepared)
      await reached
      const timeoutPrepared = prepareDryRunCapacityRepairCommand({
        ...command,
        statement_timeout_ms: 100,
      })
      try {
        await expect(waiter.dryRunCapacityRepair(timeoutPrepared)).rejects.toThrow()
      } finally {
        releaseHolder()
      }
      const fresh = await first
      await expect(waiter.dryRunCapacityRepair(prepared)).resolves.toMatchObject({
        disposition: "replay",
        run_id: fresh.run_id,
      })
      expect(
        await execute(
          `select count(*)::integer as count
             from pg_stat_activity where application_name in (?, ?)`,
          [holderName, waiterName]
        )
      ).toEqual([{ count: 0 }])
    })

    it("blocks generated Run and Action CRUD", async () => {
      await expect((service as any).createCapacityRepairRuns({})).rejects.toThrow(
        "Direct allocation CRUD is disabled"
      )
      await expect((service as any).createCapacityRepairActions({})).rejects.toThrow(
        "Direct allocation CRUD is disabled"
      )
      await expect(
        (service as any).createCapacityRepairIdentities({})
      ).rejects.toThrow("Direct allocation CRUD is disabled")
    })
  },
})
