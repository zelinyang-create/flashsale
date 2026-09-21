import { createHash } from "crypto"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import * as path from "path"
import {
  ApplyCapacityRepairCommand,
  capacityRepairActionSetDigest,
  createAllocationConfigurationHash,
  prepareApplyCapacityRepairCommand,
  RepairApprovalVerifier,
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
  CapacityRepairApplyAction,
  CapacityRepairApplyIdentity,
  CapacityRepairApplyRun,
  CapacityRepairIdentity,
  CapacityRepairRun,
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import {
  CapacityRepairApplyFaultInjector,
  PostgresCapacityRepairApplyStore,
} from "../persistence"
import FlashSaleAllocationModuleService from "../service"
import { FlashSalePluginModule } from "../../../types"

jest.setTimeout(180_000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const unique = (label: string) => `${label}-apply-${process.pid}-${++sequence}`
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-capacity-repair-apply",
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
    CapacityRepairApplyAction,
    CapacityRepairApplyIdentity,
    CapacityRepairApplyRun,
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

    async function fixture(label: string) {
      await service.activateAllocationMovementLedger({})
      const campaignId = unique(label)
      const snapshot = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 10,
        items: [{ campaign_item_id: `${campaignId}-item`, quota: 100 }],
      }
      const provisioned = await service.provisionAllocation({
        ...snapshot,
        configuration_hash: createAllocationConfigurationHash(snapshot),
      })
      await service.openAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
      await service.closeAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: 2,
      })
      const capacityId = provisioned.capacities[0].id
      await execute(
        `update flash_sale_capacity
            set held_quantity = 1,
                raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
          where id = ?`,
        [capacityId]
      )
      const plan = await service.dryRunCapacityRepair({
        request_id: unique("plan"),
        campaign_id: campaignId,
        actor: "repair-planner",
        reason: "repair held mirror drift",
        ticket: "INC-3D2",
      })
      expect(plan).toMatchObject({
        plan_schema_version: 2,
        status: "planned",
        classification: "safe_repair",
      })
      expect(plan.actions).toHaveLength(1)
      return { campaignId, capacityId, plan }
    }

    async function prepared(
      data: Awaited<ReturnType<typeof fixture>>,
      requestId: string,
      options: Readonly<{
        approval_jti?: string
        expires_at?: Date
      }> = {}
    ) {
      const actionIds = data.plan.actions.map((action) => action.id).sort()
      const actionSetDigest = capacityRepairActionSetDigest(
        data.plan.run_id,
        actionIds
      )
      const now = new Date()
      const command: ApplyCapacityRepairCommand = {
        request_id: requestId,
        plan_run_id: data.plan.run_id,
        expected_plan_evidence_digest: data.plan.evidence_digest,
        action_ids: actionIds,
        requester: "repair-requester",
        reason: "approved capacity repair",
        ticket: "INC-3D2",
        approval_credential: "opaque-capacity-repair-approval",
        approval_reference: "approval-reference-3d2",
        statement_timeout_ms: 5_000,
      }
      const verifier: RepairApprovalVerifier = {
        verify: async () => ({
          approver: "repair-approver",
          issuer: "approval.internal",
          audience: "flash-sale-repair",
          tenant: "tenant-1",
          jti: options.approval_jti ?? `approval-${requestId}`,
          issued_at: new Date(now.getTime() - 60_000),
          not_before: new Date(now.getTime() - 60_000),
          expires_at: options.expires_at ?? new Date(now.getTime() + 60_000),
          roles: ["repair-approver"],
          purpose: "capacity_repair_apply",
          permission_version: "repair-rbac-v1",
          approval_reference: command.approval_reference,
          plan_schema_version: 2,
          campaign_id: data.campaignId,
          plan_run_id: data.plan.run_id,
          plan_evidence_digest: data.plan.evidence_digest,
          ordered_action_set_digest: actionSetDigest,
        }),
      }
      return await prepareApplyCapacityRepairCommand(command, verifier, now)
    }

    function store(
      faultInjector?: CapacityRepairApplyFaultInjector,
      applicationName?: string
    ) {
      return new PostgresCapacityRepairApplyStore(
        new MikroOrmBaseRepository({ manager: MikroOrmWrapper.forkManager() }),
        {
          fault_injector: faultInjector,
          application_name: applicationName,
        }
      )
    }

    async function waitForLock(applicationName: string) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const rows = await execute(
          `select wait_event_type from pg_stat_activity
            where application_name = ? and wait_event_type = 'Lock'`,
          [applicationName]
        )
        if (rows.length > 0) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for ${applicationName} to block`)
    }

    it("atomically applies a safe Plan and exact-replays after response loss", async () => {
      const data = await fixture("fresh-replay")
      const input = await prepared(data, unique("request"))
      let failResponse = true
      const fault: CapacityRepairApplyFaultInjector = {
        hit: async (point) => {
          if (point === "after_commit_before_response" && failResponse) {
            failResponse = false
            throw new Error("simulated response loss")
          }
        },
      }
      await expect(store(fault).applyCapacityRepair(input)).rejects.toThrow(
        "simulated response loss"
      )
      await execute(
        `update flash_sale_allocation_outbox_event
            set status = 'published', attempt_count = 1, max_attempts = 3,
                published_at = now(), published_by = 'apply-test-publisher',
                published_lease_epoch = 1, updated_at = now()
          where aggregate_type = 'capacity_repair_apply'`
      )
      const replay = await store().applyCapacityRepair(input)
      expect(replay).toMatchObject({
        disposition: "replay",
        plan_run_id: data.plan.run_id,
        actions: [
          expect.objectContaining({
            capacity_id: data.capacityId,
            before_held_quantity: "1",
            after_held_quantity: "0",
          }),
        ],
      })
      expect(
        await execute(
          `select held_quantity::text as held,
                  raw_held_quantity->>'value' as raw_held,
                  version::text as version
             from flash_sale_capacity where id = ?`,
          [data.capacityId]
        )
      ).toEqual([{ held: "0", raw_held: "0", version: "4" }])
      expect(
        await execute(
          `select
             (select count(*)::integer from flash_sale_capacity_repair_apply_identity) as identities,
             (select count(*)::integer from flash_sale_capacity_repair_apply_run) as runs,
             (select count(*)::integer from flash_sale_capacity_repair_apply_action) as actions,
             (select count(*)::integer from flash_sale_allocation_outbox_event
               where aggregate_type = 'capacity_repair_apply') as outbox`
        )
      ).toEqual([{ identities: 1, runs: 1, actions: 1, outbox: 1 }])
    })

    it("rolls back Capacity, receipt, and outbox after the pre-commit failpoint", async () => {
      const data = await fixture("rollback")
      const input = await prepared(data, unique("request"))
      const before = await execute(
        `select held_quantity::text as held,
                raw_held_quantity->>'value' as raw_held,
                version::text as version
           from flash_sale_capacity where id = ?`,
        [data.capacityId]
      )
      await expect(
        store({
          hit: async (point) => {
            if (point === "after_outbox_before_commit") {
              throw new Error("simulated pre-commit failure")
            }
          },
        }).applyCapacityRepair(input)
      ).rejects.toThrow("simulated pre-commit failure")
      expect(
        await execute(
          `select held_quantity::text as held,
                  raw_held_quantity->>'value' as raw_held,
                  version::text as version
             from flash_sale_capacity where id = ?`,
          [data.capacityId]
        )
      ).toEqual(before)
      expect(
        await execute(
          `select
             (select count(*)::integer from flash_sale_capacity_repair_apply_identity) as identities,
             (select count(*)::integer from flash_sale_capacity_repair_apply_run) as runs,
             (select count(*)::integer from flash_sale_capacity_repair_apply_action) as actions,
             (select count(*)::integer from flash_sale_allocation_outbox_event
               where aggregate_type = 'capacity_repair_apply') as outbox`
        )
      ).toEqual([{ identities: 0, runs: 0, actions: 0, outbox: 0 }])
    })

    it("rejects a second request or approval JTI consuming the same Plan", async () => {
      const data = await fixture("conflict")
      const first = await prepared(data, unique("request"))
      await store().applyCapacityRepair(first)
      const second = await prepared(data, unique("different-request"))
      await expect(store().applyCapacityRepair(second)).rejects.toMatchObject({
        code: "REPAIR_APPLY_CONFLICT",
      })
      expect(
        await execute(
          `select count(*)::integer as runs
             from flash_sale_capacity_repair_apply_run`
        )
      ).toEqual([{ runs: 1 }])
    })

    it("serializes concurrent requests for one Plan and rejudges in a fresh snapshot", async () => {
      const data = await fixture("concurrent-plan")
      const first = await prepared(data, unique("request"))
      const second = await prepared(data, unique("request"))
      const holderName = unique("apply-holder")
      const waiterName = unique("apply-waiter")
      let reached!: () => void
      let release!: () => void
      const holderReached = new Promise<void>((resolve) => (reached = resolve))
      const holderGate = new Promise<void>((resolve) => (release = resolve))
      const firstApply = store(
        {
          hit: async (point) => {
            if (point === "after_business_locks") {
              reached()
              await holderGate
            }
          },
        },
        holderName
      ).applyCapacityRepair(first)
      await holderReached
      const secondApply = store(undefined, waiterName).applyCapacityRepair(
        second
      )
      try {
        await waitForLock(waiterName)
      } finally {
        release()
      }
      const results = await Promise.allSettled([firstApply, secondApply])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      const rejected = results.find((result) => result.status === "rejected")
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "REPAIR_APPLY_CONFLICT" },
      })
      expect(
        await execute(
          `select count(*)::integer as runs
             from flash_sale_capacity_repair_apply_run`
        )
      ).toEqual([{ runs: 1 }])
    })

    it("rejects a fresh Apply when Policy and Capacity are not both CLOSED", async () => {
      const data = await fixture("mixed-state")
      const input = await prepared(data, unique("request"))
      await execute(
        `update flash_sale_allocation_policy set state = 'open'
          where campaign_id = ?`,
        [data.campaignId]
      )
      await expect(store().applyCapacityRepair(input)).rejects.toMatchObject({
        code: "REPAIR_APPLY_INVARIANT_VIOLATION",
      })
      expect(
        await execute(
          `select count(*)::integer as runs
             from flash_sale_capacity_repair_apply_run`
        )
      ).toEqual([{ runs: 0 }])
    })

    it("rechecks approval expiry after waiting on the Campaign lock", async () => {
      const data = await fixture("approval-expiry")
      const expiresAt = new Date(Date.now() + 1_500)
      const input = await prepared(data, unique("request"), {
        expires_at: expiresAt,
      })
      let acquired!: () => void
      let release!: () => void
      const lockAcquired = new Promise<void>((resolve) => (acquired = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      const blocker = MikroOrmWrapper.forkManager().transactional(
        async (transaction) => {
          await transaction.execute(
            "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
            [`flash-sale-allocation-campaign:${data.campaignId}`]
          )
          acquired()
          await gate
        }
      )
      await lockAcquired
      const workerName = unique("approval-expiry-worker")
      const applying = store(undefined, workerName).applyCapacityRepair(input)
      try {
        await waitForLock(workerName)
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const rows = (await execute(
            "select clock_timestamp() >= ?::timestamptz as expired",
            [expiresAt.toISOString()]
          )) as Array<{ expired: boolean }>
          if (rows[0]?.expired) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } finally {
        release()
        await blocker
      }
      await expect(applying).rejects.toMatchObject({
        code: "REPAIR_APPLY_INVARIANT_VIOLATION",
      })
      expect(
        await execute(
          `select count(*)::integer as runs
             from flash_sale_capacity_repair_apply_run`
        )
      ).toEqual([{ runs: 0 }])
    })

    it("fails closed on post-Plan evidence drift without partial writes", async () => {
      const data = await fixture("evidence-drift")
      const input = await prepared(data, unique("request"))
      await execute(
        `update flash_sale_capacity
            set held_quantity = 2,
                raw_held_quantity = jsonb_build_object('value', '2', 'precision', 20)
          where id = ?`,
        [data.capacityId]
      )
      await expect(store().applyCapacityRepair(input)).rejects.toMatchObject({
        code: "REPAIR_PLAN_INVARIANT_VIOLATION",
      })
      expect(
        await execute(
          `select held_quantity::text as held,
                  version::text as version
             from flash_sale_capacity where id = ?`,
          [data.capacityId]
        )
      ).toEqual([{ held: "2", version: "3" }])
      expect(
        await execute(
          `select
             (select count(*)::integer from flash_sale_capacity_repair_apply_run) as runs,
             (select count(*)::integer from flash_sale_allocation_outbox_event
               where aggregate_type = 'capacity_repair_apply') as outbox`
        )
      ).toEqual([{ runs: 0, outbox: 0 }])
    })

    it("fails closed when an immutable receipt field is tampered", async () => {
      const data = await fixture("receipt-tamper")
      const input = await prepared(data, unique("request"))
      await store().applyCapacityRepair(input)
      await execute(
        `update flash_sale_capacity_repair_apply_action
            set after_held_quantity = '1', after_raw_held_quantity = '1'
          where plan_action_id = ?`,
        [data.plan.actions[0].id]
      )
      await expect(store().applyCapacityRepair(input)).rejects.toMatchObject({
        code: "REPAIR_APPLY_INVARIANT_VIOLATION",
      })
    })
  },
})
