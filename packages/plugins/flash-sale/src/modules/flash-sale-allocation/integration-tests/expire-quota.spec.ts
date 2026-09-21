import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import path from "path"
import {
  AllocationCommandErrorCode,
  ClaimAndHoldQuotaCommand,
} from "../application"
import {
  AllocationHoldState,
  AllocationPolicyState,
  CapacityState,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../../../types"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationPolicy,
  Capacity,
  CapacityMovement,
  CapacityMovementCheckpoint,
  CapacityMovementControl,
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import { PostgresAllocationAttemptStore } from "../persistence"
import FlashSaleAllocationModuleService from "../service"

jest.setTimeout(240000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (label: string) => `${label}-expiry-${process.pid}-${++sequence}`
const hash = (value: number) => value.toString(16).padStart(64, "0")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation",
  moduleModels: [
    AllocationCampaignFence,
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
  testSuite: ({ MikroOrmWrapper, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    async function waitForBlockedAttemptCommand(manager: SqlEntityManager) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = (await manager.execute(
          `select exists(
             select 1 from pg_stat_activity
              where datname = current_database()
                and pid <> pg_backend_pid()
                and wait_event_type = 'Lock'
                and query like '%flash_sale_purchase_attempt%'
           ) as blocked`
        )) as Array<{ blocked: boolean }>
        if (rows[0]?.blocked) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("allocation command did not block on the attempt row")
    }

    async function heldFixture(quantities: readonly number[] = [3]) {
      const campaignId = id("campaign")
      const subjectId = id("subject")
      const policyId = id("fsapol")
      const itemIds = quantities.map(() => id("item"))
      const capacityIds = quantities.map(() => id("fscap"))
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 minute',
                 now() + interval '10 minutes', 300, 100, 1)`,
        [policyId, campaignId, "d".repeat(64), AllocationPolicyState.OPEN]
      )
      for (let index = 0; index < quantities.length; index++) {
        await execute(
          `insert into flash_sale_capacity
            (id, allocation_policy_id, campaign_item_id, shard_no, state,
             granted_quantity, held_quantity, consumed_quantity, rules_version,
             version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
           values (?, ?, ?, 0, ?, 100, 0, 0, 1, 1,
             jsonb_build_object('value', '100', 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20))`,
          [capacityIds[index], policyId, itemIds[index], CapacityState.OPEN]
        )
      }
      const command: ClaimAndHoldQuotaCommand = {
        campaign_id: campaignId,
        subject_id: subjectId,
        cart_id: id("cart"),
        idempotency_key_hash: hash(sequence + 2000),
        expected_rules_version: 1,
        items: quantities.map((quantity, index) => ({
          campaign_item_id: itemIds[index],
          quantity,
        })),
      }
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") {
        throw new Error(`Fixture unexpectedly rejected: ${held.error_code}`)
      }
      return {
        attemptId: held.attempt.id,
        campaignId,
        subjectId,
        policyId,
        capacityIds,
        quantities,
      }
    }

    async function makeDue(attemptId: string) {
      await execute(
        `update flash_sale_purchase_attempt
            set expires_at = now() - interval '1 second' where id = ?`,
        [attemptId]
      )
      await execute(
        `update flash_sale_allocation_hold
            set expires_at = now() - interval '1 second' where attempt_id = ?`,
        [attemptId]
      )
    }

    async function snapshot(attemptId: string) {
      return (await execute(
        `select a.state as attempt_state, a.version::int as attempt_version,
                a.terminal_at is not null as attempt_resolved,
                array_agg(h.state order by h.campaign_item_id) as hold_states,
                array_agg(h.version::int order by h.campaign_item_id) as hold_versions,
                bool_and(h.resolved_at is not null) as holds_resolved,
                sum(c.held_quantity)::int as capacity_held,
                sum(c.consumed_quantity)::int as capacity_consumed,
                sum((c.raw_held_quantity->>'value')::int)::int as raw_capacity_held,
                sum((c.raw_consumed_quantity->>'value')::int)::int as raw_capacity_consumed,
                s.held_quantity::int as subject_held,
                s.consumed_quantity::int as subject_consumed,
                (s.raw_held_quantity->>'value')::int as raw_subject_held,
                (s.raw_consumed_quantity->>'value')::int as raw_subject_consumed
           from flash_sale_purchase_attempt a
           join flash_sale_allocation_hold h on h.attempt_id = a.id
           join flash_sale_capacity c on c.id = h.capacity_id
           join flash_sale_subject_allocation s
             on s.campaign_id = a.campaign_id and s.subject_id = a.subject_id
          where a.id = ?
          group by a.id, s.id`,
        [attemptId]
      )) as Array<Record<string, unknown>>
    }

    describe("quota expiry", () => {
      it("uses the database clock and rejects a live hold with zero writes", async () => {
        const fixture = await heldFixture([2])
        const before = await snapshot(fixture.attemptId)
        await expect(
          service.expireQuota({ attempt_id: fixture.attemptId })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.HOLD_NOT_EXPIRED,
        })
        expect(await snapshot(fixture.attemptId)).toEqual(before)
      })

      it("expires a due multi-item hold atomically and replays twenty callers", async () => {
        const fixture = await heldFixture([2, 5])
        await makeDue(fixture.attemptId)
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            service.expireQuota({ attempt_id: fixture.attemptId })
          )
        )
        expect(results.filter((result) => !result.replayed)).toHaveLength(1)
        expect(results.filter((result) => result.replayed)).toHaveLength(19)
        expect(await snapshot(fixture.attemptId)).toEqual([
          expect.objectContaining({
            attempt_state: PurchaseAttemptState.QUOTA_EXPIRED,
            attempt_version: 3,
            attempt_resolved: true,
            hold_states: [
              AllocationHoldState.EXPIRED,
              AllocationHoldState.EXPIRED,
            ],
            hold_versions: [2, 2],
            holds_resolved: true,
            capacity_held: 0,
            capacity_consumed: 0,
            raw_capacity_held: 0,
            raw_capacity_consumed: 0,
            subject_held: 0,
            subject_consumed: 0,
            raw_subject_held: 0,
            raw_subject_consumed: 0,
          }),
        ])
      })

      it("keeps an already expired hold on the expiry path during cancellation races", async () => {
        const fixture = await heldFixture([4])
        await makeDue(fixture.attemptId)
        const results = await Promise.allSettled([
          ...Array.from({ length: 20 }, () =>
            service.expireQuota({ attempt_id: fixture.attemptId })
          ),
          ...Array.from({ length: 20 }, () =>
            service.cancelHeldQuota({ attempt_id: fixture.attemptId })
          ),
        ])
        const fulfilled = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof service.expireQuota>>
          > => result.status === "fulfilled"
        )
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )
        expect(fulfilled).toHaveLength(20)
        expect(rejected).toHaveLength(20)
        expect(
          rejected.every((result) =>
            [
              AllocationCommandErrorCode.HOLD_EXPIRED,
              AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
            ].includes(result.reason?.code)
          )
        ).toBe(true)
        expect(
          new Set(fulfilled.map((result) => result.value.attempt.state)).size
        ).toBe(1)
        const row = (await snapshot(fixture.attemptId))[0]
        expect(row.capacity_held).toBe(0)
        expect(row.subject_held).toBe(0)
        expect(row.capacity_consumed).toBe(0)
        expect(row.capacity_consumed).toBe(row.subject_consumed)
      })

      it("uses database time so an already expired hold cannot begin settlement", async () => {
        const fixture = await heldFixture([4])
        await makeDue(fixture.attemptId)
        const command = {
          attempt_id: fixture.attemptId,
          settlement_id: id("settlement"),
        }
        const results = await Promise.allSettled([
          ...Array.from({ length: 20 }, () =>
            service.beginQuotaSettlement(command)
          ),
          ...Array.from({ length: 20 }, () =>
            service.expireQuota({ attempt_id: fixture.attemptId })
          ),
        ])
        const fulfilled = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof service.expireQuota>>
          > => result.status === "fulfilled"
        )
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )
        expect(fulfilled).toHaveLength(20)
        expect(rejected).toHaveLength(20)
        expect(
          rejected.every((result) =>
            [
              AllocationCommandErrorCode.HOLD_EXPIRED,
              AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
            ].includes(result.reason?.code)
          )
        ).toBe(true)
        const winner = fulfilled[0].value.attempt.state
        expect(winner).toBe(PurchaseAttemptState.QUOTA_EXPIRED)
        expect(
          fulfilled.every((result) => result.value.attempt.state === winner)
        ).toBe(true)
        expect((await snapshot(fixture.attemptId))[0]).toMatchObject({
          attempt_state: PurchaseAttemptState.QUOTA_EXPIRED,
          capacity_held: 0,
          subject_held: 0,
        })
      })

      it("uses a fresh database clock after waiting across hold expiry", async () => {
        const fixture = await heldFixture([4])
        let releaseLock!: () => void
        let lockAcquired!: () => void
        const gate = new Promise<void>((resolve) => (releaseLock = resolve))
        const acquired = new Promise<void>(
          (resolve) => (lockAcquired = resolve)
        )
        const blocker = MikroOrmWrapper.forkManager().transactional(
          async (transaction) => {
            await transaction.execute(
              `update flash_sale_purchase_attempt
                  set expires_at = clock_timestamp() + interval '1 second'
                where id = ?`,
              [fixture.attemptId]
            )
            lockAcquired()
            await gate
          }
        )
        await acquired
        const begin = service.beginQuotaSettlement({
          attempt_id: fixture.attemptId,
          settlement_id: id("settlement"),
        })
        const assertion = expect(begin).rejects.toMatchObject({
          code: AllocationCommandErrorCode.HOLD_EXPIRED,
        })
        try {
          const observer = MikroOrmWrapper.forkManager()
          await waitForBlockedAttemptCommand(observer)
          await observer.execute("select pg_sleep(1.1)")
        } finally {
          releaseLock()
          await blocker
        }
        await assertion
        expect((await snapshot(fixture.attemptId))[0]).toMatchObject({
          attempt_state: PurchaseAttemptState.QUOTA_HELD,
          capacity_held: 4,
          capacity_consumed: 0,
        })
      })

      it("expires after policy and capacities are closed", async () => {
        const fixture = await heldFixture([6])
        await makeDue(fixture.attemptId)
        await execute(
          "update flash_sale_allocation_policy set state = 'closed' where id = ?",
          [fixture.policyId]
        )
        await execute(
          "update flash_sale_capacity set state = 'closed' where allocation_policy_id = ?",
          [fixture.policyId]
        )
        await expect(
          service.expireQuota({ attempt_id: fixture.attemptId })
        ).resolves.toMatchObject({
          replayed: false,
          attempt: { state: PurchaseAttemptState.QUOTA_EXPIRED },
        })
      })

      it("rolls back every counter and state after the expiry failpoint", async () => {
        const fixture = await heldFixture([2, 3])
        await makeDue(fixture.attemptId)
        const before = await snapshot(fixture.attemptId)
        const repository = new MikroOrmBaseRepository({
          manager: MikroOrmWrapper.forkManager(),
        })
        const store = new PostgresAllocationAttemptStore(repository, {
          hit: () => {
            throw new Error("injected during_expiry_release")
          },
        })
        await expect(
          store.expireQuota({ attempt_id: fixture.attemptId })
        ).rejects.toThrow("injected during_expiry_release")
        expect(await snapshot(fixture.attemptId)).toEqual(before)
      })

      it("processes due attempts in a finite bounded batch", async () => {
        const due = await Promise.all(
          Array.from({ length: 5 }, async () => {
            const fixture = await heldFixture([1])
            await makeDue(fixture.attemptId)
            return fixture
          })
        )
        const live = await heldFixture([1])
        await expect(
          service.expireDueQuota({ limit: 3 })
        ).resolves.toMatchObject({
          scanned: 3,
          expired: 3,
          conflicted: 0,
        })
        await expect(
          service.expireDueQuota({ limit: 10 })
        ).resolves.toMatchObject({
          scanned: 2,
          expired: 2,
          conflicted: 0,
        })
        const rows = (await execute(
          `select state, count(*)::int as count
             from flash_sale_purchase_attempt
            where id in (${due.map(() => "?").join(", ")})
            group by state order by state`,
          due.map((fixture) => fixture.attemptId)
        )) as Array<{ state: string; count: number }>
        expect(rows).toEqual([
          { state: PurchaseAttemptState.QUOTA_EXPIRED, count: 5 },
        ])
        expect((await snapshot(live.attemptId))[0].attempt_state).toBe(
          PurchaseAttemptState.QUOTA_HELD
        )
      })

      it("isolates an invariant-broken oldest attempt and continues the batch", async () => {
        const broken = await heldFixture([1])
        const healthy = await heldFixture([1])
        await makeDue(broken.attemptId)
        await makeDue(healthy.attemptId)
        await execute(
          `update flash_sale_purchase_attempt
              set expires_at = now() - interval '2 minutes' where id = ?`,
          [broken.attemptId]
        )
        await execute(
          "delete from flash_sale_allocation_hold where attempt_id = ?",
          [broken.attemptId]
        )

        await expect(service.expireDueQuota({ limit: 10 })).resolves.toEqual({
          scanned: 2,
          expired: 1,
          conflicted: 0,
          failed: 1,
          failures: [
            {
              attempt_id: broken.attemptId,
              error_code:
                AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION,
            },
          ],
          attempt_ids: [healthy.attemptId],
        })
        expect(
          await execute(
            "select state from flash_sale_purchase_attempt where id = ?",
            [broken.attemptId]
          )
        ).toEqual([{ state: PurchaseAttemptState.QUOTA_HELD }])
        expect((await snapshot(healthy.attemptId))[0]).toMatchObject({
          attempt_state: PurchaseAttemptState.QUOTA_EXPIRED,
          capacity_held: 0,
          subject_held: 0,
        })
      })

      it("isolates an oldest lock timeout after three retries and continues", async () => {
        const locked = await heldFixture([1])
        const healthy = await heldFixture([1])
        await makeDue(locked.attemptId)
        await makeDue(healthy.attemptId)
        await execute(
          `update flash_sale_purchase_attempt
              set expires_at = now() - interval '2 minutes' where id = ?`,
          [locked.attemptId]
        )
        let releaseLock!: () => void
        let lockAcquired!: () => void
        const gate = new Promise<void>((resolve) => (releaseLock = resolve))
        const acquired = new Promise<void>(
          (resolve) => (lockAcquired = resolve)
        )
        const manager = MikroOrmWrapper.forkManager()
        const blocker = manager.transactional(async (transaction) => {
          await transaction.execute(
            "select id from flash_sale_capacity where id = ? for update",
            [locked.capacityIds[0]]
          )
          lockAcquired()
          await gate
        })
        await acquired
        try {
          await expect(service.expireDueQuota({ limit: 10 })).resolves.toEqual({
            scanned: 2,
            expired: 1,
            conflicted: 0,
            failed: 1,
            failures: [
              {
                attempt_id: locked.attemptId,
                error_code: AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
              },
            ],
            attempt_ids: [healthy.attemptId],
          })
        } finally {
          releaseLock()
          await blocker
        }
        expect(
          await execute(
            "select state from flash_sale_purchase_attempt where id = ?",
            [locked.attemptId]
          )
        ).toEqual([{ state: PurchaseAttemptState.QUOTA_HELD }])
        expect((await snapshot(healthy.attemptId))[0].attempt_state).toBe(
          PurchaseAttemptState.QUOTA_EXPIRED
        )
      })
    })
  },
})
