import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { AllocationCommandErrorCode, ClaimAttemptCommand } from "../application"
import {
  AllocationPolicyState,
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

jest.setTimeout(60000)

const CONFIGURATION_HASH = "c".repeat(64)
let fixtureSequence = 0

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>

const nextFixtureId = (label: string) => `${label}-${++fixtureSequence}`

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

    const seedPolicy = async (
      campaignId: string,
      overrides: {
        state?: AllocationPolicyState
        rulesVersion?: number
        startsAt?: Date
        endsAt?: Date
        holdTtlSeconds?: number
      } = {}
    ) => {
      const now = Date.now()
      const policy = {
        id: nextFixtureId("fsapol"),
        campaignId,
        state: overrides.state ?? AllocationPolicyState.OPEN,
        rulesVersion: overrides.rulesVersion ?? 1,
        startsAt: overrides.startsAt ?? new Date(now - 60_000),
        endsAt: overrides.endsAt ?? new Date(now + 600_000),
        holdTtlSeconds: overrides.holdTtlSeconds ?? 300,
      }

      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [
          policy.id,
          policy.campaignId,
          policy.rulesVersion,
          CONFIGURATION_HASH,
          policy.state,
          policy.startsAt,
          policy.endsAt,
          policy.holdTtlSeconds,
        ]
      )

      return policy
    }

    const makeCommand = (
      campaignId: string,
      overrides: Partial<ClaimAttemptCommand> = {}
    ): ClaimAttemptCommand => ({
      campaign_id: campaignId,
      subject_id: "subject-1",
      cart_id: "cart-1",
      idempotency_key_hash: "a".repeat(64),
      expected_rules_version: 1,
      items: [{ campaign_item_id: "item-1", quantity: 1 }],
      ...overrides,
    })

    const expectCommandError = async (
      promise: Promise<unknown>,
      code: AllocationCommandErrorCode
    ) => {
      await expect(promise).rejects.toMatchObject({ code })
    }

    describe("claimAttempt durable command", () => {
      it("claims once and caps expires_at at the policy end", async () => {
        const campaignId = nextFixtureId("campaign-first")
        const endsAt = new Date(Date.now() + 60_000)
        await seedPolicy(campaignId, {
          endsAt,
          holdTtlSeconds: 3600,
        })

        const result = await service.claimAttempt(makeCommand(campaignId))

        expect(result.replayed).toBe(false)
        expect(result.attempt).toEqual(
          expect.objectContaining({
            campaign_id: campaignId,
            state: PurchaseAttemptState.PENDING,
            rules_version: 1,
            version: 1,
          })
        )
        expect(result.attempt.expires_at).toEqual(endsAt)

        const rows = (await execute(
          `select count(*)::int as count
             from flash_sale_purchase_attempt
            where campaign_id = ?`,
          [campaignId]
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(1)
      })

      it("derives expires_at from the database clock when TTL is the limit", async () => {
        const campaignId = nextFixtureId("campaign-ttl")
        const ttlSeconds = 2
        const policy = await seedPolicy(campaignId, {
          endsAt: new Date(Date.now() + 600_000),
          holdTtlSeconds: ttlSeconds,
        })
        const beforeRows = (await execute(
          "select now() as database_now"
        )) as Array<{ database_now: Date | string }>

        const result = await service.claimAttempt(makeCommand(campaignId))

        const afterRows = (await execute(
          "select now() as database_now"
        )) as Array<{ database_now: Date | string }>
        const beforeExpiry =
          new Date(beforeRows[0].database_now).getTime() + ttlSeconds * 1000
        const afterExpiry =
          new Date(afterRows[0].database_now).getTime() + ttlSeconds * 1000

        expect(result.attempt.expires_at.getTime()).toBeGreaterThanOrEqual(
          beforeExpiry
        )
        expect(result.attempt.expires_at.getTime()).toBeLessThanOrEqual(
          afterExpiry
        )
        expect(result.attempt.expires_at.getTime()).toBeLessThan(
          policy.endsAt.getTime()
        )
      })

      it("replays the same request and rejects reuse for another request", async () => {
        const campaignId = nextFixtureId("campaign-serial")
        await seedPolicy(campaignId)
        const command = makeCommand(campaignId)

        const first = await service.claimAttempt(command)
        const replay = await service.claimAttempt(command)

        expect(replay).toEqual({ attempt: first.attempt, replayed: true })
        await expectCommandError(
          service.claimAttempt({
            ...command,
            items: [{ campaign_item_id: "item-1", quantity: 2 }],
          }),
          AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT
        )
      })

      it("replays a durable identity after its policy has closed", async () => {
        const campaignId = nextFixtureId("campaign-closed-replay")
        const policy = await seedPolicy(campaignId)
        const command = makeCommand(campaignId)
        const first = await service.claimAttempt(command)

        await execute(
          "update flash_sale_allocation_policy set state = ? where id = ?",
          [AllocationPolicyState.CLOSED, policy.id]
        )

        const replay = await service.claimAttempt(command)
        expect(replay).toEqual({ attempt: first.attempt, replayed: true })
      })

      it("replays a durable identity after its policy window has expired", async () => {
        const campaignId = nextFixtureId("campaign-expired-replay")
        const policy = await seedPolicy(campaignId)
        const command = makeCommand(campaignId)
        const first = await service.claimAttempt(command)

        await execute(
          `update flash_sale_allocation_policy
              set starts_at = now() - interval '2 minutes',
                  ends_at = now() - interval '1 minute'
            where id = ?`,
          [policy.id]
        )

        const replay = await service.claimAttempt(command)
        expect(replay).toEqual({ attempt: first.attempt, replayed: true })
      })

      it("converges 20 identical concurrent claims to one attempt", async () => {
        const campaignId = nextFixtureId("campaign-concurrent-same")
        await seedPolicy(campaignId)
        const command = makeCommand(campaignId)

        const results = await Promise.all(
          Array.from({ length: 20 }, () => service.claimAttempt(command))
        )

        expect(new Set(results.map((result) => result.attempt.id)).size).toBe(1)
        expect(results.filter((result) => !result.replayed)).toHaveLength(1)
        expect(results.filter((result) => result.replayed)).toHaveLength(19)
        const rows = (await execute(
          `select count(*)::int as count
             from flash_sale_purchase_attempt
            where campaign_id = ?`,
          [campaignId]
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(1)
      })

      it("stabilizes different concurrent requests on one idempotency winner", async () => {
        const campaignId = nextFixtureId("campaign-concurrent-different")
        await seedPolicy(campaignId)
        const base = makeCommand(campaignId)

        const outcomes = await Promise.allSettled(
          Array.from({ length: 20 }, (_, index) =>
            service.claimAttempt({
              ...base,
              items: [
                { campaign_item_id: "item-1", quantity: (index % 2) + 1 },
              ],
            })
          )
        )
        const fulfilled = outcomes.filter(
          (outcome) => outcome.status === "fulfilled"
        )
        const rejected = outcomes.filter(
          (outcome) => outcome.status === "rejected"
        )

        expect(fulfilled).toHaveLength(10)
        expect(rejected).toHaveLength(10)
        expect(
          new Set(
            fulfilled.map((outcome) =>
              outcome.status === "fulfilled" ? outcome.value.attempt.id : null
            )
          ).size
        ).toBe(1)
        for (const outcome of rejected) {
          if (outcome.status === "rejected") {
            expect(outcome.reason).toMatchObject({
              code: AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT,
            })
          }
        }
        const rows = (await execute(
          `select count(*)::int as count
             from flash_sale_purchase_attempt
            where campaign_id = ?`,
          [campaignId]
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(1)
      })

      it("allows independent null-cart attempts", async () => {
        const campaignId = nextFixtureId("campaign-null-cart")
        await seedPolicy(campaignId)

        const results = await Promise.all([
          service.claimAttempt(
            makeCommand(campaignId, {
              subject_id: "subject-null-1",
              cart_id: null,
              idempotency_key_hash: "1".repeat(64),
            })
          ),
          service.claimAttempt(
            makeCommand(campaignId, {
              subject_id: "subject-null-2",
              cart_id: null,
              idempotency_key_hash: "2".repeat(64),
            })
          ),
        ])

        expect(results.every((result) => !result.replayed)).toBe(true)
        expect(new Set(results.map((result) => result.attempt.id)).size).toBe(2)
      })

      it("returns stable policy boundary errors", async () => {
        const missingCampaign = nextFixtureId("campaign-missing")
        await expectCommandError(
          service.claimAttempt(makeCommand(missingCampaign)),
          AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE
        )

        const preparedCampaign = nextFixtureId("campaign-prepared")
        await seedPolicy(preparedCampaign, {
          state: AllocationPolicyState.PREPARED,
        })
        await expectCommandError(
          service.claimAttempt(makeCommand(preparedCampaign)),
          AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE
        )

        const futureCampaign = nextFixtureId("campaign-future")
        await seedPolicy(futureCampaign, {
          startsAt: new Date(Date.now() + 600_000),
          endsAt: new Date(Date.now() + 1_200_000),
        })
        await expectCommandError(
          service.claimAttempt(makeCommand(futureCampaign)),
          AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE
        )

        const staleCampaign = nextFixtureId("campaign-stale")
        await seedPolicy(staleCampaign, { rulesVersion: 2 })
        await expectCommandError(
          service.claimAttempt(makeCommand(staleCampaign)),
          AllocationCommandErrorCode.STALE_RULES_VERSION
        )
      })

      it("reports a live-cart conflict without aborting conflict inspection", async () => {
        const campaignId = nextFixtureId("campaign-cart")
        await seedPolicy(campaignId)
        await service.claimAttempt(
          makeCommand(campaignId, {
            subject_id: "subject-cart-1",
            cart_id: "shared-cart",
            idempotency_key_hash: "3".repeat(64),
          })
        )

        await expectCommandError(
          service.claimAttempt(
            makeCommand(campaignId, {
              subject_id: "subject-cart-2",
              cart_id: "shared-cart",
              idempotency_key_hash: "4".repeat(64),
            })
          ),
          AllocationCommandErrorCode.CART_ATTEMPT_CONFLICT
        )

        const rows = (await execute(
          `select count(*)::int as count
             from flash_sale_purchase_attempt
            where campaign_id = ?`,
          [campaignId]
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(1)
      })
    })
  },
})
