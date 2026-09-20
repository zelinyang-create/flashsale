import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { createHash } from "crypto"
import path from "path"
import {
  AllocationFenceDisposition,
  FlashSalePluginModule,
} from "../../../types"
import {
  AllocationInvariantIssueCode,
  createAllocationConfigurationHash,
  ProvisionAllocationCommand,
} from "../application"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationOutboxControl,
  AllocationOutboxEvent,
  AllocationPolicy,
  Capacity,
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import { PostgresAllocationReconciliationStore } from "../persistence"
import FlashSaleAllocationModuleService from "../service"

jest.setTimeout(120000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const nextId = (label: string) => `${label}-${++sequence}`

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation",
  moduleModels: [
    AllocationCampaignFence,
    AllocationOutboxControl,
    AllocationOutboxEvent,
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

    const provision = async (
      campaignId: string,
      itemCount = 2,
      holdTtlSeconds = 300
    ) => {
      const now = Date.now()
      const base = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: new Date(now - 60_000).toISOString(),
        ends_at: new Date(now + 600_000).toISOString(),
        hold_ttl_seconds: holdTtlSeconds,
        per_subject_limit: 10,
        items: Array.from({ length: itemCount }, (_, index) => ({
          campaign_item_id: `${campaignId}-item-${index}`,
          quota: 100,
        })),
      }
      const command: ProvisionAllocationCommand = {
        ...base,
        configuration_hash: createAllocationConfigurationHash(base),
      }
      return await service.provisionAllocation(command)
    }

    const open = async (campaignId: string, itemCount = 2) => {
      const allocation = await provision(campaignId, itemCount)
      await service.openAllocation({
        policy_id: allocation.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
      return allocation
    }

    const hold = async (campaignId: string, suffix: string, quantity = 1) =>
      await service.claimAndHoldQuota({
        campaign_id: campaignId,
        subject_id: `subject-${suffix}`,
        cart_id: `cart-${suffix}`,
        idempotency_key_hash: createHash("sha256").update(suffix).digest("hex"),
        expected_rules_version: 1,
        items: [{ campaign_item_id: `${campaignId}-item-0`, quantity }],
      })

    describe("allocation reconciliation", () => {
      it("reports a healthy mixed lifecycle including expiry and fencing", async () => {
        const campaignId = nextId("campaign-healthy")
        const allocation = await open(campaignId)
        const held = await hold(campaignId, nextId("held"))
        const consumed = await hold(campaignId, nextId("consumed"))
        const released = await hold(campaignId, nextId("released"))
        const committing = await hold(campaignId, nextId("committing"))
        const expired = await hold(campaignId, nextId("expired"))
        const consumedSettlement = {
          attempt_id: consumed.attempt.id,
          settlement_id: nextId("consumed-settlement"),
        }
        await service.beginQuotaSettlement(consumedSettlement)
        await service.consumeQuotaSettlement(consumedSettlement)
        await service.cancelHeldQuota({ attempt_id: released.attempt.id })
        await service.beginQuotaSettlement({
          attempt_id: committing.attempt.id,
          settlement_id: nextId("settlement"),
        })
        const expiredAt = new Date(Date.now() - 1_000)
        await execute(
          "update flash_sale_purchase_attempt set expires_at = ? where id = ?",
          [expiredAt, expired.attempt.id]
        )
        await execute(
          "update flash_sale_allocation_hold set expires_at = ? where attempt_id = ?",
          [expiredAt, expired.attempt.id]
        )
        await service.expireQuota({ attempt_id: expired.attempt.id })
        expect(held.status).toBe("held")
        await service.fenceAndCloseCampaignAllocation({
          campaign_id: campaignId,
          disposition: AllocationFenceDisposition.ENDED,
          campaign_version: 3,
          rules_version: 1,
        })

        await expect(
          service.reconcileAllocation({ campaign_id: campaignId })
        ).resolves.toMatchObject({
          healthy: true,
          issue_count: 0,
          counts: {},
          samples: [],
        })
        expect(allocation.capacities).toHaveLength(2)
      })

      it("detects counter/raw, subject, terminal, policy, and fence drifts", async () => {
        const capacityCampaign = nextId("campaign-capacity-drift")
        const capacityAllocation = await provision(capacityCampaign, 1)
        await execute(
          `update flash_sale_capacity
              set held_quantity = 1,
                  raw_held_quantity = jsonb_build_object('value', '9', 'precision', 20)
            where id = ?`,
          [capacityAllocation.capacities[0].id]
        )

        const subjectCampaign = nextId("campaign-subject-drift")
        await open(subjectCampaign)
        const subjectHeld = await hold(subjectCampaign, nextId("subject-drift"))
        await execute(
          `update flash_sale_subject_allocation
              set held_quantity = 2,
                  raw_held_quantity = jsonb_build_object('value', '2', 'precision', 20)
            where campaign_id = ? and subject_id = ?`,
          [subjectCampaign, subjectHeld.attempt.subject_id]
        )

        const terminalCampaign = nextId("campaign-terminal-drift")
        await open(terminalCampaign)
        const terminalHeld = await hold(
          terminalCampaign,
          nextId("terminal-drift")
        )
        await execute(
          "update flash_sale_purchase_attempt set state = 'quota_consumed' where id = ?",
          [terminalHeld.attempt.id]
        )

        const policyCampaign = nextId("campaign-policy-drift")
        const policyAllocation = await provision(policyCampaign, 1)
        await execute(
          "update flash_sale_capacity set state = 'closed', rules_version = 2 where id = ?",
          [policyAllocation.capacities[0].id]
        )

        const fenceCampaign = nextId("campaign-fence-drift")
        const fenceAllocation = await provision(fenceCampaign, 1)
        await execute(
          `insert into flash_sale_allocation_campaign_fence
            (id, campaign_id, disposition, campaign_version, rules_version, version)
           values (?, ?, 'ended', 1, 1, 1)`,
          [nextId("fsafence"), fenceCampaign]
        )

        const audit = await service.reconcileAllocation({ sample_limit: 100 })
        expect(audit.counts).toEqual({
          [AllocationInvariantIssueCode.CAPACITY_HELD_MISMATCH]: 1,
          [AllocationInvariantIssueCode.CAPACITY_RAW_HELD_MISMATCH]: 1,
          [AllocationInvariantIssueCode.SUBJECT_HELD_MISMATCH]: 1,
          [AllocationInvariantIssueCode.ATTEMPT_HOLD_STATE_MISMATCH]: 1,
          [AllocationInvariantIssueCode.POLICY_CAPACITY_STATE_MISMATCH]: 1,
          [AllocationInvariantIssueCode.POLICY_CAPACITY_RULES_VERSION_MISMATCH]: 1,
          [AllocationInvariantIssueCode.FENCED_POLICY_ACTIVE]: 1,
          [AllocationInvariantIssueCode.FENCED_CAPACITY_ACTIVE]: 1,
        })
        expect(audit.healthy).toBe(false)
        expect(audit.issue_count).toBe(8)
        expect(fenceAllocation.policy.id).toBeTruthy()
      })

      it("caps and stably sorts samples while isolating every query by campaign", async () => {
        const campaignA = nextId("campaign-scope-a")
        const campaignB = nextId("campaign-scope-b")
        const allocationA = await provision(campaignA, 3)
        const allocationB = await provision(campaignB, 2)
        for (const capacity of [
          ...allocationA.capacities,
          ...allocationB.capacities,
        ]) {
          await execute(
            `update flash_sale_capacity
                set raw_held_quantity = jsonb_build_object('value', '7', 'precision', 20)
              where id = ?`,
            [capacity.id]
          )
        }

        const first = await service.reconcileAllocation({
          campaign_id: campaignA,
          sample_limit: 2,
        })
        const second = await service.reconcileAllocation({
          campaign_id: campaignA,
          sample_limit: 2,
        })
        expect(first.counts).toEqual({
          [AllocationInvariantIssueCode.CAPACITY_RAW_HELD_MISMATCH]: 3,
        })
        expect(first.issue_count).toBe(3)
        expect(first.samples).toHaveLength(2)
        expect(second.samples).toEqual(first.samples)
        expect(
          first.samples.every((sample) =>
            allocationA.capacities.some(
              (capacity) => capacity.id === sample.entity_id
            )
          )
        ).toBe(true)
      })

      it("reports missing subjects and soft-deleted or malformed hold relations", async () => {
        const subjectCampaign = nextId("campaign-missing-subject")
        await open(subjectCampaign)
        const subjectHeld = await hold(
          subjectCampaign,
          nextId("missing-subject")
        )
        await execute(
          `update flash_sale_subject_allocation set deleted_at = now()
            where campaign_id = ? and subject_id = ?`,
          [subjectCampaign, subjectHeld.attempt.subject_id]
        )
        await expect(
          service.reconcileAllocation({ campaign_id: subjectCampaign })
        ).resolves.toMatchObject({
          counts: {
            [AllocationInvariantIssueCode.SUBJECT_ALLOCATION_MISSING]: 1,
          },
        })

        const capacityCampaign = nextId("campaign-deleted-capacity")
        await open(capacityCampaign, 1)
        const capacityHeld = await hold(
          capacityCampaign,
          nextId("deleted-capacity")
        )
        await execute(
          `update flash_sale_capacity set deleted_at = now()
            where id = (select capacity_id from flash_sale_allocation_hold where attempt_id = ?)`,
          [capacityHeld.attempt.id]
        )
        const deletedCapacityAudit = await service.reconcileAllocation({
          campaign_id: capacityCampaign,
        })
        expect(deletedCapacityAudit.counts).toMatchObject({
          [AllocationInvariantIssueCode.HOLD_CAPACITY_ORPHAN_OR_DELETED]: 1,
          [AllocationInvariantIssueCode.POLICY_CAPACITY_MISSING]: 1,
        })

        const identityCampaign = nextId("campaign-hold-identity")
        await open(identityCampaign)
        const identityHeld = await hold(
          identityCampaign,
          nextId("hold-identity")
        )
        await execute(
          `update flash_sale_allocation_hold
              set campaign_item_id = 'wrong-item',
                  expires_at = expires_at + interval '1 second'
            where attempt_id = ?`,
          [identityHeld.attempt.id]
        )
        await expect(
          service.reconcileAllocation({ campaign_id: identityCampaign })
        ).resolves.toMatchObject({
          counts: {
            [AllocationInvariantIssueCode.HOLD_CAPACITY_IDENTITY_MISMATCH]: 1,
            [AllocationInvariantIssueCode.HOLD_EXPIRY_MISMATCH]: 1,
          },
        })
      })

      it("reports malformed and oversized hold raw quantities without aborting", async () => {
        const campaignId = nextId("campaign-hold-raw")
        await open(campaignId, 1)
        const held = await hold(campaignId, nextId("hold-raw"))
        const holdRows = (await execute(
          "select id from flash_sale_allocation_hold where attempt_id = ?",
          [held.attempt.id]
        )) as Array<{ id: string }>

        for (const rawValue of ["not-a-number", "9".repeat(20_000)]) {
          await execute(
            `update flash_sale_allocation_hold
                set raw_quantity = jsonb_build_object('value', ?, 'precision', 20)
              where id = ?`,
            [rawValue, holdRows[0].id]
          )
          const audit = await service.reconcileAllocation({
            campaign_id: campaignId,
          })
          expect(audit.counts).toEqual({
            [AllocationInvariantIssueCode.HOLD_RAW_QUANTITY_MISMATCH]: 1,
          })
          expect(audit.samples).toEqual([
            {
              code: AllocationInvariantIssueCode.HOLD_RAW_QUANTITY_MISMATCH,
              entity_type: "hold",
              entity_id: holdRows[0].id,
            },
          ])
        }
      })

      it("has a real PostgreSQL injection witness for every stable issue code", async () => {
        const covered = new Set<AllocationInvariantIssueCode>()
        const auditAndCover = async (
          campaignId: string,
          expectations: Array<{
            code: AllocationInvariantIssueCode
            entity_id: string
          }>
        ) => {
          const audit = await service.reconcileAllocation({
            campaign_id: campaignId,
            sample_limit: 100,
          })
          for (const expectation of expectations) {
            expect(audit.counts[expectation.code]).toBe(1)
            expect(audit.samples).toContainEqual({
              code: expectation.code,
              entity_type: expect.any(String),
              entity_id: expectation.entity_id,
            })
            covered.add(expectation.code)
          }
        }

        const capacityCampaign = nextId("coverage-capacity")
        const capacityAllocation = await provision(capacityCampaign, 1)
        const capacityId = capacityAllocation.capacities[0].id
        await execute(
          `update flash_sale_capacity
              set held_quantity = 1, consumed_quantity = 1,
                  raw_granted_quantity = jsonb_build_object('value', '9', 'precision', 20),
                  raw_held_quantity = jsonb_build_object('value', '9', 'precision', 20),
                  raw_consumed_quantity = jsonb_build_object('value', '9', 'precision', 20)
            where id = ?`,
          [capacityId]
        )
        await auditAndCover(capacityCampaign, [
          {
            code: AllocationInvariantIssueCode.CAPACITY_HELD_MISMATCH,
            entity_id: capacityId,
          },
          {
            code: AllocationInvariantIssueCode.CAPACITY_CONSUMED_MISMATCH,
            entity_id: capacityId,
          },
          {
            code: AllocationInvariantIssueCode.CAPACITY_RAW_GRANTED_MISMATCH,
            entity_id: capacityId,
          },
          {
            code: AllocationInvariantIssueCode.CAPACITY_RAW_HELD_MISMATCH,
            entity_id: capacityId,
          },
          {
            code: AllocationInvariantIssueCode.CAPACITY_RAW_CONSUMED_MISMATCH,
            entity_id: capacityId,
          },
        ])

        const capacityBalanceCampaign = nextId("coverage-capacity-balance")
        const capacityBalance = await provision(capacityBalanceCampaign, 1)
        const capacityBalanceId = capacityBalance.capacities[0].id
        await execute(
          "alter table flash_sale_capacity drop constraint ck_flash_sale_capacity_balance"
        )
        try {
          await execute(
            `update flash_sale_capacity
                set held_quantity = 101,
                    raw_held_quantity = jsonb_build_object('value', '101', 'precision', 20)
              where id = ?`,
            [capacityBalanceId]
          )
          await auditAndCover(capacityBalanceCampaign, [
            {
              code: AllocationInvariantIssueCode.CAPACITY_BALANCE_EXCEEDED,
              entity_id: capacityBalanceId,
            },
          ])
        } finally {
          await execute(
            `update flash_sale_capacity
                set held_quantity = 0,
                    raw_held_quantity = jsonb_build_object('value', '0', 'precision', 20)
              where id = ?`,
            [capacityBalanceId]
          )
          await execute(`alter table flash_sale_capacity
            add constraint CK_flash_sale_capacity_balance
            check (held_quantity + consumed_quantity <= granted_quantity)`)
        }

        const subjectCampaign = nextId("coverage-subject")
        await open(subjectCampaign, 1)
        const subjectHeld = await hold(subjectCampaign, nextId("subject"))
        const subjectRows = (await execute(
          `select id from flash_sale_subject_allocation
            where campaign_id = ? and subject_id = ?`,
          [subjectCampaign, subjectHeld.attempt.subject_id]
        )) as Array<{ id: string }>
        const subjectId = subjectRows[0].id
        await execute(
          `update flash_sale_subject_allocation
              set held_quantity = 2, consumed_quantity = 1,
                  raw_limit_quantity = jsonb_build_object('value', '9', 'precision', 20),
                  raw_held_quantity = jsonb_build_object('value', '9', 'precision', 20),
                  raw_consumed_quantity = jsonb_build_object('value', '9', 'precision', 20)
            where id = ?`,
          [subjectId]
        )
        await auditAndCover(subjectCampaign, [
          {
            code: AllocationInvariantIssueCode.SUBJECT_HELD_MISMATCH,
            entity_id: subjectId,
          },
          {
            code: AllocationInvariantIssueCode.SUBJECT_CONSUMED_MISMATCH,
            entity_id: subjectId,
          },
          {
            code: AllocationInvariantIssueCode.SUBJECT_RAW_LIMIT_MISMATCH,
            entity_id: subjectId,
          },
          {
            code: AllocationInvariantIssueCode.SUBJECT_RAW_HELD_MISMATCH,
            entity_id: subjectId,
          },
          {
            code: AllocationInvariantIssueCode.SUBJECT_RAW_CONSUMED_MISMATCH,
            entity_id: subjectId,
          },
        ])

        const subjectBalanceCampaign = nextId("coverage-subject-balance")
        await open(subjectBalanceCampaign, 1)
        const subjectBalanceHeld = await hold(
          subjectBalanceCampaign,
          nextId("subject-balance"),
          2
        )
        const subjectBalanceRows = (await execute(
          `select id from flash_sale_subject_allocation
            where campaign_id = ? and subject_id = ?`,
          [subjectBalanceCampaign, subjectBalanceHeld.attempt.subject_id]
        )) as Array<{ id: string }>
        const subjectBalanceId = subjectBalanceRows[0].id
        await execute(
          "alter table flash_sale_subject_allocation drop constraint ck_flash_sale_subject_balance"
        )
        try {
          await execute(
            `update flash_sale_subject_allocation
                set limit_quantity = 1,
                    raw_limit_quantity = jsonb_build_object('value', '1', 'precision', 20)
              where id = ?`,
            [subjectBalanceId]
          )
          await auditAndCover(subjectBalanceCampaign, [
            {
              code: AllocationInvariantIssueCode.SUBJECT_BALANCE_EXCEEDED,
              entity_id: subjectBalanceId,
            },
          ])
        } finally {
          await execute(
            `update flash_sale_subject_allocation
                set limit_quantity = 10,
                    raw_limit_quantity = jsonb_build_object('value', '10', 'precision', 20)
              where id = ?`,
            [subjectBalanceId]
          )
          await execute(`alter table flash_sale_subject_allocation
            add constraint CK_flash_sale_subject_balance
            check (held_quantity + consumed_quantity <= limit_quantity)`)
        }

        const missingSubjectCampaign = nextId("coverage-missing-subject")
        await open(missingSubjectCampaign, 1)
        const missingSubject = await hold(
          missingSubjectCampaign,
          nextId("missing-subject")
        )
        await execute(
          `update flash_sale_subject_allocation set deleted_at = now()
            where campaign_id = ? and subject_id = ?`,
          [missingSubjectCampaign, missingSubject.attempt.subject_id]
        )
        await auditAndCover(missingSubjectCampaign, [
          {
            code: AllocationInvariantIssueCode.SUBJECT_ALLOCATION_MISSING,
            entity_id: missingSubject.attempt.id,
          },
        ])

        const missingHoldCampaign = nextId("coverage-missing-hold")
        await open(missingHoldCampaign, 1)
        const missingHoldAttempt = await service.claimAttempt({
          campaign_id: missingHoldCampaign,
          subject_id: nextId("subject-missing-hold"),
          cart_id: nextId("cart-missing-hold"),
          idempotency_key_hash: createHash("sha256")
            .update(nextId("key-missing-hold"))
            .digest("hex"),
          expected_rules_version: 1,
          items: [
            {
              campaign_item_id: `${missingHoldCampaign}-item-0`,
              quantity: 1,
            },
          ],
        })
        await execute(
          "update flash_sale_purchase_attempt set state = 'quota_held' where id = ?",
          [missingHoldAttempt.attempt.id]
        )
        await auditAndCover(missingHoldCampaign, [
          {
            code: AllocationInvariantIssueCode.ATTEMPT_HOLD_MISSING,
            entity_id: missingHoldAttempt.attempt.id,
          },
        ])

        const unexpectedCampaign = nextId("coverage-unexpected-hold")
        await open(unexpectedCampaign, 1)
        const unexpected = await hold(
          unexpectedCampaign,
          nextId("unexpected-hold")
        )
        await execute(
          "update flash_sale_purchase_attempt set state = 'pending' where id = ?",
          [unexpected.attempt.id]
        )
        await auditAndCover(unexpectedCampaign, [
          {
            code: AllocationInvariantIssueCode.ATTEMPT_UNEXPECTED_HOLD,
            entity_id: unexpected.attempt.id,
          },
        ])

        const stateCampaign = nextId("coverage-attempt-state")
        await open(stateCampaign, 1)
        const stateHeld = await hold(stateCampaign, nextId("attempt-state"))
        await execute(
          "update flash_sale_purchase_attempt set state = 'quota_consumed' where id = ?",
          [stateHeld.attempt.id]
        )
        await auditAndCover(stateCampaign, [
          {
            code: AllocationInvariantIssueCode.ATTEMPT_HOLD_STATE_MISMATCH,
            entity_id: stateHeld.attempt.id,
          },
        ])

        const identityCampaign = nextId("coverage-attempt-identity")
        await open(identityCampaign, 1)
        const identityHeld = await hold(
          identityCampaign,
          nextId("attempt-identity")
        )
        await execute(
          "update flash_sale_purchase_attempt set rules_version = 2 where id = ?",
          [identityHeld.attempt.id]
        )
        await auditAndCover(identityCampaign, [
          {
            code: AllocationInvariantIssueCode.ATTEMPT_POLICY_IDENTITY_MISMATCH,
            entity_id: identityHeld.attempt.id,
          },
        ])

        const orphanAttemptCampaign = nextId("coverage-orphan-attempt")
        await open(orphanAttemptCampaign, 1)
        const orphanAttempt = await hold(
          orphanAttemptCampaign,
          nextId("orphan-attempt")
        )
        const orphanAttemptHold = (await execute(
          "select id from flash_sale_allocation_hold where attempt_id = ?",
          [orphanAttempt.attempt.id]
        )) as Array<{ id: string }>
        await execute(
          "update flash_sale_purchase_attempt set deleted_at = now() where id = ?",
          [orphanAttempt.attempt.id]
        )
        await auditAndCover(orphanAttemptCampaign, [
          {
            code: AllocationInvariantIssueCode.HOLD_ATTEMPT_ORPHAN_OR_DELETED,
            entity_id: orphanAttemptHold[0].id,
          },
        ])

        const orphanCapacityCampaign = nextId("coverage-orphan-capacity")
        const orphanCapacityAllocation = await open(orphanCapacityCampaign, 1)
        const orphanCapacity = await hold(
          orphanCapacityCampaign,
          nextId("orphan-capacity")
        )
        const orphanCapacityHold = (await execute(
          "select id, capacity_id from flash_sale_allocation_hold where attempt_id = ?",
          [orphanCapacity.attempt.id]
        )) as Array<{ id: string; capacity_id: string }>
        await execute(
          "update flash_sale_capacity set deleted_at = now() where id = ?",
          [orphanCapacityHold[0].capacity_id]
        )
        await auditAndCover(orphanCapacityCampaign, [
          {
            code: AllocationInvariantIssueCode.HOLD_CAPACITY_ORPHAN_OR_DELETED,
            entity_id: orphanCapacityHold[0].id,
          },
          {
            code: AllocationInvariantIssueCode.POLICY_CAPACITY_MISSING,
            entity_id: orphanCapacityAllocation.policy.id,
          },
        ])

        const holdCampaign = nextId("coverage-hold-fields")
        await open(holdCampaign, 1)
        const fieldHeld = await hold(holdCampaign, nextId("hold-fields"))
        const fieldHoldRows = (await execute(
          "select id from flash_sale_allocation_hold where attempt_id = ?",
          [fieldHeld.attempt.id]
        )) as Array<{ id: string }>
        await execute(
          `update flash_sale_allocation_hold
              set campaign_item_id = 'wrong-item',
                  expires_at = expires_at + interval '1 second',
                  raw_quantity = jsonb_build_object('value', '99', 'precision', 20)
            where id = ?`,
          [fieldHoldRows[0].id]
        )
        await auditAndCover(holdCampaign, [
          {
            code: AllocationInvariantIssueCode.HOLD_CAPACITY_IDENTITY_MISMATCH,
            entity_id: fieldHoldRows[0].id,
          },
          {
            code: AllocationInvariantIssueCode.HOLD_EXPIRY_MISMATCH,
            entity_id: fieldHoldRows[0].id,
          },
          {
            code: AllocationInvariantIssueCode.HOLD_RAW_QUANTITY_MISMATCH,
            entity_id: fieldHoldRows[0].id,
          },
        ])

        const orphanPolicyCampaign = nextId("coverage-orphan-policy")
        const orphanPolicy = await provision(orphanPolicyCampaign, 1)
        await execute(
          "update flash_sale_allocation_policy set deleted_at = now() where id = ?",
          [orphanPolicy.policy.id]
        )
        await auditAndCover(orphanPolicyCampaign, [
          {
            code: AllocationInvariantIssueCode.CAPACITY_POLICY_ORPHAN_OR_DELETED,
            entity_id: orphanPolicy.capacities[0].id,
          },
        ])

        const policyCampaign = nextId("coverage-policy")
        const policyAllocation = await provision(policyCampaign, 1)
        await execute(
          "update flash_sale_capacity set state = 'closed', rules_version = 2 where id = ?",
          [policyAllocation.capacities[0].id]
        )
        await auditAndCover(policyCampaign, [
          {
            code: AllocationInvariantIssueCode.POLICY_CAPACITY_STATE_MISMATCH,
            entity_id: policyAllocation.capacities[0].id,
          },
          {
            code: AllocationInvariantIssueCode.POLICY_CAPACITY_RULES_VERSION_MISMATCH,
            entity_id: policyAllocation.capacities[0].id,
          },
        ])

        const fenceCampaign = nextId("coverage-fence")
        const fenced = await provision(fenceCampaign, 1)
        await execute(
          `insert into flash_sale_allocation_campaign_fence
            (id, campaign_id, disposition, campaign_version, rules_version, version)
           values (?, ?, 'ended', 1, 1, 1)`,
          [nextId("fsafence"), fenceCampaign]
        )
        await auditAndCover(fenceCampaign, [
          {
            code: AllocationInvariantIssueCode.FENCED_POLICY_ACTIVE,
            entity_id: fenced.policy.id,
          },
          {
            code: AllocationInvariantIssueCode.FENCED_CAPACITY_ACTIVE,
            entity_id: fenced.capacities[0].id,
          },
        ])

        await service.activateAllocationOutbox({})
        const missingOutboxCampaign = nextId("coverage-outbox-missing")
        await open(missingOutboxCampaign, 1)
        const missingOutboxHeld = await hold(
          missingOutboxCampaign,
          nextId("outbox-missing")
        )
        await execute(
          `delete from flash_sale_allocation_outbox_event
            where aggregate_id = ? and aggregate_version = ?`,
          [missingOutboxHeld.attempt.id, missingOutboxHeld.attempt.version]
        )
        await auditAndCover(missingOutboxCampaign, [
          {
            code: AllocationInvariantIssueCode.OUTBOX_CURRENT_EVENT_MISSING,
            entity_id: missingOutboxHeld.attempt.id,
          },
        ])

        const mismatchedOutboxCampaign = nextId("coverage-outbox-name")
        await open(mismatchedOutboxCampaign, 1)
        const mismatchedOutboxHeld = await hold(
          mismatchedOutboxCampaign,
          nextId("outbox-name")
        )
        await execute(
          `update flash_sale_allocation_outbox_event
              set event_name = 'flash_sale.quota.wrong.v1'
            where aggregate_id = ? and aggregate_version = ?`,
          [mismatchedOutboxHeld.attempt.id, mismatchedOutboxHeld.attempt.version]
        )
        await auditAndCover(mismatchedOutboxCampaign, [
          {
            code:
              AllocationInvariantIssueCode.OUTBOX_CURRENT_EVENT_NAME_MISMATCH,
            entity_id: mismatchedOutboxHeld.attempt.id,
          },
        ])

        expect([...covered].sort()).toEqual(
          Object.values(AllocationInvariantIssueCode).sort()
        )
      })

      it("holds one read-only repeatable-read snapshot across concurrent commits", async () => {
        const campaignId = nextId("campaign-snapshot")
        const allocation = await provision(campaignId, 1)
        let releaseSnapshot!: () => void
        let snapshotReached!: () => void
        const reached = new Promise<void>((resolve) => {
          snapshotReached = resolve
        })
        const release = new Promise<void>((resolve) => {
          releaseSnapshot = resolve
        })
        let readOnlyErrorCode: string | undefined
        const repository = new MikroOrmBaseRepository({
          manager: MikroOrmWrapper.getOrm().em,
        })
        const store = new PostgresAllocationReconciliationStore(repository, {
          snapshotEstablished: async (manager) => {
            await manager.execute("savepoint reconciliation_read_only_probe")
            try {
              await manager.execute(
                "update flash_sale_capacity set version = version + 1 where id = ?",
                [allocation.capacities[0].id]
              )
            } catch (error) {
              readOnlyErrorCode = (error as { code?: string }).code
            }
            await manager.execute(
              "rollback to savepoint reconciliation_read_only_probe"
            )
            snapshotReached()
            await release
          },
        })

        const inFlight = store.reconcileAllocation({
          campaign_id: campaignId,
          sample_limit: 20,
        })
        await reached
        await expect(
          service.reconcileAllocation({ campaign_id: campaignId })
        ).resolves.toMatchObject({
          healthy: false,
          skipped: true,
          skip_reason: "ALREADY_RUNNING",
          issue_count: 0,
        })
        await execute(
          `update flash_sale_capacity
              set raw_held_quantity = jsonb_build_object('value', '4', 'precision', 20)
            where id = ?`,
          [allocation.capacities[0].id]
        )
        releaseSnapshot()

        await expect(inFlight).resolves.toMatchObject({
          healthy: true,
          issue_count: 0,
        })
        expect(readOnlyErrorCode).toBe("25006")
        await expect(
          service.reconcileAllocation({ campaign_id: campaignId })
        ).resolves.toMatchObject({
          healthy: false,
          counts: {
            [AllocationInvariantIssueCode.CAPACITY_RAW_HELD_MISMATCH]: 1,
          },
        })
      })
    })
  },
})
