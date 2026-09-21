import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
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
import FlashSaleAllocationModuleService from "../service"

jest.setTimeout(240000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (label: string) => `${label}-settle-${process.pid}-${++sequence}`
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

    async function heldFixture(quantity = 3) {
      const campaignId = id("campaign")
      const subjectId = id("subject")
      const itemId = id("item")
      const policyId = id("fsapol")
      const capacityId = id("fscap")
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 minute',
                 now() + interval '10 minutes', 300, 100, 1)`,
        [policyId, campaignId, "d".repeat(64), AllocationPolicyState.OPEN]
      )
      await execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values (?, ?, ?, 0, ?, 100, 0, 0, 1, 1,
           jsonb_build_object('value', '100', 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20))`,
        [capacityId, policyId, itemId, CapacityState.OPEN]
      )
      const command: ClaimAndHoldQuotaCommand = {
        campaign_id: campaignId,
        subject_id: subjectId,
        cart_id: id("cart"),
        idempotency_key_hash: hash(sequence + 1000),
        expected_rules_version: 1,
        items: [{ campaign_item_id: itemId, quantity }],
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
        capacityId,
        quantity,
      }
    }

    async function snapshot(attemptId: string) {
      return (await execute(
        `select a.state as attempt_state, a.version::int as attempt_version,
                a.terminal_at is not null as attempt_resolved,
                a.settlement_id,
                a.settlement_started_at is not null as settlement_started,
                h.state as hold_state, h.version::int as hold_version,
                h.resolved_at is not null as hold_resolved,
                c.held_quantity::int as capacity_held,
                c.consumed_quantity::int as capacity_consumed,
                (c.raw_held_quantity->>'value')::int as raw_capacity_held,
                (c.raw_consumed_quantity->>'value')::int as raw_capacity_consumed,
                s.held_quantity::int as subject_held,
                s.consumed_quantity::int as subject_consumed,
                (s.raw_held_quantity->>'value')::int as raw_subject_held,
                (s.raw_consumed_quantity->>'value')::int as raw_subject_consumed
           from flash_sale_purchase_attempt a
           join flash_sale_allocation_hold h on h.attempt_id = a.id
           join flash_sale_capacity c on c.id = h.capacity_id
           join flash_sale_subject_allocation s
             on s.campaign_id = a.campaign_id and s.subject_id = a.subject_id
          where a.id = ?`,
        [attemptId]
      )) as Array<Record<string, unknown>>
    }

    describe("quota settlement", () => {
      it("does not expose direct held-to-consumed or ambiguous release commands", () => {
        expect(service).not.toHaveProperty("consumeQuota")
        expect(service).not.toHaveProperty("releaseQuota")
        expect(service).toHaveProperty("cancelHeldQuota")
        expect(service).toHaveProperty("beginQuotaSettlement")
        expect(service).toHaveProperty("consumeQuotaSettlement")
        expect(service).toHaveProperty("releaseQuotaSettlement")
      })

      it("begins one durable settlement and authorizes only its exact identity", async () => {
        const fixture = await heldFixture(3)
        const command = {
          attempt_id: fixture.attemptId,
          settlement_id: id("settlement"),
        }
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            service.beginQuotaSettlement(command)
          )
        )
        expect(results.filter((result) => !result.replayed)).toHaveLength(1)
        expect(results.filter((result) => result.replayed)).toHaveLength(19)
        expect(
          results.every(
            (result) => result.attempt.settlement_id === command.settlement_id
          )
        ).toBe(true)
        await expect(
          service.authorizeQuotaSettlement(command)
        ).resolves.toMatchObject({
          replayed: true,
          attempt: {
            state: PurchaseAttemptState.QUOTA_COMMITTING,
            settlement_id: command.settlement_id,
          },
          holds: [{ state: AllocationHoldState.HELD }],
        })
        await expect(
          service.beginQuotaSettlement({
            ...command,
            settlement_id: id("different-settlement"),
          })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        })
        await expect(
          service.authorizeQuotaSettlement({
            ...command,
            settlement_id: id("wrong-settlement"),
          })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        })
        await expect(
          service.cancelHeldQuota({ attempt_id: fixture.attemptId })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        })
        expect(await snapshot(fixture.attemptId)).toEqual([
          expect.objectContaining({
            attempt_state: PurchaseAttemptState.QUOTA_COMMITTING,
            attempt_version: 3,
            settlement_id: command.settlement_id,
            settlement_started: true,
            hold_state: AllocationHoldState.HELD,
            capacity_held: 3,
            capacity_consumed: 0,
            subject_held: 3,
            subject_consumed: 0,
          }),
        ])
      })

      it.each(["consume", "release"] as const)(
        "%s settlement migrates counters once and binds terminal replay to settlement_id",
        async (disposition) => {
          const fixture = await heldFixture(4)
          const command = {
            attempt_id: fixture.attemptId,
            settlement_id: id("settlement"),
          }
          await service.beginQuotaSettlement(command)
          const settle = () =>
            disposition === "consume"
              ? service.consumeQuotaSettlement(command)
              : service.releaseQuotaSettlement(command)
          const results = await Promise.all(Array.from({ length: 20 }, settle))
          expect(results.filter((result) => !result.replayed)).toHaveLength(1)
          expect(results.filter((result) => result.replayed)).toHaveLength(19)
          await expect(settle()).resolves.toMatchObject({ replayed: true })
          const wrongCommand = {
            ...command,
            settlement_id: id("wrong-settlement"),
          }
          await expect(
            disposition === "consume"
              ? service.consumeQuotaSettlement(wrongCommand)
              : service.releaseQuotaSettlement(wrongCommand)
          ).rejects.toMatchObject({
            code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
          })
          await expect(
            service.authorizeQuotaSettlement(command)
          ).rejects.toMatchObject({
            code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
          })

          expect(await snapshot(fixture.attemptId)).toEqual([
            expect.objectContaining({
              attempt_state:
                disposition === "consume"
                  ? PurchaseAttemptState.QUOTA_CONSUMED
                  : PurchaseAttemptState.QUOTA_RELEASED,
              attempt_version: 4,
              attempt_resolved: true,
              settlement_id: command.settlement_id,
              settlement_started: true,
              hold_state:
                disposition === "consume"
                  ? AllocationHoldState.CONSUMED
                  : AllocationHoldState.RELEASED,
              capacity_held: 0,
              capacity_consumed: disposition === "consume" ? 4 : 0,
              raw_capacity_held: 0,
              raw_capacity_consumed: disposition === "consume" ? 4 : 0,
              subject_held: 0,
              subject_consumed: disposition === "consume" ? 4 : 0,
              raw_subject_held: 0,
              raw_subject_consumed: disposition === "consume" ? 4 : 0,
            }),
          ])
        }
      )

      it("cancels an unexpired held quota once and safely replays", async () => {
        const fixture = await heldFixture(4)
        const first = await service.cancelHeldQuota({
          attempt_id: fixture.attemptId,
        })
        expect(first).toMatchObject({ replayed: false })
        const concurrent = await Promise.all(
          Array.from({ length: 20 }, () =>
            service.cancelHeldQuota({ attempt_id: fixture.attemptId })
          )
        )
        expect(concurrent.every((result) => result.replayed)).toBe(true)
        expect(
          await service.cancelHeldQuota({ attempt_id: fixture.attemptId })
        ).toMatchObject({ replayed: true })
        expect(await snapshot(fixture.attemptId)).toEqual([
          expect.objectContaining({
            attempt_state: PurchaseAttemptState.QUOTA_RELEASED,
            attempt_version: 3,
            hold_state: AllocationHoldState.RELEASED,
            hold_version: 2,
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

      it("routes an expired held quota through expiry instead of cancellation", async () => {
        const fixture = await heldFixture(2)
        await execute(
          `update flash_sale_purchase_attempt
              set expires_at = now() - interval '1 second' where id = ?`,
          [fixture.attemptId]
        )
        await execute(
          `update flash_sale_allocation_hold
              set expires_at = now() - interval '1 second' where attempt_id = ?`,
          [fixture.attemptId]
        )
        await expect(
          service.cancelHeldQuota({ attempt_id: fixture.attemptId })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.HOLD_EXPIRED,
        })
        await expect(
          service.expireQuota({ attempt_id: fixture.attemptId })
        ).resolves.toMatchObject({
          replayed: false,
          attempt: { state: PurchaseAttemptState.QUOTA_EXPIRED },
        })
      })

      it("uses a fresh database clock after cancellation waits across expiry", async () => {
        const fixture = await heldFixture(2)
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
            await transaction.execute(
              `update flash_sale_allocation_hold
                  set expires_at = clock_timestamp() + interval '1 second'
                where attempt_id = ?`,
              [fixture.attemptId]
            )
            lockAcquired()
            await gate
          }
        )
        await acquired
        const cancellation = service.cancelHeldQuota({
          attempt_id: fixture.attemptId,
        })
        const assertion = expect(cancellation).rejects.toMatchObject({
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
        await expect(
          service.expireQuota({ attempt_id: fixture.attemptId })
        ).resolves.toMatchObject({
          attempt: { state: PurchaseAttemptState.QUOTA_EXPIRED },
        })
      })

      it("settles existing holds after their policy and capacity are closed", async () => {
        const consumed = await heldFixture(6)
        const released = await heldFixture(7)
        for (const fixture of [consumed, released]) {
          await execute(
            `update flash_sale_allocation_policy
                set state = 'closed', version = version + 1, updated_at = now()
              where id = ?`,
            [fixture.policyId]
          )
          await execute(
            `update flash_sale_capacity
                set state = 'closed', version = version + 1, updated_at = now()
              where id = ?`,
            [fixture.capacityId]
          )
        }

        const settlementCommand = {
          attempt_id: consumed.attemptId,
          settlement_id: id("closed-policy-settlement"),
        }
        await service.beginQuotaSettlement(settlementCommand)
        await expect(
          service.consumeQuotaSettlement(settlementCommand)
        ).resolves.toMatchObject({
          replayed: false,
          attempt: { state: PurchaseAttemptState.QUOTA_CONSUMED },
          holds: [{ state: AllocationHoldState.CONSUMED }],
        })
        await expect(
          service.cancelHeldQuota({ attempt_id: released.attemptId })
        ).resolves.toMatchObject({
          replayed: false,
          attempt: { state: PurchaseAttemptState.QUOTA_RELEASED },
          holds: [{ state: AllocationHoldState.RELEASED }],
        })
        expect(await snapshot(consumed.attemptId)).toEqual([
          expect.objectContaining({
            capacity_held: 0,
            capacity_consumed: 6,
            raw_capacity_held: 0,
            raw_capacity_consumed: 6,
            subject_held: 0,
            subject_consumed: 6,
            raw_subject_held: 0,
            raw_subject_consumed: 6,
          }),
        ])
        expect(await snapshot(released.attemptId)).toEqual([
          expect.objectContaining({
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

      it("allows exactly one terminal direction to win a 20 versus 20 race", async () => {
        const fixture = await heldFixture(5)
        const command = {
          attempt_id: fixture.attemptId,
          settlement_id: id("terminal-race"),
        }
        await service.beginQuotaSettlement(command)
        const calls = [
          ...Array.from({ length: 20 }, () => "consume" as const),
          ...Array.from({ length: 20 }, () => "release" as const),
        ].sort(() => Math.random() - 0.5)
        const results = await Promise.allSettled(
          calls.map((operation) =>
            operation === "consume"
              ? service.consumeQuotaSettlement(command)
              : service.releaseQuotaSettlement(command)
          )
        )
        const fulfilled = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof service.consumeQuotaSettlement>>
          > => result.status === "fulfilled"
        )
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )
        expect(fulfilled).toHaveLength(20)
        expect(rejected).toHaveLength(20)
        expect(
          rejected.every(
            (result) =>
              result.reason?.code ===
              AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT
          )
        ).toBe(true)
        const winner = fulfilled[0].value.attempt.state
        expect(
          fulfilled.every((result) => result.value.attempt.state === winner)
        ).toBe(true)

        const rows = await snapshot(fixture.attemptId)
        if (winner === PurchaseAttemptState.QUOTA_CONSUMED) {
          expect(rows).toEqual([
            expect.objectContaining({
              attempt_state: PurchaseAttemptState.QUOTA_CONSUMED,
              hold_state: AllocationHoldState.CONSUMED,
              capacity_held: 0,
              capacity_consumed: 5,
              subject_held: 0,
              subject_consumed: 5,
            }),
          ])
          await expect(
            service.releaseQuotaSettlement(command)
          ).rejects.toMatchObject({
            code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
          })
          await expect(
            service.consumeQuotaSettlement(command)
          ).resolves.toMatchObject({ replayed: true })
        } else {
          expect(rows).toEqual([
            expect.objectContaining({
              attempt_state: PurchaseAttemptState.QUOTA_RELEASED,
              hold_state: AllocationHoldState.RELEASED,
              capacity_held: 0,
              capacity_consumed: 0,
              subject_held: 0,
              subject_consumed: 0,
            }),
          ])
          await expect(
            service.consumeQuotaSettlement(command)
          ).rejects.toMatchObject({
            code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
          })
          await expect(
            service.releaseQuotaSettlement(command)
          ).resolves.toMatchObject({ replayed: true })
        }
      })

      it("rejects missing, illegal state and non-exact command shapes", async () => {
        await expect(
          service.consumeQuotaSettlement({
            attempt_id: "missing",
            settlement_id: "settlement-missing",
          })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        })
        await expect(
          service.cancelHeldQuota({
            attempt_id: "missing",
            raw_key: "must-not-cross-boundary",
          } as never)
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })

        const fixture = await heldFixture(1)
        await execute(
          `update flash_sale_purchase_attempt set state = ?, version = version + 1
            where id = ?`,
          [PurchaseAttemptState.PENDING, fixture.attemptId]
        )
        await expect(
          service.cancelHeldQuota({ attempt_id: fixture.attemptId })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        })
        await execute(
          `update flash_sale_purchase_attempt set state = ?, version = version + 1
            where id = ?`,
          [PurchaseAttemptState.QUOTA_REJECTED, fixture.attemptId]
        )
        await expect(
          service.beginQuotaSettlement({
            attempt_id: fixture.attemptId,
            settlement_id: id("illegal-state"),
          })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT,
        })
      })

      it("retries a capacity lock three times then rolls back without mutation", async () => {
        const fixture = await heldFixture(2)
        const command = {
          attempt_id: fixture.attemptId,
          settlement_id: id("locked-capacity"),
        }
        await service.beginQuotaSettlement(command)
        const before = await snapshot(fixture.attemptId)
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
            [fixture.capacityId]
          )
          lockAcquired()
          await gate
        })
        await acquired
        try {
          await expect(
            service.consumeQuotaSettlement(command)
          ).rejects.toMatchObject({
            code: AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
          })
        } finally {
          releaseLock()
          await blocker
        }
        expect(await snapshot(fixture.attemptId)).toEqual(before)
      })
    })
  },
})
