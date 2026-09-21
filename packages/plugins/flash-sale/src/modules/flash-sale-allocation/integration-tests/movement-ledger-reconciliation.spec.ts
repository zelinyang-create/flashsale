import { createHash } from "crypto"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import * as path from "path"
import {
  ClaimAndHoldQuotaCommand,
  ProvisionAllocationCommand,
  createAllocationConfigurationHash,
} from "../application"
import { LedgerReconciliationIssueCode } from "../domain"
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
import {
  MovementCheckpointRow,
  PostgresMovementLedgerReconciliationStore,
  calculateMovementCheckpointDigest,
} from "../persistence"
import FlashSaleAllocationModuleService from "../service"
import { FlashSalePluginModule } from "../../../types"

jest.setTimeout(180_000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const unique = (label: string) => `${label}-ledger-audit-${process.pid}-${++sequence}`
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex")

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-movement-ledger-reconciliation",
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
  testSuite: ({ MikroOrmWrapper, service }) => {
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
        per_subject_limit: 100,
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
      return {
        campaign_id: campaignId,
        subject_id: unique("subject"),
        cart_id: unique("cart"),
        idempotency_key_hash: hash(unique("key")),
        expected_rules_version: 1,
        items: itemIds.map((campaign_item_id) => ({
          campaign_item_id,
          quantity: 2,
        })),
      }
    }

    async function provision(
      campaignId = unique("campaign"),
      itemIds = [`${campaignId}-item`]
    ) {
      const value = await service.provisionAllocation(
        provisionCommand(campaignId, itemIds)
      )
      return { campaignId, itemIds, value }
    }

    async function open(fixture: Awaited<ReturnType<typeof provision>>) {
      await service.openAllocation({
        policy_id: fixture.value.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
    }

    async function refreshCheckpointDigest(schemaVersion = 2) {
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
      const digest = calculateMovementCheckpointDigest(
        checkpoints,
        schemaVersion
      )
      await execute(
        `update flash_sale_capacity_movement_control
            set schema_version = ?, checkpoint_digest = ?`,
        [schemaVersion, digest]
      )
    }

    it("returns a ledger-domain not_activated result without changing Phase 1 audit", async () => {
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        domain: "movement_ledger",
        status: "not_activated",
        issue_count: 0,
        subject_counter_derivation: "not_ledger_derived",
      })
      await expect(service.reconcileAllocation({})).resolves.toMatchObject({
        healthy: true,
        issue_count: 0,
      })
    })

    it("fails closed before activation when bound Attempt/Hold evidence remains", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("orphan-binding"))
      await open(fixture)
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      await execute(`delete from flash_sale_capacity_movement`)
      await execute(`delete from flash_sale_capacity_movement_checkpoint`)
      await execute(`delete from flash_sale_capacity_movement_control`)
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
          }),
        ],
      })
    })

    it("does not skip a physical empty-string id on the first keyset batch", async () => {
      await execute(
        `alter table flash_sale_capacity_movement_control
           drop constraint ck_flash_sale_movement_control_singleton`
      )
      try {
        await execute(
          `insert into flash_sale_capacity_movement_control
            (id, activation_id, required_after, schema_version, checkpoint_digest)
           values ('', 'fsmovact_empty_id', now(), 2, ?)` ,
          ["0".repeat(64)]
        )
        await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
          status: "manual_required",
          classification: "manual_required",
        })
      } finally {
        await execute(`delete from flash_sale_capacity_movement_control where id = ''`)
        await execute(
          `alter table flash_sale_capacity_movement_control
             add constraint ck_flash_sale_movement_control_singleton
             check (id = 'allocation-movement-ledger')`
        )
      }
    })

    it("audits a v2 provision root with bounded keyset batches", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("v2"), [unique("a"), unique("b")])
      await expect(
        service.reconcileMovementLedger({
          campaign_id: fixture.campaignId,
          batch_size: 1,
          sample_limit: 1,
          statement_timeout_ms: 2_000,
        })
      ).resolves.toMatchObject({
        domain: "movement_ledger",
        scope: { campaign_id: fixture.campaignId },
        status: "healthy",
        issue_count: 0,
        expected_capacities: [expect.any(Object)],
      })
    })

    it("maps multi-item numeric/raw quantities above MAX_SAFE_INTEGER losslessly", async () => {
      const huge = "900719925474099300000"
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("bigint"), [unique("big-a"), unique("big-b")])
      const capacityId = fixture.value.capacities[0].id
      await execute(
        `update flash_sale_capacity
            set granted_quantity = ?::numeric,
                raw_granted_quantity = jsonb_build_object('value', ?, 'precision', 20)
          where id = ?`,
        [huge, huge, capacityId]
      )
      await execute(
        `update flash_sale_capacity_movement_checkpoint
            set opening_granted_quantity = ?::numeric,
                opening_available_quantity = ?::numeric,
                raw_opening_granted_quantity = jsonb_build_object('value', ?, 'precision', 20),
                raw_opening_available_quantity = jsonb_build_object('value', ?, 'precision', 20)
          where capacity_id = ?`,
        [huge, huge, huge, huge, capacityId]
      )
      await refreshCheckpointDigest()
      const result = await service.reconcileMovementLedger({ batch_size: 1 })
      expect(result.status).toBe("healthy")
      expect(result.expected_capacities).toContainEqual(
        expect.objectContaining({
          capacity_id: capacityId,
          granted_quantity: huge,
          available_quantity: huge,
        })
      )
    })

    it("uses the published v1 canonical root semantics", async () => {
      await provision(unique("v1"))
      await service.activateAllocationMovementLedger({})
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
      const digest = calculateMovementCheckpointDigest(checkpoints, 1)
      await execute(
        `update flash_sale_capacity_movement_control
            set schema_version = 1, checkpoint_digest = ?`,
        [digest]
      )
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "healthy",
        issue_count: 0,
      })
    })

    it("projects legacy opening held and a post-cutover consume", async () => {
      const fixture = await provision(unique("legacy"))
      await open(fixture)
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      await service.activateAllocationMovementLedger({})
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "healthy",
        expected_capacities: [
          expect.objectContaining({ held_quantity: "2", consumed_quantity: "0" }),
        ],
      })
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: unique("settlement"),
      })
      const committing = (await execute(
        `select settlement_id from flash_sale_purchase_attempt where id = ?`,
        [held.attempt.id]
      )) as Array<{ settlement_id: string }>
      await service.consumeQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: committing[0].settlement_id,
      })
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "healthy",
        expected_capacities: [
          expect.objectContaining({ held_quantity: "0", consumed_quantity: "2" }),
        ],
      })
    })

    it("audits Hold, Consume, Release and Expire histories", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("routes"))
      await open(fixture)
      const consumed = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      const released = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      const expired = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (
        consumed.status !== "held" ||
        released.status !== "held" ||
        expired.status !== "held"
      ) {
        throw new Error("expected held fixtures")
      }
      const settlementId = unique("settlement")
      await service.beginQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: settlementId,
      })
      await service.consumeQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: settlementId,
      })
      await service.cancelHeldQuota({ attempt_id: released.attempt.id })
      await execute(
        `update flash_sale_purchase_attempt
            set expires_at = clock_timestamp() - interval '1 second'
          where id = ?`,
        [expired.attempt.id]
      )
      await service.expireQuota({ attempt_id: expired.attempt.id })
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "healthy",
        issue_count: 0,
      })
    })

    it("fails an extra physical Control closed", async () => {
      await service.activateAllocationMovementLedger({})
      await provision(unique("extra-control"))
      await execute(
        `alter table flash_sale_capacity_movement_control
           drop constraint ck_flash_sale_movement_control_singleton`
      )
      try {
        await execute(
          `insert into flash_sale_capacity_movement_control
            (id, activation_id, required_after, schema_version, checkpoint_digest)
           select 'extra-control', 'fsmovact_extra_control', required_after, schema_version,
                  checkpoint_digest
             from flash_sale_capacity_movement_control
            limit 1`
        )
        await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
          domain: "movement_ledger",
          status: "manual_required",
          classification: "manual_required",
        })
      } finally {
        await execute(
          `delete from flash_sale_capacity_movement_control
            where id <> 'allocation-movement-ledger'`
        )
        await execute(
          `alter table flash_sale_capacity_movement_control
             add constraint ck_flash_sale_movement_control_singleton
             check (id = 'allocation-movement-ledger')`
        )
      }
    })

    it.each([
      ["soft-deleted Control", async (run: Execute) => run(
        `update flash_sale_capacity_movement_control set deleted_at = now()`
      )],
      ["unknown Control schema", async (run: Execute) => run(
        `update flash_sale_capacity_movement_control set schema_version = 99`
      )],
      ["digest drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement_control set checkpoint_digest = ?`,
        ["0".repeat(64)]
      )],
      ["missing Checkpoint", async (run: Execute) => run(
        `delete from flash_sale_capacity_movement_checkpoint`
      )],
      ["soft-deleted Checkpoint", async (run: Execute) => run(
        `update flash_sale_capacity_movement_checkpoint set deleted_at = now()`
      )],
      ["Checkpoint time drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement_checkpoint
            set activated_at = activated_at + interval '1 second'`
      )],
      ["Checkpoint opening/raw drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement_checkpoint
            set raw_opening_available_quantity =
                jsonb_build_object('value', '99', 'precision', 20)`
      )],
    ])("fails %s closed as ledger manual_required", async (_, mutate) => {
      await service.activateAllocationMovementLedger({})
      await provision(unique("root-tamper"))
      await mutate(execute)
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        domain: "movement_ledger",
        status: "manual_required",
        classification: "manual_required",
      })
    })

    it.each([
      ["missing Movement", async (run: Execute) => run(
        `delete from flash_sale_capacity_movement`
      )],
      ["soft-deleted Movement", async (run: Execute) => run(
        `update flash_sale_capacity_movement set deleted_at = now()`
      )],
      ["raw Movement drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement
            set raw_quantity = jsonb_build_object('value', '9', 'precision', 20)`
      )],
      ["fingerprint drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement set fence_token = ?`,
        ["0".repeat(64)]
      )],
      ["identity drift", async (run: Execute) => run(
        `update flash_sale_capacity_movement set campaign_id = 'wrong-campaign'`
      )],
      ["wrong binding", async (run: Execute) => run(
        `update flash_sale_purchase_attempt
            set hold_movement_activation_id = 'wrong-activation'`
      )],
      ["null binding", async (run: Execute) => run(
        `update flash_sale_purchase_attempt
            set hold_movement_activation_id = null`
      )],
      ["orphan/deleted Attempt", async (run: Execute) => run(
        `update flash_sale_purchase_attempt set deleted_at = now()`
      )],
    ])("detects %s in the physical Movement history", async (_, mutate) => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("movement-tamper"))
      await open(fixture)
      await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      await mutate(execute)
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
      })
    })

    it("fails a soft-deleted Policy referenced by Capacity closed", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("deleted-policy"))
      await execute(
        `update flash_sale_allocation_policy set deleted_at = now() where id = ?`,
        [fixture.value.policy.id]
      )
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.SOFT_DELETED_EVIDENCE,
          }),
        ],
      })
    })

    it("fails an orphan Capacity Policy reference closed", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("orphan-policy"))
      const capacityId = fixture.value.capacities[0].id
      const policyId = fixture.value.policy.id
      await execute(
        `alter table flash_sale_capacity
           drop constraint flash_sale_capacity_allocation_policy_id_foreign`
      )
      try {
        await execute(
          `update flash_sale_capacity
              set allocation_policy_id = 'missing-policy'
            where id = ?`,
          [capacityId]
        )
        await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
          status: "manual_required",
          classification: "manual_required",
          issues: [
            expect.objectContaining({
              code: LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
            }),
          ],
        })
      } finally {
        await execute(
          `update flash_sale_capacity set allocation_policy_id = ? where id = ?`,
          [policyId, capacityId]
        )
        await execute(
          `alter table flash_sale_capacity
             add constraint flash_sale_capacity_allocation_policy_id_foreign
             foreign key (allocation_policy_id)
             references flash_sale_allocation_policy (id) on update cascade`
        )
      }
    })

    it("fails an Attempt crossing Policy/Campaign identity closed", async () => {
      await service.activateAllocationMovementLedger({})
      const first = await provision(unique("policy-a"))
      const second = await provision(unique("policy-b"))
      await open(first)
      const held = await service.claimAndHoldQuota(
        holdCommand(first.campaignId, first.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_purchase_attempt
            set allocation_policy_id = ?
          where id = ?`,
        [second.value.policy.id, held.attempt.id]
      )
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          }),
        ],
      })
    })

    it("fails a physical Policy without any Capacity closed", async () => {
      await service.activateAllocationMovementLedger({})
      await provision(unique("retained-policy"))
      const orphan = await provision(unique("empty-policy"))
      const orphanCapacityId = orphan.value.capacities[0].id
      await execute(
        `delete from flash_sale_capacity_movement_checkpoint where capacity_id = ?`,
        [orphanCapacityId]
      )
      await execute(`delete from flash_sale_capacity where id = ?`, [orphanCapacityId])
      await refreshCheckpointDigest()
      await expect(
        service.reconcileMovementLedger({ campaign_id: orphan.campaignId })
      ).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          }),
        ],
      })
    })

    it("rejects Policy OPEN / Capacity CLOSED before drift can be safe", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("state-mismatch"))
      await open(fixture)
      await execute(
        `update flash_sale_capacity
            set state = 'closed',
                held_quantity = 1,
                raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
          where id = ?`,
        [fixture.value.capacities[0].id]
      )
      await expect(
        service.reconcileMovementLedger({ campaign_id: fixture.campaignId })
      ).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          }),
        ],
      })
    })

    it("fails an invalid physical Policy state closed", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("invalid-policy-state"))
      await execute(
        `do $$
         declare state_constraint text;
         begin
           select conname into state_constraint
             from pg_constraint
            where conrelid = 'flash_sale_allocation_policy'::regclass
              and contype = 'c'
              and pg_get_constraintdef(oid) like '%state%'
            limit 1;
           if state_constraint is null then
             raise exception 'allocation Policy state constraint not found';
           end if;
           execute format(
             'alter table flash_sale_allocation_policy drop constraint %I',
             state_constraint
           );
         end $$`
      )
      try {
        await execute(
          `update flash_sale_allocation_policy set state = 'invalid' where id = ?`,
          [fixture.value.policy.id]
        )
        await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
          status: "manual_required",
          classification: "manual_required",
          issues: [
            expect.objectContaining({
              code: LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
            }),
          ],
        })
      } finally {
        await execute(
          `update flash_sale_allocation_policy set state = 'prepared' where id = ?`,
          [fixture.value.policy.id]
        )
        await execute(
          `alter table flash_sale_allocation_policy
             add constraint ck_flash_sale_allocation_policy_state_domain
             check (state in ('prepared', 'open', 'closed'))`
        )
      }
    })

    it("classifies materialized counter and raw drift without repairing", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("drift"))
      const capacityId = fixture.value.capacities[0].id
      await execute(
        `update flash_sale_capacity
            set held_quantity = 1,
                raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
          where id = ?`,
        [capacityId]
      )
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "drift",
        classification: "safe_repair",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
          }),
        ],
      })
      await execute(
        `update flash_sale_capacity
            set held_quantity = 0,
                raw_held_quantity = jsonb_build_object('value', '0', 'precision', 20),
                raw_granted_quantity = jsonb_build_object('value', '99', 'precision', 20)
          where id = ?`,
        [capacityId]
      )
      await expect(service.reconcileMovementLedger({})).resolves.toMatchObject({
        status: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.RAW_GRANTED_MIRROR_DRIFT,
          }),
        ],
      })
    })

    it("keeps the global root gate for campaign-scoped audits", async () => {
      await service.activateAllocationMovementLedger({})
      const wanted = await provision(unique("wanted"))
      const other = await provision(unique("other"))
      await execute(
        `delete from flash_sale_capacity_movement_checkpoint
          where capacity_id = ?`,
        [other.value.capacities[0].id]
      )
      await expect(
        service.reconcileMovementLedger({ campaign_id: wanted.campaignId })
      ).resolves.toMatchObject({
        scope: { campaign_id: wanted.campaignId },
        status: "manual_required",
      })
    })

    it("fails a nonexistent campaign scope closed after the global gate", async () => {
      await service.activateAllocationMovementLedger({})
      await provision(unique("known-scope"))
      await expect(
        service.reconcileMovementLedger({ campaign_id: unique("typo-scope") })
      ).resolves.toMatchObject({
        status: "manual_required",
        classification: "manual_required",
        issues: [
          expect.objectContaining({
            code: LedgerReconciliationIssueCode.SCOPE_NOT_FOUND,
          }),
        ],
      })
    })

    it("uses one repeatable-read snapshot and applies statement timeout", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provision(unique("snapshot"))
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      let settings: unknown[] = []
      const store = new PostgresMovementLedgerReconciliationStore(repository, {
        snapshotEstablished: async (manager) => {
          settings = (await manager.execute(
            `select current_setting('transaction_isolation') as isolation_level,
                    current_setting('transaction_read_only') as read_only,
                    current_setting('statement_timeout') as statement_timeout`
          )) as unknown[]
          await execute(
            `update flash_sale_capacity
                set held_quantity = 1,
                    raw_held_quantity = jsonb_build_object('value', '1', 'precision', 20)
              where id = ?`,
            [fixture.value.capacities[0].id]
          )
        },
      })
      await expect(
        store.reconcileMovementLedger({
          campaign_id: fixture.campaignId,
          sample_limit: 20,
          statement_timeout_ms: 1_500,
          batch_size: 50,
        })
      ).resolves.toMatchObject({ status: "healthy" })
      expect(settings).toEqual([
        {
          isolation_level: "repeatable read",
          read_only: "on",
          statement_timeout: "1500ms",
        },
      ])
    })

    it("enforces READ ONLY at the database boundary", async () => {
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresMovementLedgerReconciliationStore(repository, {
        snapshotEstablished: async (manager) => {
          await manager.execute(
            `insert into flash_sale_capacity_movement_control
              (id, activation_id, required_after, schema_version, checkpoint_digest)
             values ('forbidden-write', 'activation', now(), 2, ?)` ,
            ["0".repeat(64)]
          )
        },
      })
      await expect(
        store.reconcileMovementLedger({
          sample_limit: 20,
          statement_timeout_ms: 1_000,
          batch_size: 50,
        })
      ).rejects.toThrow(/read-only transaction/i)
    })
  },
})
