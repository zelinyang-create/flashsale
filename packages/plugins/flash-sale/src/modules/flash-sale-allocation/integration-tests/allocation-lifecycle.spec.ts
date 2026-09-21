import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import {
  defineConfig,
  MikroORM,
  SqlEntityManager,
} from "@medusajs/framework/mikro-orm/postgresql"
import { CustomDBMigrator } from "@medusajs/framework/utils"
import path from "path"
import { FlashSalePluginModule } from "../../../types"
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
import FlashSaleAllocationModuleService from "../service"
import {
  EXPIRY_DOWNGRADE_AUDIT_CODE,
  lockExpiryDowngradeCandidates,
  prepareExpirySchemaDowngrade,
} from "../../../migration-support/prepare-expiry-downgrade"
import {
  lockAndInspectMovementLedgerDowngrade,
  preflightMovementLedgerSchemaDowngrade,
} from "../../../migration-support/preflight-movement-ledger-downgrade"

jest.setTimeout(120000)

const allocationMigrations = path.resolve(__dirname, "../migrations")
const campaignMigrations = path.resolve(
  __dirname,
  "../../flash-sale-campaign/migrations"
)
const checkoutMigrations = path.resolve(
  __dirname,
  "../../flash-sale-checkout/migrations"
)
const models = [
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
]

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation",
  moduleModels: models,
  pathToMigrations: allocationMigrations,
  testSuite: ({ MikroOrmWrapper, service }) => {
    it("reverts and reapplies the Allocation migration without schema loss", async () => {
      const orm = MikroOrmWrapper.getOrm()
      const migrator = orm.getMigrator()
      await migrator.down()
      const afterDigestDown = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_capacity_movement') as movement_table,
          to_regclass('public.flash_sale_capacity_movement_checkpoint') as checkpoint_table,
          to_regclass('public.flash_sale_capacity_movement_control') as control_table,
          exists(select 1 from information_schema.columns
                  where table_name = 'flash_sale_capacity_movement_control'
                    and column_name = 'checkpoint_digest') as digest_column`
      )) as Array<{
        movement_table: string | null
        checkpoint_table: string | null
        control_table: string | null
        digest_column: boolean
      }>
      expect(afterDigestDown).toEqual([
        {
          movement_table: "flash_sale_capacity_movement",
          checkpoint_table: "flash_sale_capacity_movement_checkpoint",
          control_table: "flash_sale_capacity_movement_control",
          digest_column: false,
        },
      ])

      await migrator.down()
      const afterMovementDown =
        (await MikroOrmWrapper.forkManager().execute(
          `select
          to_regclass('public.flash_sale_capacity_movement') as movement_table,
          to_regclass('public.flash_sale_capacity_movement_checkpoint') as checkpoint_table,
          to_regclass('public.flash_sale_capacity_movement_control') as control_table,
          to_regclass('public.flash_sale_allocation_outbox_event') as outbox_table`
        )) as Array<{
          movement_table: string | null
          checkpoint_table: string | null
          control_table: string | null
          outbox_table: string | null
        }>
      expect(afterMovementDown).toEqual([
        {
          movement_table: null,
          checkpoint_table: null,
          control_table: null,
          outbox_table: "flash_sale_allocation_outbox_event",
        },
      ])

      await migrator.down()
      const afterOutboxConstraintDown =
        (await MikroOrmWrapper.forkManager().execute(
          `select
          to_regclass('public.flash_sale_allocation_outbox_event') as outbox_table,
          exists(select 1 from pg_constraint
                  where conname = 'ck_flash_sale_allocation_outbox_bounded_identifiers') as bounded_constraint`
        )) as Array<{
          outbox_table: string | null
          bounded_constraint: boolean
        }>
      expect(afterOutboxConstraintDown).toEqual([
        {
          outbox_table: "flash_sale_allocation_outbox_event",
          bounded_constraint: false,
        },
      ])

      await migrator.down()
      const afterOutboxDown = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_allocation_outbox_event') as event_table,
          to_regclass('public.flash_sale_allocation_outbox_control') as control_table`
      )) as Array<{ event_table: string | null; control_table: string | null }>
      expect(afterOutboxDown).toEqual([
        { event_table: null, control_table: null },
      ])

      await migrator.down()
      const afterSettlementDown = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_allocation_campaign_fence') as fence_table,
          to_regclass('public.flash_sale_allocation_policy') as policy_table,
          exists(select 1 from information_schema.columns
                  where table_name = 'flash_sale_purchase_attempt'
                    and column_name = 'settlement_id') as settlement_column`
      )) as Array<{
        fence_table: string | null
        policy_table: string | null
        settlement_column: boolean
      }>
      expect(afterSettlementDown).toEqual([
        {
          fence_table: "flash_sale_allocation_campaign_fence",
          policy_table: "flash_sale_allocation_policy",
          settlement_column: false,
        },
      ])

      await migrator.down()
      const afterExpiryDown = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_allocation_campaign_fence') as fence_table,
          to_regclass('public.flash_sale_allocation_policy') as policy_table`
      )) as Array<{ fence_table: string | null; policy_table: string | null }>
      expect(afterExpiryDown).toEqual([
        {
          fence_table: "flash_sale_allocation_campaign_fence",
          policy_table: "flash_sale_allocation_policy",
        },
      ])

      await migrator.down()
      const afterFenceDown = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_allocation_campaign_fence') as fence_table,
          to_regclass('public.flash_sale_allocation_policy') as policy_table`
      )) as Array<{ fence_table: string | null; policy_table: string | null }>
      expect(afterFenceDown).toEqual([
        { fence_table: null, policy_table: "flash_sale_allocation_policy" },
      ])

      await migrator.down()
      const afterDown = (await MikroOrmWrapper.forkManager().execute(
        "select to_regclass('public.flash_sale_allocation_policy') as table_name"
      )) as Array<{ table_name: string | null }>
      expect(afterDown).toEqual([{ table_name: null }])

      await migrator.up()
      const evidence = (await MikroOrmWrapper.forkManager().execute(
        `select
          to_regclass('public.flash_sale_allocation_policy') is not null as policy_table,
          to_regclass('public.flash_sale_allocation_campaign_fence') is not null as fence_table,
          to_regclass('public.flash_sale_allocation_outbox_event') is not null as outbox_table,
          to_regclass('public.flash_sale_allocation_outbox_control') is not null as outbox_control_table,
          to_regclass('public.flash_sale_capacity') is not null as capacity_table,
          exists(select 1 from pg_indexes
                  where indexname = 'IDX_flash_sale_attempt_idempotency_unique') as identity_index,
          exists(select 1 from pg_indexes
                  where indexname = 'IDX_flash_sale_attempt_live_cart_settlement_unique'
                    and indexdef like '%quota_committing%') as settlement_cart_index,
          exists(select 1 from information_schema.columns
                  where table_name = 'flash_sale_purchase_attempt'
                    and column_name = 'settlement_id') as settlement_column,
          exists(select 1 from pg_constraint
                  where conname = 'ck_flash_sale_capacity_balance') as capacity_check,
          exists(select 1 from pg_constraint
                  where conname = 'ck_flash_sale_allocation_outbox_bounded_identifiers') as outbox_bounded_check,
          exists(select 1 from information_schema.columns
                  where table_name = 'flash_sale_capacity_movement_control'
                    and column_name = 'checkpoint_digest') as movement_digest_column`
      )) as Array<Record<string, boolean>>
      expect(evidence).toEqual([
        {
          policy_table: true,
          fence_table: true,
          outbox_table: true,
          outbox_control_table: true,
          capacity_table: true,
          identity_index: true,
          settlement_cart_index: true,
          settlement_column: true,
          capacity_check: true,
          outbox_bounded_check: true,
          movement_digest_column: true,
        },
      ])
    })

    it("upgrades a populated Phase 1 schema into an empty activatable movement ledger without changing legacy columns", async () => {
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      const manager = MikroOrmWrapper.forkManager()
      await migrator.down()
      await migrator.down()

      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-movement-upgrade', 'campaign-movement-upgrade', 3, ?,
                 'open', '2026-09-21T10:00:00Z', '2026-09-21T12:00:00Z',
                 300, 10, 4)`,
        ["1".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-movement-upgrade', 'policy-movement-upgrade',
                 'item-movement-upgrade', 0, 'open', 10, 2, 1, 3, 7,
                 jsonb_build_object('value', '10', 'precision', 20),
                 jsonb_build_object('value', '2', 'precision', 20),
                 jsonb_build_object('value', '1', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_purchase_attempt
          (id, allocation_policy_id, campaign_id, subject_id, cart_id,
           idempotency_key_hash, request_hash, state, rules_version, expires_at,
           version, terminal_at)
         values
          ('attempt-movement-held', 'policy-movement-upgrade',
           'campaign-movement-upgrade', 'subject-movement-upgrade',
           'cart-movement-held', ?, ?, 'quota_held', 3,
           '2026-09-21T11:30:00Z', 2, null),
          ('attempt-movement-consumed', 'policy-movement-upgrade',
           'campaign-movement-upgrade', 'subject-movement-upgrade',
           'cart-movement-consumed', ?, ?, 'quota_consumed', 3,
           '2026-09-21T11:00:00Z', 4, '2026-09-21T10:30:00Z')`,
        [
          "2".repeat(64),
          "3".repeat(64),
          "4".repeat(64),
          "5".repeat(64),
        ]
      )
      await manager.execute(
        `insert into flash_sale_allocation_hold
          (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
           expires_at, version, resolved_at, raw_quantity)
         values
          ('hold-movement-held', 'attempt-movement-held',
           'capacity-movement-upgrade', 'item-movement-upgrade', 2, 'held',
           '2026-09-21T11:30:00Z', 1, null,
           jsonb_build_object('value', '2', 'precision', 20)),
          ('hold-movement-consumed', 'attempt-movement-consumed',
           'capacity-movement-upgrade', 'item-movement-upgrade', 1, 'consumed',
           '2026-09-21T11:00:00Z', 2, '2026-09-21T10:30:00Z',
           jsonb_build_object('value', '1', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_subject_allocation
          (id, campaign_id, subject_id, limit_quantity, held_quantity,
           consumed_quantity, rules_version, version, raw_limit_quantity,
           raw_held_quantity, raw_consumed_quantity)
         values ('subject-allocation-movement-upgrade',
                 'campaign-movement-upgrade', 'subject-movement-upgrade',
                 10, 2, 1, 3, 7,
                 jsonb_build_object('value', '10', 'precision', 20),
                 jsonb_build_object('value', '2', 'precision', 20),
                 jsonb_build_object('value', '1', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_allocation_campaign_fence
          (id, campaign_id, disposition, campaign_version, rules_version, version)
         values ('fence-movement-upgrade', 'campaign-fenced-upgrade',
                 'ended', 8, 3, 2)`
      )
      await manager.execute(
        `insert into flash_sale_allocation_outbox_control
          (id, required_after)
         values ('allocation-outbox', '2026-09-21T09:59:00Z')`
      )
      await manager.execute(
        `insert into flash_sale_allocation_outbox_event
          (id, event_name, schema_version, aggregate_type, aggregate_id,
           aggregate_version, event_hash, payload, status, available_at,
           occurred_at)
         values ('outbox-movement-upgrade', 'flash_sale.quota_held', 1,
                 'purchase_attempt', 'attempt-movement-held', 2, ?,
                 jsonb_build_object('attempt_id', 'attempt-movement-held'),
                 'pending', '2026-09-21T10:01:00Z', '2026-09-21T10:01:00Z')`,
        ["6".repeat(64)]
      )

      const legacyTables = [
        "flash_sale_allocation_policy",
        "flash_sale_capacity",
        "flash_sale_purchase_attempt",
        "flash_sale_allocation_hold",
        "flash_sale_subject_allocation",
        "flash_sale_allocation_campaign_fence",
        "flash_sale_allocation_outbox_control",
        "flash_sale_allocation_outbox_event",
      ] as const
      const readLegacyRows = async (): Promise<Record<string, unknown>> =>
        Object.fromEntries(
          await Promise.all(
            legacyTables.map(async (table) => [
              table,
              await manager.execute(
                `select to_jsonb(record) as row from "${table}" record order by id`
              ),
            ])
          )
        )
      const readLegacyColumns = async (): Promise<unknown> =>
        await manager.execute(
          `select table_name, column_name, ordinal_position, data_type,
                  is_nullable, column_default
             from information_schema.columns
            where table_schema = current_schema()
              and table_name in (
                select value
                  from jsonb_array_elements_text(?::jsonb) selected(value)
              )
            order by table_name, ordinal_position`,
          [JSON.stringify(legacyTables)]
        )
      const rowsBefore = await readLegacyRows()
      const columnsBefore = await readLegacyColumns()

      await migrator.up()

      expect(await readLegacyRows()).toEqual(rowsBefore)
      expect(await readLegacyColumns()).toEqual(columnsBefore)
      expect(
        await manager.execute(
          `select
             (select count(*)::int from flash_sale_capacity_movement) as movements,
             (select count(*)::int from flash_sale_capacity_movement_checkpoint) as checkpoints,
             (select count(*)::int from flash_sale_capacity_movement_control) as controls`
        )
      ).toEqual([{ movements: 0, checkpoints: 0, controls: 0 }])

      await expect(
        service.activateAllocationMovementLedger({})
      ).resolves.toMatchObject({
        checkpoint_count: 1,
        replayed: false,
        schema_version: 1,
      })
      expect(
        await manager.execute(
          `select
             (select count(*)::int from flash_sale_capacity_movement) as movements,
             (select count(*)::int from flash_sale_capacity_movement_checkpoint) as checkpoints,
             (select count(*)::int from flash_sale_capacity_movement_control) as controls`
        )
      ).toEqual([{ movements: 0, checkpoints: 1, controls: 1 }])
      await expect(migrator.down()).rejects.toThrow(
        "refusing to downgrade non-empty capacity movement ledger"
      )
      expect(
        await manager.execute(
          `select exists(
             select 1 from information_schema.columns
              where table_name = 'flash_sale_capacity_movement_control'
                and column_name = 'checkpoint_digest'
           ) as digest_column`
        )
      ).toEqual([{ digest_column: true }])
    })

    it("blocks the original movement-table downgrade after the digest migration is removed", async () => {
      const manager = MikroOrmWrapper.forkManager()
      const migrator = MikroOrmWrapper.getOrm().getMigrator()

      // The newest migration may be removed only while all ledger tables are
      // empty. Populate the older control shape afterwards to exercise the
      // independent guard in the original table-creation migration.
      await migrator.down()
      await manager.execute(
        `insert into flash_sale_capacity_movement_control
          (id, activation_id, required_after, schema_version)
         values ('allocation-movement-ledger', 'older-guard-proof', now(), 1)`
      )

      await expect(migrator.down()).rejects.toThrow(
        "refusing to downgrade non-empty capacity movement ledger"
      )
      expect(
        await manager.execute(
          `select
             to_regclass('public.flash_sale_capacity_movement') is not null as movement_table,
             to_regclass('public.flash_sale_capacity_movement_checkpoint') is not null as checkpoint_table,
             to_regclass('public.flash_sale_capacity_movement_control') is not null as control_table`
        )
      ).toEqual([
        {
          movement_table: true,
          checkpoint_table: true,
          control_table: true,
        },
      ])
    })

    it("allows movement-ledger downgrade preflight only when all three physical tables are empty", async () => {
      const manager = MikroOrmWrapper.forkManager()
      await expect(
        preflightMovementLedgerSchemaDowngrade(manager as SqlEntityManager)
      ).resolves.toEqual({
        movement_rows: 0,
        checkpoint_rows: 0,
        control_rows: 0,
        safe: true,
      })

      await manager.execute(
        `insert into flash_sale_capacity_movement_control
          (id, activation_id, required_after, schema_version, checkpoint_digest)
         values ('allocation-movement-ledger', 'active-downgrade-test', now(), 1, ?)`,
        ["b".repeat(64)]
      )
      await expect(
        preflightMovementLedgerSchemaDowngrade(manager as SqlEntityManager)
      ).rejects.toThrow("control=1")
      await manager.execute("delete from flash_sale_capacity_movement_control")

      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-downgrade-preflight', 'campaign-downgrade-preflight',
                 1, ?, 'open', now() - interval '1 minute',
                 now() + interval '1 hour', 300, 5, 1)`,
        ["7".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-downgrade-preflight', 'policy-downgrade-preflight',
                 'item-downgrade-preflight', 0, 'open', 5, 0, 0, 1, 1,
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_capacity_movement_checkpoint
          (id, activation_id, capacity_id, campaign_item_id, shard_no,
           opening_granted_quantity, opening_available_quantity,
           opening_held_quantity, opening_consumed_quantity, capacity_version,
           activated_at, raw_opening_granted_quantity,
           raw_opening_available_quantity, raw_opening_held_quantity,
           raw_opening_consumed_quantity, deleted_at)
         values ('checkpoint-downgrade-preflight', 'deleted-checkpoint',
                 'capacity-downgrade-preflight', 'item-downgrade-preflight', 0,
                 5, 5, 0, 0, 1, now(),
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20), now())`
      )
      await expect(
        preflightMovementLedgerSchemaDowngrade(manager as SqlEntityManager)
      ).rejects.toThrow("checkpoint=1")
      await manager.execute("delete from flash_sale_capacity_movement_checkpoint")

      await manager.execute(
        `insert into flash_sale_purchase_attempt
          (id, allocation_policy_id, campaign_id, subject_id, cart_id,
           idempotency_key_hash, request_hash, state, rules_version, expires_at,
           version)
         values ('attempt-downgrade-preflight', 'policy-downgrade-preflight',
                 'campaign-downgrade-preflight', 'subject-downgrade-preflight',
                 null, ?, ?, 'quota_held', 1, now() + interval '5 minutes', 2)`,
        ["8".repeat(64), "9".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity, deleted_at)
         values ('movement-downgrade-preflight', 'capacity-downgrade-preflight',
                 'attempt-downgrade-preflight', 'campaign-downgrade-preflight',
                 'subject-downgrade-preflight', 'item-downgrade-preflight', 2,
                 'hold', 'available', 'held', 1, ?,
                 jsonb_build_object('value', '1', 'precision', 20), now())`,
        ["a".repeat(64)]
      )
      await expect(
        preflightMovementLedgerSchemaDowngrade(manager as SqlEntityManager)
      ).rejects.toThrow("movement=1")
    })

    it("holds exclusive movement-table locks for the duration of downgrade inspection", async () => {
      const manager = MikroOrmWrapper.forkManager()
      const competingManager = MikroOrmWrapper.forkManager()
      await manager.transactional(async (transaction) => {
        await expect(
          lockAndInspectMovementLedgerDowngrade(
            transaction as SqlEntityManager
          )
        ).resolves.toMatchObject({ safe: true })
        await expect(
          competingManager.transactional(async (competitor) => {
            await competitor.execute("set local lock_timeout = '100ms'")
            await competitor.execute(
              `insert into flash_sale_capacity_movement_control
                (id, activation_id, required_after, schema_version, checkpoint_digest)
               values ('allocation-movement-ledger', 'blocked-by-preflight', now(), 1, ?)`,
              ["c".repeat(64)]
            )
          })
        ).rejects.toThrow(/lock timeout|canceling statement/i)
      })
    })

    it("upgrades populated pre-expiry states without changing old rows", async () => {
      const orm = MikroOrmWrapper.getOrm()
      const migrator = orm.getMigrator()
      const manager = MikroOrmWrapper.forkManager()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-fence-upgrade-sentinel', 'campaign-fence-upgrade-sentinel',
                 4, ?, 'closed', now() - interval '1 hour',
                 now() + interval '1 hour', 180, 3, 5)`,
        ["e".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-expiry-upgrade-sentinel', 'policy-fence-upgrade-sentinel',
                 'item-expiry-upgrade-sentinel', 0, 'closed', 5, 0, 0, 4, 1,
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_purchase_attempt
          (id, allocation_policy_id, campaign_id, subject_id, cart_id,
           idempotency_key_hash, request_hash, state, rules_version, expires_at,
           version, terminal_at)
         values ('attempt-expiry-upgrade-sentinel', 'policy-fence-upgrade-sentinel',
                 'campaign-fence-upgrade-sentinel', 'subject-expiry-upgrade-sentinel',
                 null, ?, ?, 'quota_released', 4, now() - interval '1 hour', 2, now())`,
        ["a".repeat(64), "b".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_allocation_hold
          (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
           expires_at, version, resolved_at, raw_quantity)
         values ('hold-expiry-upgrade-sentinel', 'attempt-expiry-upgrade-sentinel',
                 'capacity-expiry-upgrade-sentinel', 'item-expiry-upgrade-sentinel',
                 1, 'released', now() - interval '1 hour', 2, now(),
                 jsonb_build_object('value', '1', 'precision', 20))`
      )
      const before = await manager.execute(
        `select id, campaign_id, rules_version, configuration_hash, state,
                hold_ttl_seconds, per_subject_limit, version
           from flash_sale_allocation_policy
          where id = 'policy-fence-upgrade-sentinel'`
      )

      await migrator.up()

      expect(
        await manager.execute(
          `select id, campaign_id, rules_version, configuration_hash, state,
                  hold_ttl_seconds, per_subject_limit, version
             from flash_sale_allocation_policy
            where id = 'policy-fence-upgrade-sentinel'`
        )
      ).toEqual(before)
      expect(
        await manager.execute(
          `select a.state as attempt_state, a.settlement_id,
                  a.settlement_started_at, h.state as hold_state
             from flash_sale_purchase_attempt a
             join flash_sale_allocation_hold h on h.attempt_id = a.id
            where a.id = 'attempt-expiry-upgrade-sentinel'`
        )
      ).toEqual([
        {
          attempt_state: "quota_released",
          settlement_id: null,
          settlement_started_at: null,
          hold_state: "released",
        },
      ])
      const evidence = (await manager.execute(
        `select
          pg_get_constraintdef(a.oid) like '%quota_expired%' as attempt_expiry,
          pg_get_constraintdef(h.oid) like '%expired%' as hold_expiry
         from pg_constraint a, pg_constraint h
        where a.conname = 'flash_sale_purchase_attempt_state_check'
          and h.conname = 'flash_sale_allocation_hold_state_check'`
      )) as Array<Record<string, boolean>>
      expect(evidence).toEqual([{ attempt_expiry: true, hold_expiry: true }])
    })

    it("prepares real expired data before a safe offline schema downgrade", async () => {
      const manager = MikroOrmWrapper.forkManager()
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-expiry-downgrade', 'campaign-expiry-downgrade', 1, ?,
                 'open', now() - interval '1 minute', now() + interval '1 hour',
                 300, 5, 1)`,
        ["c".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-expiry-downgrade', 'policy-expiry-downgrade',
                 'item-expiry-downgrade', 0, 'open', 5, 0, 0, 1, 1,
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20))`
      )
      const held = await service.claimAndHoldQuota({
        campaign_id: "campaign-expiry-downgrade",
        subject_id: "subject-expiry-downgrade",
        cart_id: "cart-expiry-downgrade",
        idempotency_key_hash: "d".repeat(64),
        expected_rules_version: 1,
        items: [{ campaign_item_id: "item-expiry-downgrade", quantity: 2 }],
      })
      if (held.status !== "held") {
        expect(held.status).toBe("held")
        return
      }
      await manager.execute(
        `update flash_sale_purchase_attempt
            set expires_at = now() - interval '1 second' where id = ?`,
        [held.attempt.id]
      )
      await manager.execute(
        `update flash_sale_allocation_hold
            set expires_at = now() - interval '1 second' where attempt_id = ?`,
        [held.attempt.id]
      )
      await service.expireQuota({ attempt_id: held.attempt.id })
      const terminalBefore = await manager.execute(
        `select a.terminal_at, h.resolved_at
           from flash_sale_purchase_attempt a
           join flash_sale_allocation_hold h on h.attempt_id = a.id
          where a.id = ?`,
        [held.attempt.id]
      )

      const overProtocolBindLimit = [
        held.attempt.id,
        ...Array.from(
          { length: 65_599 },
          (_, index) => `nonexistent-expiry-downgrade-${index}`
        ),
      ]
      const locked = await manager.transactional(async (transaction) =>
        lockExpiryDowngradeCandidates(
          transaction as SqlEntityManager,
          overProtocolBindLimit
        )
      )
      expect(overProtocolBindLimit).toHaveLength(65_600)
      expect(locked.attempts.map((attempt) => attempt.id)).toEqual([
        held.attempt.id,
      ])
      expect(locked.holds.map((hold) => hold.attempt_id)).toEqual([
        held.attempt.id,
      ])

      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await expect(migrator.down()).rejects.toThrow()
      await expect(
        prepareExpirySchemaDowngrade(manager as SqlEntityManager, "dry-run")
      ).resolves.toEqual({
        mode: "dry-run",
        attempts: 1,
        holds: 1,
        audit_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
      })
      expect(
        await manager.execute(
          "select state from flash_sale_purchase_attempt where id = ?",
          [held.attempt.id]
        )
      ).toEqual([{ state: "quota_expired" }])
      await expect(
        prepareExpirySchemaDowngrade(manager as SqlEntityManager, "execute")
      ).resolves.toEqual({
        mode: "execute",
        attempts: 1,
        holds: 1,
        audit_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
      })

      expect(
        await manager.execute(
          `select a.state as attempt_state, a.last_error_code,
                  a.terminal_at, h.state as hold_state, h.resolved_at
             from flash_sale_purchase_attempt a
             join flash_sale_allocation_hold h on h.attempt_id = a.id
            where a.id = ?`,
          [held.attempt.id]
        )
      ).toEqual([
        {
          attempt_state: "quota_released",
          last_error_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
          terminal_at: (terminalBefore as Array<{ terminal_at: Date }>)[0]
            .terminal_at,
          hold_state: "released",
          resolved_at: (terminalBefore as Array<{ resolved_at: Date }>)[0]
            .resolved_at,
        },
      ])

      await migrator.down()
      const oldSchema = await manager.execute(
        `select
          pg_get_constraintdef(a.oid) not like '%quota_expired%' as old_attempt_constraint,
          pg_get_constraintdef(h.oid) not like '%expired%' as old_hold_constraint
         from pg_constraint a, pg_constraint h
        where a.conname = 'flash_sale_purchase_attempt_state_check'
          and h.conname = 'flash_sale_allocation_hold_state_check'`
      )
      expect(oldSchema).toEqual([
        { old_attempt_constraint: true, old_hold_constraint: true },
      ])
      expect(
        await manager.execute(
          `select state, last_error_code from flash_sale_purchase_attempt
            where id = ?`,
          [held.attempt.id]
        )
      ).toEqual([
        {
          state: "quota_released",
          last_error_code: EXPIRY_DOWNGRADE_AUDIT_CODE,
        },
      ])
      await migrator.up()
    })

    it("rejects an inconsistent expired Attempt/Hold set without partial conversion", async () => {
      const manager = MikroOrmWrapper.forkManager()
      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-expiry-inconsistent', 'campaign-expiry-inconsistent',
                 1, ?, 'closed', now() - interval '2 hours',
                 now() - interval '1 hour', 300, 5, 1)`,
        ["f".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-expiry-inconsistent', 'policy-expiry-inconsistent',
                 'item-expiry-inconsistent', 0, 'closed', 5, 0, 0, 1, 1,
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20))`
      )
      await manager.execute(
        `insert into flash_sale_purchase_attempt
          (id, allocation_policy_id, campaign_id, subject_id, cart_id,
           idempotency_key_hash, request_hash, state, rules_version,
           expires_at, version, terminal_at)
         values ('attempt-expiry-inconsistent', 'policy-expiry-inconsistent',
                 'campaign-expiry-inconsistent', 'subject-expiry-inconsistent',
                 null, ?, ?, 'quota_expired', 1, now() - interval '1 hour',
                 2, now())`,
        ["1".repeat(64), "2".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_allocation_hold
          (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
           expires_at, version, resolved_at, raw_quantity)
         values ('hold-expiry-inconsistent', 'attempt-expiry-inconsistent',
                 'capacity-expiry-inconsistent', 'item-expiry-inconsistent',
                 1, 'released', now() - interval '1 hour', 2, now(),
                 jsonb_build_object('value', '1', 'precision', 20))`
      )

      await expect(
        prepareExpirySchemaDowngrade(manager as SqlEntityManager, "execute")
      ).rejects.toMatchObject({
        code: "ALLOCATION_INVARIANT_VIOLATION",
      })
      expect(
        await manager.execute(
          `select a.state as attempt_state, a.last_error_code,
                  h.state as hold_state
             from flash_sale_purchase_attempt a
             join flash_sale_allocation_hold h on h.attempt_id = a.id
            where a.id = 'attempt-expiry-inconsistent'`
        )
      ).toEqual([
        {
          attempt_state: "quota_expired",
          last_error_code: null,
          hold_state: "released",
        },
      ])
    })

    it("blocks schema downgrade while a settlement is committing", async () => {
      const manager = MikroOrmWrapper.forkManager()
      const migrator = MikroOrmWrapper.getOrm().getMigrator()
      await manager.execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state,
           starts_at, ends_at, hold_ttl_seconds, per_subject_limit, version)
         values ('policy-settlement-downgrade', 'campaign-settlement-downgrade',
                 1, ?, 'open', now() - interval '1 minute',
                 now() + interval '1 hour', 300, 5, 1)`,
        ["7".repeat(64)]
      )
      await manager.execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity, raw_consumed_quantity)
         values ('capacity-settlement-downgrade', 'policy-settlement-downgrade',
                 'item-settlement-downgrade', 0, 'open', 5, 0, 0, 1, 1,
                 jsonb_build_object('value', '5', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20),
                 jsonb_build_object('value', '0', 'precision', 20))`
      )
      const held = await service.claimAndHoldQuota({
        campaign_id: "campaign-settlement-downgrade",
        subject_id: "subject-settlement-downgrade",
        cart_id: "cart-settlement-downgrade",
        idempotency_key_hash: "8".repeat(64),
        expected_rules_version: 1,
        items: [{ campaign_item_id: "item-settlement-downgrade", quantity: 2 }],
      })
      if (held.status !== "held") {
        throw new Error("Expected a held downgrade fixture")
      }
      const command = {
        attempt_id: held.attempt.id,
        settlement_id: "settlement-downgrade",
      }
      await service.beginQuotaSettlement(command)

      await migrator.down()
      await migrator.down()
      await migrator.down()
      await migrator.down()
      await expect(migrator.down()).rejects.toThrow()
      await expect(
        prepareExpirySchemaDowngrade(manager as SqlEntityManager, "dry-run")
      ).rejects.toThrow("QUOTA_COMMITTING")
      expect(
        await manager.execute(
          `select state, settlement_id from flash_sale_purchase_attempt
            where id = ?`,
          [held.attempt.id]
        )
      ).toEqual([
        {
          state: "quota_committing",
          settlement_id: command.settlement_id,
        },
      ])

      await migrator.up()
      await service.releaseQuotaSettlement(command)
      await expect(
        prepareExpirySchemaDowngrade(manager as SqlEntityManager, "dry-run")
      ).resolves.toMatchObject({ attempts: 0, holds: 0 })
    })
  },
})

