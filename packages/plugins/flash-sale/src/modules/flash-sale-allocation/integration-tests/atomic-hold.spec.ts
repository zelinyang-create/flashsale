import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  AllocationCommandErrorCode,
  ClaimAndHoldQuotaCommand,
  HoldQuotaCommand,
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

jest.setTimeout(180000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (label: string) => `${label}-${++sequence}`
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
    PurchaseAttempt,
    AllocationHold,
    SubjectAllocation,
  ],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ MikroOrmWrapper, service }) => {
    const execute: Execute = async (sql, params = []) =>
      (await MikroOrmWrapper.forkManager().execute(sql, params)) as unknown[]

    async function seed(
      quantities: Record<string, number>,
      options: {
        limit?: number
        policyState?: AllocationPolicyState
        capacityState?: CapacityState
        rulesVersion?: number
      } = {}
    ) {
      const campaignId = id("hold-campaign")
      const policyId = id("fsapol")
      const rules = options.rulesVersion ?? 1
      const limit = options.limit ?? 100
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, ?, ?, ?, now() - interval '1 minute',
                 now() + interval '10 minutes', 300, ?, 1)`,
        [
          policyId,
          campaignId,
          rules,
          "c".repeat(64),
          options.policyState ?? AllocationPolicyState.OPEN,
          limit,
        ]
      )
      for (const [itemId, quantity] of Object.entries(quantities)) {
        await execute(
          `insert into flash_sale_capacity
            (id, allocation_policy_id, campaign_item_id, shard_no, state,
             granted_quantity, held_quantity, consumed_quantity, rules_version,
             version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
           values (?, ?, ?, 0, ?, ?, 0, 0, ?, 1,
             jsonb_build_object('value', ?::text, 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20),
             jsonb_build_object('value', '0', 'precision', 20))`,
          [
            id("fscap"),
            policyId,
            itemId,
            options.capacityState ?? CapacityState.OPEN,
            quantity,
            rules,
            quantity,
          ]
        )
      }
      return { campaignId, policyId, rules }
    }

    const command = (
      campaignId: string,
      subject: string,
      key: number,
      items: Array<{ campaign_item_id: string; quantity: number }>,
      rules = 1
    ): ClaimAndHoldQuotaCommand => ({
      campaign_id: campaignId,
      subject_id: subject,
      cart_id: `cart-${campaignId}-${subject}-${key}`,
      idempotency_key_hash: hash(key),
      expected_rules_version: rules,
      items,
    })

    async function invariantSnapshot(campaignId: string) {
      return (await execute(
        `select
          (select coalesce(sum(held_quantity), 0) from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
            where p.campaign_id = ?)::int as capacity_held,
          (select coalesce(sum(quantity), 0) from flash_sale_allocation_hold h
            join flash_sale_purchase_attempt a on a.id = h.attempt_id
            where a.campaign_id = ? and h.state = 'held')::int as hold_sum,
          (select count(*) from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
            where p.campaign_id = ? and
              (c.held_quantity < 0 or c.held_quantity + c.consumed_quantity > c.granted_quantity))::int as bad_capacity,
          (select count(*) from flash_sale_subject_allocation s
            where s.campaign_id = ? and
              (s.held_quantity < 0 or s.held_quantity + s.consumed_quantity > s.limit_quantity))::int as bad_subject,
          (select count(*) from flash_sale_subject_allocation s
            where s.campaign_id = ? and s.held_quantity != coalesce((
              select sum(h.quantity) from flash_sale_allocation_hold h
              join flash_sale_purchase_attempt a on a.id = h.attempt_id
              where a.campaign_id = s.campaign_id
                and a.subject_id = s.subject_id and h.state = 'held'
            ), 0))::int as subject_mismatch,
          ((select count(*) from flash_sale_capacity c
             join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
            where p.campaign_id = ?
              and (c.raw_held_quantity->>'value')::numeric != c.held_quantity) +
           (select count(*) from flash_sale_subject_allocation s
            where s.campaign_id = ?
              and (s.raw_held_quantity->>'value')::numeric != s.held_quantity) +
           (select count(*) from flash_sale_allocation_hold h
             join flash_sale_purchase_attempt a on a.id = h.attempt_id
            where a.campaign_id = ?
              and (h.raw_quantity->>'value')::numeric != h.quantity))::int as raw_mismatch`,
        [
          campaignId,
          campaignId,
          campaignId,
          campaignId,
          campaignId,
          campaignId,
          campaignId,
          campaignId,
        ]
      )) as Array<{
        capacity_held: number
        hold_sum: number
        bad_capacity: number
        bad_subject: number
        subject_mismatch: number
        raw_mismatch: number
      }>
    }

    describe("atomic quota hold", () => {
      it("holds exactly 50 of 500 distinct subjects without oversell", async () => {
        const { campaignId } = await seed({ item: 50 }, { limit: 1 })
        const results = await Promise.all(
          Array.from({ length: 500 }, (_, index) =>
            service.claimAndHoldQuota(
              command(campaignId, `subject-${index}`, index + 1, [
                { campaign_item_id: "item", quantity: 1 },
              ])
            )
          )
        )
        expect(
          results.filter((result) => result.status === "held")
        ).toHaveLength(50)
        const rejected = results.filter(
          (result) => result.status === "rejected"
        )
        expect(rejected).toHaveLength(450)
        expect(
          rejected.every(
            (result) =>
              result.status === "rejected" &&
              result.error_code ===
                AllocationCommandErrorCode.CAPACITY_EXHAUSTED
          )
        ).toBe(true)
        expect(await invariantSnapshot(campaignId)).toEqual([
          {
            capacity_held: 50,
            hold_sum: 50,
            bad_capacity: 0,
            bad_subject: 0,
            subject_mismatch: 0,
            raw_mismatch: 0,
          },
        ])
      })

      it("serializes first purchase for one subject with limit one", async () => {
        const { campaignId } = await seed({ item: 20 }, { limit: 1 })
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            service.claimAndHoldQuota(
              command(campaignId, "one-subject", index + 600, [
                { campaign_item_id: "item", quantity: 1 },
              ])
            )
          )
        )
        expect(
          results.filter((result) => result.status === "held")
        ).toHaveLength(1)
        expect(
          results.filter(
            (result) =>
              result.status === "rejected" &&
              result.error_code ===
                AllocationCommandErrorCode.PURCHASE_LIMIT_EXCEEDED
          )
        ).toHaveLength(19)
        expect(await invariantSnapshot(campaignId)).toEqual([
          {
            capacity_held: 1,
            hold_sum: 1,
            bad_capacity: 0,
            bad_subject: 0,
            subject_mismatch: 0,
            raw_mismatch: 0,
          },
        ])
      })

      it("rejects all-or-nothing when the second item is exhausted", async () => {
        const { campaignId } = await seed({ A: 10, B: 1 }, { limit: 10 })
        const result = await service.claimAndHoldQuota(
          command(campaignId, "multi-short", 700, [
            { campaign_item_id: "A", quantity: 2 },
            { campaign_item_id: "B", quantity: 2 },
          ])
        )
        expect(result).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
          replayed: false,
        })
        const rows = await execute(
          `select (select count(*) from flash_sale_allocation_hold h
                    join flash_sale_purchase_attempt a on a.id = h.attempt_id
                   where a.campaign_id = ?)::int as holds,
                  (select coalesce(sum(held_quantity), 0) from flash_sale_capacity c
                    join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
                   where p.campaign_id = ?)::int as capacity_held,
                  (select coalesce(sum(held_quantity), 0) from flash_sale_subject_allocation
                   where campaign_id = ?)::int as subject_held`,
          [campaignId, campaignId, campaignId]
        )
        expect(rows).toEqual([{ holds: 0, capacity_held: 0, subject_held: 0 }])
      })

      it("normalizes opposite item orders and avoids partial/deadlocked results", async () => {
        const { campaignId } = await seed({ A: 1, B: 1 }, { limit: 2 })
        const results = await Promise.all([
          service.claimAndHoldQuota(
            command(campaignId, "order-a", 701, [
              { campaign_item_id: "A", quantity: 1 },
              { campaign_item_id: "B", quantity: 1 },
            ])
          ),
          service.claimAndHoldQuota(
            command(campaignId, "order-b", 702, [
              { campaign_item_id: "B", quantity: 1 },
              { campaign_item_id: "A", quantity: 1 },
            ])
          ),
        ])
        expect(
          results.filter((result) => result.status === "held")
        ).toHaveLength(1)
        expect(
          results.filter((result) => result.status === "rejected")
        ).toHaveLength(1)
        expect(await invariantSnapshot(campaignId)).toEqual([
          {
            capacity_held: 2,
            hold_sum: 2,
            bad_capacity: 0,
            bad_subject: 0,
            subject_mismatch: 0,
            raw_mismatch: 0,
          },
        ])
      })

      it("converges 20 same-key commands to one attempt and one hold", async () => {
        const { campaignId } = await seed({ item: 10 }, { limit: 1 })
        const same = command(campaignId, "same", 800, [
          { campaign_item_id: "item", quantity: 1 },
        ])
        const results = await Promise.all(
          Array.from({ length: 20 }, () => service.claimAndHoldQuota(same))
        )
        expect(new Set(results.map((result) => result.attempt.id)).size).toBe(1)
        expect(results.filter((result) => !result.replayed)).toHaveLength(1)
        expect(results.filter((result) => result.replayed)).toHaveLength(19)
        expect(await invariantSnapshot(campaignId)).toEqual([
          {
            capacity_held: 1,
            hold_sum: 1,
            bad_capacity: 0,
            bad_subject: 0,
            subject_mismatch: 0,
            raw_mismatch: 0,
          },
        ])
      })

      it("holds an existing pending claim and stably replays held/rejected outcomes", async () => {
        const heldFixture = await seed({ item: 1 }, { limit: 1 })
        const heldCommand = command(heldFixture.campaignId, "claimed", 900, [
          { campaign_item_id: "item", quantity: 1 },
        ])
        const claim = await service.claimAttempt(heldCommand)
        const holdCommand: HoldQuotaCommand = {
          attempt_id: claim.attempt.id,
          campaign_id: heldCommand.campaign_id,
          subject_id: heldCommand.subject_id,
          cart_id: heldCommand.cart_id,
          expected_rules_version: heldCommand.expected_rules_version,
          items: heldCommand.items,
        }
        const held = await service.holdQuota(holdCommand)
        expect(held).toMatchObject({ status: "held", replayed: false })
        expect(await service.holdQuota(holdCommand)).toMatchObject({
          status: "held",
          replayed: true,
        })

        const rejectedFixture = await seed({ item: 1 }, { limit: 1 })
        const rejected = await service.claimAndHoldQuota(
          command(rejectedFixture.campaignId, "too-many", 901, [
            { campaign_item_id: "item", quantity: 2 },
          ])
        )
        expect(rejected).toMatchObject({ status: "rejected", replayed: false })
        expect(
          await service.claimAndHoldQuota(
            command(rejectedFixture.campaignId, "too-many", 901, [
              { campaign_item_id: "item", quantity: 2 },
            ])
          )
        ).toMatchObject({ status: "rejected", replayed: true })
      })

      it("persists expiry, policy, rules and capacity-state rejection codes", async () => {
        const expiredFixture = await seed({ item: 1 })
        const expiredCommand = command(
          expiredFixture.campaignId,
          "expired",
          950,
          [{ campaign_item_id: "item", quantity: 1 }]
        )
        const expiredClaim = await service.claimAttempt(expiredCommand)
        await execute(
          "update flash_sale_purchase_attempt set expires_at = now() - interval '1 second' where id = ?",
          [expiredClaim.attempt.id]
        )
        expect(
          await service.holdQuota({
            attempt_id: expiredClaim.attempt.id,
            campaign_id: expiredCommand.campaign_id,
            subject_id: expiredCommand.subject_id,
            cart_id: expiredCommand.cart_id,
            expected_rules_version: 1,
            items: expiredCommand.items,
          })
        ).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.HOLD_EXPIRED,
        })

        const changedPolicy = await seed({ item: 1 })
        const changedPolicyCommand = command(
          changedPolicy.campaignId,
          "closed-after-claim",
          951,
          [{ campaign_item_id: "item", quantity: 1 }]
        )
        const changedPolicyClaim = await service.claimAttempt(
          changedPolicyCommand
        )
        await execute(
          "update flash_sale_allocation_policy set state = 'prepared' where id = ?",
          [changedPolicy.policyId]
        )
        const changedPolicyHold: HoldQuotaCommand = {
          attempt_id: changedPolicyClaim.attempt.id,
          campaign_id: changedPolicyCommand.campaign_id,
          subject_id: changedPolicyCommand.subject_id,
          cart_id: changedPolicyCommand.cart_id,
          expected_rules_version: 1,
          items: changedPolicyCommand.items,
        }
        expect(await service.holdQuota(changedPolicyHold)).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
          attempt: {
            state: PurchaseAttemptState.QUOTA_REJECTED,
            last_error_code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
          },
          replayed: false,
        })
        expect(await service.holdQuota(changedPolicyHold)).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
          replayed: true,
        })

        const changedRules = await seed({ item: 1 })
        const changedRulesCommand = command(
          changedRules.campaignId,
          "rules-after-claim",
          952,
          [{ campaign_item_id: "item", quantity: 1 }]
        )
        const changedRulesClaim = await service.claimAttempt(
          changedRulesCommand
        )
        await execute(
          "update flash_sale_allocation_policy set rules_version = 2 where id = ?",
          [changedRules.policyId]
        )
        const changedRulesHold: HoldQuotaCommand = {
          attempt_id: changedRulesClaim.attempt.id,
          campaign_id: changedRulesCommand.campaign_id,
          subject_id: changedRulesCommand.subject_id,
          cart_id: changedRulesCommand.cart_id,
          expected_rules_version: 1,
          items: changedRulesCommand.items,
        }
        expect(await service.holdQuota(changedRulesHold)).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.STALE_RULES_VERSION,
          attempt: {
            state: PurchaseAttemptState.QUOTA_REJECTED,
            last_error_code: AllocationCommandErrorCode.STALE_RULES_VERSION,
          },
          replayed: false,
        })
        expect(await service.holdQuota(changedRulesHold)).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.STALE_RULES_VERSION,
          replayed: true,
        })

        const capacityClosed = await seed(
          { item: 1 },
          { capacityState: CapacityState.CLOSED }
        )
        expect(
          await service.claimAndHoldQuota(
            command(capacityClosed.campaignId, "capacity-closed", 953, [
              { campaign_item_id: "item", quantity: 1 },
            ])
          )
        ).toMatchObject({
          status: "rejected",
          error_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
        })
      })

      it("does not create attempts when claim policy validation fails", async () => {
        const prepared = await seed(
          { item: 1 },
          { policyState: AllocationPolicyState.PREPARED }
        )
        await expect(
          service.claimAndHoldQuota(
            command(prepared.campaignId, "prepared", 970, [
              { campaign_item_id: "item", quantity: 1 },
            ])
          )
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
        })

        const stale = await seed({ item: 1 }, { rulesVersion: 2 })
        await expect(
          service.claimAndHoldQuota(
            command(stale.campaignId, "stale", 971, [
              { campaign_item_id: "item", quantity: 1 },
            ])
          )
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.STALE_RULES_VERSION,
        })

        const ended = await seed({ item: 1 })
        await execute(
          `update flash_sale_allocation_policy
              set starts_at = now() - interval '2 minutes',
                  ends_at = now() - interval '1 minute'
            where id = ?`,
          [ended.policyId]
        )
        await expect(
          service.claimAndHoldQuota(
            command(ended.campaignId, "ended", 972, [
              { campaign_item_id: "item", quantity: 1 },
            ])
          )
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
        })

        const attempts = (await execute(
          `select count(*)::int as count from flash_sale_purchase_attempt
            where campaign_id in (?, ?, ?)`,
          [prepared.campaignId, stale.campaignId, ended.campaignId]
        )) as Array<{ count: number }>
        expect(attempts[0].count).toBe(0)
      })

      it("returns ATTEMPT_NOT_FOUND and rejects caller-supplied hashes", async () => {
        await expect(
          service.holdQuota({
            attempt_id: "missing",
            campaign_id: "campaign",
            subject_id: "subject",
            cart_id: null,
            expected_rules_version: 1,
            items: [{ campaign_item_id: "item", quantity: 1 }],
          })
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.ATTEMPT_NOT_FOUND,
        })

        const fixture = await seed({ item: 1 })
        await expect(
          service.claimAndHoldQuota({
            ...command(fixture.campaignId, "raw", 999, [
              { campaign_item_id: "item", quantity: 1 },
            ]),
            request_hash: hash(1),
          } as ClaimAndHoldQuotaCommand)
        ).rejects.toMatchObject({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      })
    })
  },
})
