import { MedusaError } from "@medusajs/framework/utils"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
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
  PurchaseAttempt,
  SubjectAllocation,
} from "../models"
import FlashSaleAllocationModuleService, {
  WRITE_COMMAND_REQUIRED,
} from "../service"

jest.setTimeout(60000)

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>

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

    const insertPolicy = async (
      id: string,
      overrides: {
        campaignId?: string
        rulesVersion?: number
        state?: AllocationPolicyState
        configurationHash?: string
      } = {}
    ) => {
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          overrides.campaignId ?? `campaign-${id}`,
          overrides.rulesVersion ?? 1,
          overrides.configurationHash ?? HASH_A,
          overrides.state ?? AllocationPolicyState.PREPARED,
          new Date("2030-01-01T00:00:00.000Z"),
          new Date("2030-01-02T00:00:00.000Z"),
          300,
          1,
          1,
        ]
      )
    }

    const insertCapacity = async (
      id: string,
      policyId: string,
      campaignItemId: string,
      overrides: {
        granted?: number
        held?: number
        consumed?: number
        shardNo?: number
      } = {}
    ) => {
      const granted = overrides.granted ?? 10
      const held = overrides.held ?? 0
      const consumed = overrides.consumed ?? 0
      await execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity,
           raw_consumed_quantity)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)`,
        [
          id,
          policyId,
          campaignItemId,
          overrides.shardNo ?? 0,
          CapacityState.PREPARED,
          granted,
          held,
          consumed,
          1,
          1,
          JSON.stringify({ value: String(granted), precision: 20 }),
          JSON.stringify({ value: String(held), precision: 20 }),
          JSON.stringify({ value: String(consumed), precision: 20 }),
        ]
      )
    }

    const insertAttempt = async (
      id: string,
      policyId: string,
      overrides: {
        campaignId?: string
        subjectId?: string
        cartId?: string | null
        idempotencyHash?: string
        requestHash?: string
        state?: PurchaseAttemptState
      } = {}
    ) => {
      await execute(
        `insert into flash_sale_purchase_attempt
          (id, allocation_policy_id, campaign_id, subject_id, cart_id,
           idempotency_key_hash, request_hash, state, rules_version,
           expires_at, version)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          policyId,
          overrides.campaignId ?? `campaign-${policyId}`,
          overrides.subjectId ?? `subject-${id}`,
          overrides.cartId ?? null,
          overrides.idempotencyHash ?? HASH_A,
          overrides.requestHash ?? HASH_B,
          overrides.state ?? PurchaseAttemptState.PENDING,
          1,
          new Date("2030-01-01T00:05:00.000Z"),
          1,
        ]
      )
    }

    const insertHold = async (
      id: string,
      attemptId: string,
      capacityId: string,
      campaignItemId: string,
      quantity = 1
    ) => {
      await execute(
        `insert into flash_sale_allocation_hold
          (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
           expires_at, version, raw_quantity)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
        [
          id,
          attemptId,
          capacityId,
          campaignItemId,
          quantity,
          AllocationHoldState.HELD,
          new Date("2030-01-01T00:05:00.000Z"),
          1,
          JSON.stringify({ value: String(quantity), precision: 20 }),
        ]
      )
    }

    const insertSubject = async (
      id: string,
      campaignId: string,
      subjectId: string,
      limit = 1,
      held = 0,
      consumed = 0
    ) => {
      await execute(
        `insert into flash_sale_subject_allocation
          (id, campaign_id, subject_id, limit_quantity, held_quantity,
           consumed_quantity, rules_version, version, raw_limit_quantity,
           raw_held_quantity, raw_consumed_quantity)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)`,
        [
          id,
          campaignId,
          subjectId,
          limit,
          held,
          consumed,
          1,
          1,
          JSON.stringify({ value: String(limit), precision: 20 }),
          JSON.stringify({ value: String(held), precision: 20 }),
          JSON.stringify({ value: String(consumed), precision: 20 }),
        ]
      )
    }

    describe("Flash-sale allocation schema", () => {
      it("installs all six tables from generated migrations", async () => {
        const rows = (await execute(
          `select tablename
             from pg_tables
            where schemaname = current_schema()
              and tablename like 'flash_sale_%'
            order by tablename`
        )) as Array<{ tablename: string }>

        expect(rows.map((row) => row.tablename)).toEqual([
          "flash_sale_allocation_campaign_fence",
          "flash_sale_allocation_hold",
          "flash_sale_allocation_policy",
          "flash_sale_capacity",
          "flash_sale_purchase_attempt",
          "flash_sale_subject_allocation",
        ])
      })

      it("materializes durable and partial unique indexes with exact scopes", async () => {
        const rows = (await execute(
          `select indexname, indexdef
             from pg_indexes
            where schemaname = current_schema()
              and indexname like 'IDX_flash_sale_%'`
        )) as Array<{ indexname: string; indexdef: string }>
        const definitions = new Map(
          rows.map((row) => [
            row.indexname,
            row.indexdef.toLowerCase().replace(/\s+/g, " "),
          ])
        )

        for (const index of [
          "IDX_flash_sale_allocation_campaign_fence_campaign_unique",
          "IDX_flash_sale_allocation_policy_campaign_rules_unique",
          "IDX_flash_sale_capacity_policy_item_shard_unique",
          "IDX_flash_sale_attempt_idempotency_unique",
          "IDX_flash_sale_hold_attempt_item_unique",
          "IDX_flash_sale_subject_campaign_subject_unique",
        ]) {
          expect(definitions.get(index)).toContain("create unique index")
          expect(definitions.get(index)).not.toContain(" where ")
        }

        expect(
          definitions.get(
            "IDX_flash_sale_allocation_policy_live_campaign_unique"
          )
        ).toContain(
          "where ((deleted_at is null) and (state = any (array['prepared'::text, 'open'::text])))"
        )
        expect(
          definitions.get("IDX_flash_sale_attempt_live_cart_settlement_unique")
        ).toEqual(expect.stringContaining("cart_id is not null"))
        expect(
          definitions.get("IDX_flash_sale_attempt_live_cart_settlement_unique")
        ).toEqual(expect.stringContaining("quota_held"))
        expect(
          definitions.get("IDX_flash_sale_attempt_live_cart_settlement_unique")
        ).toEqual(expect.stringContaining("quota_committing"))
      })

      it("creates only internal allocation foreign keys", async () => {
        const rows = (await execute(
          `select source.relname as source_table,
                  target.relname as target_table
             from pg_constraint c
             join pg_class source on source.oid = c.conrelid
             join pg_class target on target.oid = c.confrelid
            where c.contype = 'f'
              and source.relname like 'flash_sale_%'
            order by source.relname, target.relname`
        )) as Array<{ source_table: string; target_table: string }>

        expect(rows).toEqual([
          {
            source_table: "flash_sale_allocation_hold",
            target_table: "flash_sale_capacity",
          },
          {
            source_table: "flash_sale_allocation_hold",
            target_table: "flash_sale_purchase_attempt",
          },
          {
            source_table: "flash_sale_capacity",
            target_table: "flash_sale_allocation_policy",
          },
          {
            source_table: "flash_sale_purchase_attempt",
            target_table: "flash_sale_allocation_policy",
          },
        ])
        expect(rows.some((row) => row.target_table.includes("campaign"))).toBe(
          false
        )
      })

      it("rejects invalid policy and capacity invariants in PostgreSQL", async () => {
        await expect(
          insertPolicy("policy-bad-hash", { configurationHash: "short" })
        ).rejects.toThrow()

        await insertPolicy("policy-capacity")
        await expect(
          insertCapacity(
            "capacity-bad-shard",
            "policy-capacity",
            "item-bad-shard",
            { shardNo: 1 }
          )
        ).rejects.toThrow()
        await expect(
          insertCapacity(
            "capacity-overdrawn",
            "policy-capacity",
            "item-overdrawn",
            { granted: 1, held: 1, consumed: 1 }
          )
        ).rejects.toThrow()
      })

      it("enforces one valid terminal fence per campaign", async () => {
        await expect(
          execute(
            `insert into flash_sale_allocation_campaign_fence
              (id, campaign_id, disposition, campaign_version, rules_version, version)
             values ('fence-invalid-version', 'campaign-fence-invalid', 'cancelled', 0, 1, 1)`
          )
        ).rejects.toThrow()
        await expect(
          execute(
            `insert into flash_sale_allocation_campaign_fence
              (id, campaign_id, disposition, campaign_version, rules_version, version)
             values ('fence-invalid-disposition', 'campaign-fence-invalid', 'draft', 1, 1, 1)`
          )
        ).rejects.toThrow()
        await execute(
          `insert into flash_sale_allocation_campaign_fence
            (id, campaign_id, disposition, campaign_version, rules_version, version)
           values ('fence-unique-1', 'campaign-fence-unique', 'ended', 2, 1, 1)`
        )
        await expect(
          execute(
            `insert into flash_sale_allocation_campaign_fence
              (id, campaign_id, disposition, campaign_version, rules_version, version)
             values ('fence-unique-2', 'campaign-fence-unique', 'ended', 3, 2, 1)`
          )
        ).rejects.toThrow()
      })

      it("rejects invalid attempt, hold, and subject invariants in PostgreSQL", async () => {
        await insertPolicy("policy-leaf")
        await insertCapacity("capacity-leaf", "policy-leaf", "item-leaf")

        await expect(
          insertAttempt("attempt-bad-hash", "policy-leaf", {
            idempotencyHash: "short",
          })
        ).rejects.toThrow()

        await insertAttempt("attempt-leaf", "policy-leaf")
        await expect(
          insertHold(
            "hold-bad-quantity",
            "attempt-leaf",
            "capacity-leaf",
            "item-leaf",
            0
          )
        ).rejects.toThrow()
        await expect(
          insertSubject("subject-overdrawn", "campaign-leaf", "subject-1", 1, 2)
        ).rejects.toThrow()
      })

      it("keeps idempotency identities unique even after direct soft deletion", async () => {
        await insertPolicy("policy-history", {
          campaignId: "campaign-history",
          state: AllocationPolicyState.CLOSED,
        })
        await execute(
          "update flash_sale_allocation_policy set deleted_at = now() where id = ?",
          ["policy-history"]
        )

        await expect(
          insertPolicy("policy-history-copy", {
            campaignId: "campaign-history",
            state: AllocationPolicyState.CLOSED,
          })
        ).rejects.toThrow()

        await insertPolicy("policy-attempt-history", {
          campaignId: "campaign-attempt-history",
        })
        await insertAttempt("attempt-history", "policy-attempt-history", {
          campaignId: "campaign-attempt-history",
          subjectId: "subject-history",
        })
        await execute(
          "update flash_sale_purchase_attempt set deleted_at = now() where id = ?",
          ["attempt-history"]
        )
        await expect(
          insertAttempt("attempt-history-copy", "policy-attempt-history", {
            campaignId: "campaign-attempt-history",
            subjectId: "subject-history",
          })
        ).rejects.toThrow()
      })

      it("enforces active policy and active-cart partial uniqueness", async () => {
        await insertPolicy("policy-active-1", {
          campaignId: "campaign-active",
          rulesVersion: 1,
        })
        await expect(
          insertPolicy("policy-active-2", {
            campaignId: "campaign-active",
            rulesVersion: 2,
            configurationHash: HASH_B,
          })
        ).rejects.toThrow()
        await execute(
          "update flash_sale_allocation_policy set state = ? where id = ?",
          [AllocationPolicyState.CLOSED, "policy-active-1"]
        )
        await insertPolicy("policy-active-2", {
          campaignId: "campaign-active",
          rulesVersion: 2,
          configurationHash: HASH_B,
        })

        await insertAttempt("attempt-cart-1", "policy-active-2", {
          campaignId: "campaign-active",
          subjectId: "subject-cart-1",
          cartId: "cart-1",
        })
        await expect(
          insertAttempt("attempt-cart-2", "policy-active-2", {
            campaignId: "campaign-active",
            subjectId: "subject-cart-2",
            cartId: "cart-1",
            idempotencyHash: HASH_B,
          })
        ).rejects.toThrow()
        await execute(
          `update flash_sale_purchase_attempt
              set state = ?, settlement_id = ?, settlement_started_at = now()
            where id = ?`,
          [
            PurchaseAttemptState.QUOTA_COMMITTING,
            "settlement-cart-1",
            "attempt-cart-1",
          ]
        )
        await expect(
          insertAttempt("attempt-cart-2", "policy-active-2", {
            campaignId: "campaign-active",
            subjectId: "subject-cart-2",
            cartId: "cart-1",
            idempotencyHash: HASH_B,
          })
        ).rejects.toThrow()
        await execute(
          `update flash_sale_purchase_attempt
              set state = ?, terminal_at = now() where id = ?`,
          [PurchaseAttemptState.QUOTA_RELEASED, "attempt-cart-1"]
        )
        await insertAttempt("attempt-cart-2", "policy-active-2", {
          campaignId: "campaign-active",
          subjectId: "subject-cart-2",
          cartId: "cart-1",
          idempotencyHash: HASH_B,
        })
      })

      it("enforces allocation-internal foreign keys", async () => {
        await expect(
          insertCapacity("capacity-orphan", "missing-policy", "item-orphan")
        ).rejects.toThrow()
        await expect(
          insertAttempt("attempt-orphan", "missing-policy")
        ).rejects.toThrow()
      })
    })

    describe("Allocation service write boundary", () => {
      it("blocks every generated CRUD write path", async () => {
        const methodNames = [
          "createAllocationPolicies",
          "updateAllocationPolicies",
          "upsertAllocationPolicies",
          "deleteAllocationPolicies",
          "softDeleteAllocationPolicies",
          "restoreAllocationPolicies",
          "createCapacities",
          "updateCapacities",
          "upsertCapacities",
          "deleteCapacities",
          "softDeleteCapacities",
          "restoreCapacities",
          "createPurchaseAttempts",
          "updatePurchaseAttempts",
          "upsertPurchaseAttempts",
          "deletePurchaseAttempts",
          "softDeletePurchaseAttempts",
          "restorePurchaseAttempts",
          "createAllocationHolds",
          "updateAllocationHolds",
          "upsertAllocationHolds",
          "deleteAllocationHolds",
          "softDeleteAllocationHolds",
          "restoreAllocationHolds",
          "createSubjectAllocations",
          "updateSubjectAllocations",
          "upsertSubjectAllocations",
          "deleteSubjectAllocations",
          "softDeleteSubjectAllocations",
          "restoreSubjectAllocations",
          "createAllocationCampaignFences",
          "updateAllocationCampaignFences",
          "upsertAllocationCampaignFences",
          "deleteAllocationCampaignFences",
          "softDeleteAllocationCampaignFences",
          "restoreAllocationCampaignFences",
        ] as const

        for (const methodName of methodNames) {
          const write = (service as unknown as Record<string, Function>)[
            methodName
          ]
          expect(typeof write).toBe("function")
          await expect(write.call(service, {})).rejects.toMatchObject({
            type: MedusaError.Types.INVALID_DATA,
            message: WRITE_COMMAND_REQUIRED,
          })
        }
      })
    })
  },
})
