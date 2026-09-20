import { createHash } from "crypto"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import * as path from "path"
import {
  AllocationCommandErrorCode,
  ClaimAndHoldQuotaCommand,
} from "../application"
import {
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
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import FlashSaleAllocationModuleService from "../service"
import { AllocationWorkerFleet } from "./multiprocess/harness"
import {
  MultiprocessOperation,
  MultiprocessResult,
} from "./multiprocess/protocol"

const fullRun = process.env.FLASH_SALE_MULTIPROCESS_FULL === "1"
const rounds = fullRun ? 10 : 1
const workerCount = fullRun ? 4 : 2

jest.setTimeout(fullRun ? 900_000 : 180_000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
type InvariantSnapshot = {
  bad_capacity: number
  bad_subject: number
  capacity_held_mismatch: number
  capacity_consumed_mismatch: number
  subject_held_mismatch: number
  subject_consumed_mismatch: number
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  // This suite owns a separate database because its child processes outlive
  // the parent runner's normal single-process connection lifecycle.
  dbName: "medusa-flash-sale-allocation-multiprocess",
  moduleModels: [
    AllocationCampaignFence,
    AllocationPolicy,
    Capacity,
    PurchaseAttempt,
    AllocationHold,
    SubjectAllocation,
  ],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ MikroOrmWrapper, dbConfig, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    async function seedItems(
      label: string,
      quantities: Readonly<Record<string, number>>,
      limit: number
    ): Promise<{ campaignId: string }> {
      const campaignId = `mp-campaign-${label}`
      const policyId = `mp-policy-${label}`
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 minute',
                 now() + interval '30 minutes', 300, ?, 1)`,
        [
          policyId,
          campaignId,
          digest(`configuration-${label}`),
          AllocationPolicyState.OPEN,
          limit,
        ]
      )
      for (const [itemId, quantity] of Object.entries(quantities)) {
        await execute(
          `insert into flash_sale_capacity
            (id, allocation_policy_id, campaign_item_id, shard_no, state,
             granted_quantity, held_quantity, consumed_quantity, rules_version,
             version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
           values (?, ?, ?, 0, ?, ?, 0, 0, 1, 1,
             jsonb_build_object('value', ?::text, 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20))`,
          [
            `mp-capacity-${label}-${itemId}`,
            policyId,
            itemId,
            CapacityState.OPEN,
            quantity,
            quantity,
          ]
        )
      }
      return { campaignId }
    }

    const seed = (label: string, quantity: number, limit: number) =>
      seedItems(label, { item: quantity }, limit)

    function command(
      campaignId: string,
      subjectId: string,
      key: string
    ): ClaimAndHoldQuotaCommand {
      return {
        campaign_id: campaignId,
        subject_id: subjectId,
        cart_id: `cart-${key}`,
        idempotency_key_hash: digest(key),
        expected_rules_version: 1,
        items: [{ campaign_item_id: "item", quantity: 1 }],
      }
    }

    const claimOperations = (
      commands: readonly ClaimAndHoldQuotaCommand[]
    ): readonly MultiprocessOperation[] =>
      commands.map((claimCommand) => ({
        kind: "claim_and_hold",
        command: claimCommand,
      }))

    async function invariantSnapshot(campaignId: string) {
      const rows = (await execute(
        `select
          (select count(*) from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
           where p.campaign_id = ? and
             (c.held_quantity < 0 or c.consumed_quantity < 0 or
              c.held_quantity + c.consumed_quantity > c.granted_quantity))::int
            as bad_capacity,
          (select count(*) from flash_sale_subject_allocation s
           where s.campaign_id = ? and
             (s.held_quantity < 0 or s.consumed_quantity < 0 or
              s.held_quantity + s.consumed_quantity > s.limit_quantity))::int
            as bad_subject,
          (select count(*) from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
           where p.campaign_id = ? and c.held_quantity != coalesce((
             select sum(h.quantity) from flash_sale_allocation_hold h
             where h.capacity_id = c.id and h.state = 'held'), 0))::int
            as capacity_held_mismatch,
          (select count(*) from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
           where p.campaign_id = ? and c.consumed_quantity != coalesce((
             select sum(h.quantity) from flash_sale_allocation_hold h
             where h.capacity_id = c.id and h.state = 'consumed'), 0))::int
            as capacity_consumed_mismatch,
          (select count(*) from flash_sale_subject_allocation s
           where s.campaign_id = ? and s.held_quantity != coalesce((
             select sum(h.quantity) from flash_sale_allocation_hold h
             join flash_sale_purchase_attempt a on a.id = h.attempt_id
             where a.campaign_id = s.campaign_id and a.subject_id = s.subject_id
               and h.state = 'held'), 0))::int as subject_held_mismatch,
          (select count(*) from flash_sale_subject_allocation s
           where s.campaign_id = ? and s.consumed_quantity != coalesce((
             select sum(h.quantity) from flash_sale_allocation_hold h
             join flash_sale_purchase_attempt a on a.id = h.attempt_id
             where a.campaign_id = s.campaign_id and a.subject_id = s.subject_id
               and h.state = 'consumed'), 0))::int as subject_consumed_mismatch`,
        [campaignId, campaignId, campaignId, campaignId, campaignId, campaignId]
      )) as InvariantSnapshot[]
      expect(rows).toEqual([
        {
          bad_capacity: 0,
          bad_subject: 0,
          capacity_held_mismatch: 0,
          capacity_consumed_mismatch: 0,
          subject_held_mismatch: 0,
          subject_consumed_mismatch: 0,
        },
      ])
    }

    async function allocationTotals(campaignId: string) {
      return (await execute(
        `select
          (select count(*) from flash_sale_purchase_attempt
            where campaign_id = ?)::int as attempts,
          (select count(*) from flash_sale_allocation_hold h
            join flash_sale_purchase_attempt a on a.id = h.attempt_id
            where a.campaign_id = ?)::int as holds,
          (select coalesce(sum(c.held_quantity), 0)
             from flash_sale_capacity c
             join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
            where p.campaign_id = ?)::int as capacity_held,
          (select coalesce(sum(c.consumed_quantity), 0)
             from flash_sale_capacity c
             join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
            where p.campaign_id = ?)::int as capacity_consumed`,
        [campaignId, campaignId, campaignId, campaignId]
      )) as Array<{
        attempts: number
        holds: number
        capacity_held: number
        capacity_consumed: number
      }>
    }

    const fulfilled = (result: MultiprocessResult) =>
      result.outcome === "fulfilled"

    function expectAllFulfilled(
      results: readonly MultiprocessResult[],
      scenario: string
    ) {
      const failures = results.filter((result) => !fulfilled(result))
      if (failures.length > 0) {
        throw new Error(
          `${scenario} returned ${
            failures.length
          } worker failure(s): ${JSON.stringify(failures.slice(0, 10))}`
        )
      }
    }

    it(`preserves allocation invariants across ${workerCount} Node processes for ${rounds} round(s)`, async () => {
      const fleet = await AllocationWorkerFleet.create(
        dbConfig.clientUrl,
        dbConfig.schema ?? "public",
        workerCount
      )
      try {
        for (let round = 1; round <= rounds; round++) {
          const quota = await seed(`${round}-quota`, 50, 1)
          const quotaResults = await fleet.execute(
            claimOperations(
              Array.from({ length: 500 }, (_, index) =>
                command(
                  quota.campaignId,
                  `quota-subject-${index}`,
                  `${round}-quota-key-${index}`
                )
              )
            )
          )
          expect(
            quotaResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.status === "held"
            )
          ).toHaveLength(50)
          expect(
            quotaResults.filter(
              (result) =>
                result.outcome === "fulfilled" &&
                result.status === "rejected" &&
                result.error_code ===
                  AllocationCommandErrorCode.CAPACITY_EXHAUSTED
            )
          ).toHaveLength(450)
          expectAllFulfilled(quotaResults, `round ${round} quota 50/500`)
          await invariantSnapshot(quota.campaignId)

          const sameKey = await seed(`${round}-same-key`, 20, 1)
          const sameCommand = command(
            sameKey.campaignId,
            "same-key-subject",
            `${round}-same-key`
          )
          const sameResults = await fleet.execute(
            claimOperations(Array.from({ length: 20 }, () => sameCommand))
          )
          expectAllFulfilled(sameResults, `round ${round} same-key replay`)
          expect(
            new Set(
              sameResults.flatMap((result) =>
                result.outcome === "fulfilled" ? [result.attempt_id] : []
              )
            ).size
          ).toBe(1)
          expect(
            sameResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.replayed === false
            )
          ).toHaveLength(1)
          await invariantSnapshot(sameKey.campaignId)

          const subjectLimit = await seed(`${round}-subject-limit`, 20, 1)
          const subjectResults = await fleet.execute(
            claimOperations(
              Array.from({ length: 20 }, (_, index) =>
                command(
                  subjectLimit.campaignId,
                  "limited-subject",
                  `${round}-subject-key-${index}`
                )
              )
            )
          )
          expectAllFulfilled(subjectResults, `round ${round} subject limit one`)
          expect(
            subjectResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.status === "held"
            )
          ).toHaveLength(1)
          expect(
            subjectResults.filter(
              (result) =>
                result.outcome === "fulfilled" &&
                result.status === "rejected" &&
                result.error_code ===
                  AllocationCommandErrorCode.PURCHASE_LIMIT_EXCEEDED
            )
          ).toHaveLength(19)
          await invariantSnapshot(subjectLimit.campaignId)

          const settlement = await seed(`${round}-settlement`, 1, 1)
          const held = await fleet.execute(
            claimOperations([
              command(
                settlement.campaignId,
                "settlement-subject",
                `${round}-settlement-key`
              ),
            ])
          )
          expect(held[0]).toMatchObject({
            outcome: "fulfilled",
            status: "held",
          })
          if (held[0].outcome !== "fulfilled") {
            throw new Error("Settlement fixture was not held")
          }
          const attemptId = held[0].attempt_id
          const settlementCommand = {
            attempt_id: attemptId,
            settlement_id: `${round}-settlement-command`,
          }
          await service.beginQuotaSettlement(settlementCommand)
          const settlementResults = await fleet.execute(
            Array.from(
              { length: 40 },
              (_, index): MultiprocessOperation => ({
                kind:
                  index % 2 === 0 ? "consume_settlement" : "release_settlement",
                command: settlementCommand,
              })
            )
          )
          const terminalStates = new Set(
            settlementResults.flatMap((result) =>
              result.outcome === "fulfilled" ? [result.attempt_state] : []
            )
          )
          expect(terminalStates.size).toBe(1)
          const terminalState = [...terminalStates][0]
          expect([
            PurchaseAttemptState.QUOTA_CONSUMED,
            PurchaseAttemptState.QUOTA_RELEASED,
          ]).toContain(terminalState)
          expect(
            settlementResults.filter(
              (result) =>
                result.outcome === "rejected" &&
                result.error_code ===
                  AllocationCommandErrorCode.ATTEMPT_STATE_CONFLICT
            )
          ).toHaveLength(20)
          expect(
            settlementResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.replayed === false
            )
          ).toHaveLength(1)
          expect(
            settlementResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.replayed === true
            )
          ).toHaveLength(19)
          await invariantSnapshot(settlement.campaignId)

          if (fullRun) {
            const conflicting = await seed(`${round}-different-request`, 10, 2)
            const sharedKey = `${round}-different-request-key`
            const requestA = command(
              conflicting.campaignId,
              "different-request-subject",
              sharedKey
            )
            const requestB: ClaimAndHoldQuotaCommand = {
              ...requestA,
              cart_id: `cart-${sharedKey}-different`,
              items: [{ campaign_item_id: "item", quantity: 2 }],
            }
            const conflictResults = await fleet.execute(
              claimOperations(
                Array.from({ length: 20 }, (_, index) =>
                  index % 2 === 0 ? requestA : requestB
                )
              )
            )
            const conflictWinners = conflictResults.filter(
              (result) =>
                result.outcome === "fulfilled" && result.status === "held"
            )
            expect(conflictWinners).toHaveLength(10)
            expect(
              new Set(
                conflictWinners.flatMap((result) =>
                  result.outcome === "fulfilled" ? [result.attempt_id] : []
                )
              ).size
            ).toBe(1)
            expect(
              conflictResults.filter(
                (result) =>
                  result.outcome === "rejected" &&
                  result.error_code ===
                    AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT
              )
            ).toHaveLength(10)
            const [conflictTotals] = await allocationTotals(
              conflicting.campaignId
            )
            expect(conflictTotals).toMatchObject({
              attempts: 1,
              holds: 1,
              capacity_consumed: 0,
            })
            expect([1, 2]).toContain(conflictTotals.capacity_held)
            await invariantSnapshot(conflicting.campaignId)

            const multiItem = await seedItems(
              `${round}-multi-item`,
              { A: 10, B: 1 },
              10
            )
            const multiItemCommand: ClaimAndHoldQuotaCommand = {
              ...command(
                multiItem.campaignId,
                "multi-item-subject",
                `${round}-multi-item-key`
              ),
              items: [
                { campaign_item_id: "A", quantity: 2 },
                { campaign_item_id: "B", quantity: 2 },
              ],
            }
            const [multiItemResult] = await fleet.execute(
              claimOperations([multiItemCommand])
            )
            expect(multiItemResult).toMatchObject({
              outcome: "fulfilled",
              status: "rejected",
              error_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
            })
            expect(await allocationTotals(multiItem.campaignId)).toEqual([
              {
                attempts: 1,
                holds: 0,
                capacity_held: 0,
                capacity_consumed: 0,
              },
            ])
            await invariantSnapshot(multiItem.campaignId)

            const reverseOrder = await seedItems(
              `${round}-reverse-order`,
              { A: 1, B: 1 },
              2
            )
            const forward = {
              ...command(
                reverseOrder.campaignId,
                "forward-subject",
                `${round}-forward-key`
              ),
              items: [
                { campaign_item_id: "A", quantity: 1 },
                { campaign_item_id: "B", quantity: 1 },
              ],
            }
            const reverse = {
              ...command(
                reverseOrder.campaignId,
                "reverse-subject",
                `${round}-reverse-key`
              ),
              items: [
                { campaign_item_id: "B", quantity: 1 },
                { campaign_item_id: "A", quantity: 1 },
              ],
            }
            const reverseResults = await fleet.execute(
              claimOperations([forward, reverse])
            )
            expectAllFulfilled(
              reverseResults,
              `round ${round} reverse item order`
            )
            expect(
              reverseResults.filter(
                (result) =>
                  result.outcome === "fulfilled" && result.status === "held"
              )
            ).toHaveLength(1)
            expect(
              reverseResults.filter(
                (result) =>
                  result.outcome === "fulfilled" &&
                  result.status === "rejected" &&
                  result.error_code ===
                    AllocationCommandErrorCode.CAPACITY_EXHAUSTED
              )
            ).toHaveLength(1)
            await invariantSnapshot(reverseOrder.campaignId)

            const consumeReplay = await seed(`${round}-consume-replay`, 1, 1)
            const [consumeHeld] = await fleet.execute(
              claimOperations([
                command(
                  consumeReplay.campaignId,
                  "consume-replay-subject",
                  `${round}-consume-replay-key`
                ),
              ])
            )
            if (
              consumeHeld.outcome !== "fulfilled" ||
              consumeHeld.status !== "held"
            ) {
              throw new Error("Consume replay fixture was not held")
            }
            const consumeSettlement = {
              attempt_id: consumeHeld.attempt_id,
              settlement_id: `${round}-consume-replay-settlement`,
            }
            await service.beginQuotaSettlement(consumeSettlement)
            const consumeResults = await fleet.execute(
              Array.from(
                { length: 20 },
                (): MultiprocessOperation => ({
                  kind: "consume_settlement",
                  command: consumeSettlement,
                })
              )
            )
            expectAllFulfilled(consumeResults, `round ${round} consume replay`)
            expect(
              consumeResults.filter(
                (result) => result.outcome === "fulfilled" && !result.replayed
              )
            ).toHaveLength(1)
            expect(
              consumeResults.filter(
                (result) => result.outcome === "fulfilled" && result.replayed
              )
            ).toHaveLength(19)
            expect(
              consumeResults.every(
                (result) =>
                  result.outcome === "fulfilled" &&
                  result.attempt_state ===
                    PurchaseAttemptState.QUOTA_CONSUMED &&
                  result.hold_states.every((state) => state === "consumed")
              )
            ).toBe(true)
            await invariantSnapshot(consumeReplay.campaignId)

            const releaseReplay = await seed(`${round}-release-replay`, 1, 1)
            const [releaseHeld] = await fleet.execute(
              claimOperations([
                command(
                  releaseReplay.campaignId,
                  "release-replay-subject",
                  `${round}-release-replay-key`
                ),
              ])
            )
            if (
              releaseHeld.outcome !== "fulfilled" ||
              releaseHeld.status !== "held"
            ) {
              throw new Error("Release replay fixture was not held")
            }
            const releaseSettlement = {
              attempt_id: releaseHeld.attempt_id,
              settlement_id: `${round}-release-replay-settlement`,
            }
            await service.beginQuotaSettlement(releaseSettlement)
            const releaseResults = await fleet.execute(
              Array.from(
                { length: 20 },
                (): MultiprocessOperation => ({
                  kind: "release_settlement",
                  command: releaseSettlement,
                })
              )
            )
            expectAllFulfilled(releaseResults, `round ${round} release replay`)
            expect(
              releaseResults.filter(
                (result) => result.outcome === "fulfilled" && !result.replayed
              )
            ).toHaveLength(1)
            expect(
              releaseResults.filter(
                (result) => result.outcome === "fulfilled" && result.replayed
              )
            ).toHaveLength(19)
            expect(
              releaseResults.every(
                (result) =>
                  result.outcome === "fulfilled" &&
                  result.attempt_state ===
                    PurchaseAttemptState.QUOTA_RELEASED &&
                  result.hold_states.every((state) => state === "released")
              )
            ).toBe(true)
            await invariantSnapshot(releaseReplay.campaignId)

            const expiryCount = fullRun ? 80 : 20
            const expiry = await seed(`${round}-expiry-workers`, expiryCount, 1)
            const expiryHeld = await fleet.execute(
              claimOperations(
                Array.from({ length: expiryCount }, (_, index) =>
                  command(
                    expiry.campaignId,
                    `expiry-subject-${round}-${index}`,
                    `${round}-expiry-key-${index}`
                  )
                )
              )
            )
            expect(
              expiryHeld.every(
                (result) =>
                  result.outcome === "fulfilled" && result.status === "held"
              )
            ).toBe(true)
            await execute(
              `update flash_sale_purchase_attempt
                  set expires_at = now() - interval '1 second'
                where campaign_id = ?`,
              [expiry.campaignId]
            )
            await execute(
              `update flash_sale_allocation_hold h
                  set expires_at = now() - interval '1 second'
                 from flash_sale_purchase_attempt a
                where h.attempt_id = a.id and a.campaign_id = ?`,
              [expiry.campaignId]
            )
            const expiryResults = await fleet.execute(
              Array.from(
                { length: workerCount },
                (): MultiprocessOperation => ({
                  kind: "expire_due",
                  command: { limit: expiryCount },
                })
              )
            )
            expectAllFulfilled(expiryResults, `round ${round} expiry workers`)
            const expiredIds = expiryResults.flatMap((result) =>
              result.outcome === "fulfilled" ? result.attempt_ids ?? [] : []
            )
            expect(expiredIds).toHaveLength(expiryCount)
            expect(new Set(expiredIds).size).toBe(expiryCount)
            expect(
              expiryResults.reduce(
                (sum, result) =>
                  sum +
                  (result.outcome === "fulfilled" ? result.expired ?? 0 : 0),
                0
              )
            ).toBe(expiryCount)
            expect(
              expiryResults.reduce(
                (sum, result) =>
                  sum +
                  (result.outcome === "fulfilled" ? result.conflicted ?? 0 : 0),
                0
              )
            ).toBe(0)
            expect(
              expiryResults.reduce(
                (sum, result) =>
                  sum +
                  (result.outcome === "fulfilled" ? result.failed ?? 0 : 0),
                0
              )
            ).toBe(0)
            expect(
              await execute(
                `select state, count(*)::int as count
                   from flash_sale_purchase_attempt
                  where campaign_id = ? group by state`,
                [expiry.campaignId]
              )
            ).toEqual([
              { state: PurchaseAttemptState.QUOTA_EXPIRED, count: expiryCount },
            ])
            await invariantSnapshot(expiry.campaignId)
          }
        }
      } finally {
        await fleet.close()
      }
    })
  },
})