moduleIntegrationTestRunner<FlashSaleAllocationModuleService>({
  moduleName: FlashSalePluginModule.ALLOCATION,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  dbName: "medusa-flash-sale-allocation",
  moduleModels: models,
  pathToMigrations: campaignMigrations,
  testSuite: ({ MikroOrmWrapper, dbConfig }) => {
    it("upgrades a populated Campaign schema through Allocation and Checkout without data loss", async () => {
      const manager = MikroOrmWrapper.forkManager()
      await manager.execute(
        `insert into flash_sale_campaign
          (id, name, description, state, starts_at, ends_at, version,
           rules_version, campaign_epoch, hold_ttl_seconds, per_subject_limit,
           metadata)
         values (?, ?, ?, 'active', now() - interval '1 minute',
                 now() + interval '1 hour', 7, 3, 2, 180, 4, ?::jsonb)`,
        [
          "campaign-upgrade-sentinel",
          "Phase 1A sentinel",
          "must survive allocation upgrade",
          JSON.stringify({ owner: "phase-1a" }),
        ]
      )
      await manager.execute(
        `insert into flash_sale_campaign_item
          (id, campaign_id, variant_id, location_id, quota, version, metadata,
           raw_quota)
         values (?, ?, ?, ?, 37, 5, ?::jsonb,
                 jsonb_build_object('value', '37', 'precision', 20))`,
        [
          "campaign-item-upgrade-sentinel",
          "campaign-upgrade-sentinel",
          "variant-sentinel",
          "location-sentinel",
          JSON.stringify({ source: "phase-1a" }),
        ]
      )
      const sentinelQuery = `select c.id as campaign_id, c.name, c.description,
          c.state, c.version, c.rules_version, c.campaign_epoch,
          c.hold_ttl_seconds, c.per_subject_limit, c.metadata,
          i.id as item_id, i.campaign_id as item_campaign_id, i.variant_id,
          i.location_id, i.quota::text, i.version as item_version, i.metadata as item_metadata,
          i.raw_quota
        from flash_sale_campaign c
        join flash_sale_campaign_item i on i.campaign_id = c.id
        where c.id = 'campaign-upgrade-sentinel'`
      const before = await manager.execute(sentinelQuery)

      const allocationOrm = await MikroORM.init(
        defineConfig({
          clientUrl: dbConfig.clientUrl,
          schema: dbConfig.schema,
          entities: [],
          discovery: { warnWhenNoEntities: false },
          migrations: {
            path: allocationMigrations,
            pathTs: allocationMigrations,
            silent: true,
            snapshot: false,
          },
          extensions: [CustomDBMigrator],
        })
      )
      try {
        await allocationOrm.getMigrator().up()
      } finally {
        await allocationOrm.close(true)
      }

      const checkoutOrm = await MikroORM.init(
        defineConfig({
          clientUrl: dbConfig.clientUrl,
          schema: dbConfig.schema,
          entities: [],
          discovery: { warnWhenNoEntities: false },
          migrations: {
            path: checkoutMigrations,
            pathTs: checkoutMigrations,
            silent: true,
            snapshot: false,
          },
          extensions: [CustomDBMigrator],
        })
      )
      try {
        await checkoutOrm.getMigrator().up()
      } finally {
        await checkoutOrm.close(true)
      }

      expect(await manager.execute(sentinelQuery)).toEqual(before)
      const evidence = (await manager.execute(
        `select
          to_regclass('public.flash_sale_campaign') is not null as campaign_table,
          to_regclass('public.flash_sale_campaign_item') is not null as campaign_item_table,
          to_regclass('public.flash_sale_allocation_policy') is not null as policy_table,
          to_regclass('public.flash_sale_purchase_attempt') is not null as attempt_table,
          to_regclass('public.flash_sale_allocation_campaign_fence') is not null as fence_table,
          to_regclass('public.flash_sale_checkout_execution') is not null as checkout_table,
          to_regclass('public.flash_sale_checkout_execution_item') is not null as checkout_item_table,
          exists(select 1 from pg_indexes
                  where indexname = 'IDX_flash_sale_allocation_policy_campaign_rules_unique') as policy_history_index,
          exists(select 1 from pg_constraint
                  where conname = 'ck_flash_sale_subject_balance') as subject_check`
      )) as Array<Record<string, boolean>>
      expect(evidence).toEqual([
        {
          campaign_table: true,
          campaign_item_table: true,
          policy_table: true,
          attempt_table: true,
          fence_table: true,
          checkout_table: true,
          checkout_item_table: true,
          policy_history_index: true,
          subject_check: true,
        },
      ])
    })
  },
})
