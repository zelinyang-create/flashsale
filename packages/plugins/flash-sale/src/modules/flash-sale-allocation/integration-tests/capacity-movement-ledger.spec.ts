import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { AllocationCommandErrorCode } from "../application"
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
import FlashSaleAllocationModuleService, {
  WRITE_COMMAND_REQUIRED,
} from "../service"

jest.setTimeout(120000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (prefix: string) => `${prefix}-${process.pid}-${++sequence}`

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

    async function seedPopulatedCapacity() {
      const policyId = id("fsapol")
      const campaignId = id("campaign")
      const capacityId = id("fscap")
      const itemId = id("item")
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 hour',
                 now() + interval '1 hour', 300, 10, 1)`,
        [policyId, campaignId, "a".repeat(64), AllocationPolicyState.OPEN]
      )
      await execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity,
           raw_consumed_quantity)
         values (?, ?, ?, 0, ?, 10, 2, 1, 1, 4,
           jsonb_build_object('value', '10', 'precision', 20),
           jsonb_build_object('value', '2', 'precision', 20),
           jsonb_build_object('value', '1', 'precision', 20))`,
        [capacityId, policyId, itemId, CapacityState.OPEN]
      )
      const attemptIds: string[] = []
      for (const [state, quantity] of [
        [AllocationHoldState.HELD, 2],
        [AllocationHoldState.CONSUMED, 1],
      ] as const) {
        const attemptId = id("fsatt")
        attemptIds.push(attemptId)
        await execute(
          `insert into flash_sale_purchase_attempt
            (id, allocation_policy_id, campaign_id, subject_id, cart_id,
             idempotency_key_hash, request_hash, state, rules_version,
             expires_at, version)
           values (?, ?, ?, ?, ?, ?, ?, ?, 1, now() + interval '5 minutes', 1)`,
          [
            attemptId,
            policyId,
            campaignId,
            id("subject"),
            id("cart"),
            sequence.toString(16).padStart(64, "0"),
            (sequence + 100).toString(16).padStart(64, "0"),
            state === AllocationHoldState.HELD
              ? PurchaseAttemptState.QUOTA_HELD
              : PurchaseAttemptState.QUOTA_CONSUMED,
          ]
        )
        await execute(
          `insert into flash_sale_allocation_hold
            (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
             expires_at, version, resolved_at, raw_quantity)
           values (?, ?, ?, ?, ?, ?, now() + interval '5 minutes', 1,
                   case when ? = 'consumed' then now() else null end,
                   jsonb_build_object('value', ?::text, 'precision', 20))`,
          [
            id("fshold"),
            attemptId,
            capacityId,
            itemId,
            quantity,
            state,
            state,
            quantity,
          ]
        )
      }
      return { capacityId, itemId, campaignId, attemptIds }
    }

    it("migrates a fresh schema and activates an empty baseline", async () => {
      const tables = (await execute(
        `select table_name from information_schema.tables
          where table_schema = current_schema()
            and table_name in (
              'flash_sale_capacity_movement',
              'flash_sale_capacity_movement_checkpoint',
              'flash_sale_capacity_movement_control')`
      )) as Array<{ table_name: string }>
      expect(tables).toHaveLength(3)
      await expect(
        service.activateAllocationMovementLedger({})
      ).resolves.toMatchObject({
        schema_version: 1,
        checkpoint_count: 0,
        replayed: false,
      })
      const controls = (await execute(
        `select id, checkpoint_digest from flash_sale_capacity_movement_control`
      )) as Array<{ id: string; checkpoint_digest: string }>
      expect(controls).toEqual([
        {
          id: "allocation-movement-ledger",
          checkpoint_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ])
    })

    it("checkpoints populated Phase 1 balances without fabricating movements", async () => {
      const { capacityId, itemId } = await seedPopulatedCapacity()
      const first = await service.activateAllocationMovementLedger({})
      expect(first).toMatchObject({ checkpoint_count: 1, replayed: false })
      const checkpoints = (await execute(
        `select activation_id, capacity_id, campaign_item_id, shard_no,
                opening_granted_quantity::text as granted,
                opening_available_quantity::text as available,
                opening_held_quantity::text as held,
                opening_consumed_quantity::text as consumed,
                capacity_version
           from flash_sale_capacity_movement_checkpoint`
      )) as Array<Record<string, unknown>>
      expect(checkpoints).toEqual([
        expect.objectContaining({
          activation_id: first.activation_id,
          capacity_id: capacityId,
          campaign_item_id: itemId,
          shard_no: 0,
          granted: "10",
          available: "7",
          held: "2",
          consumed: "1",
          capacity_version: 4,
        }),
      ])
      expect(
        await execute("select id from flash_sale_capacity_movement")
      ).toEqual([])

      const replay = await service.activateAllocationMovementLedger({})
      expect(replay).toEqual({ ...first, replayed: true })
    })

    it("rejects any physical pre-activation movement, including soft-deleted rows", async () => {
      const { capacityId, itemId, campaignId, attemptIds } =
        await seedPopulatedCapacity()
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity, deleted_at)
         values (?, ?, ?, ?, 'subject-preactivation', ?, 2, 'hold',
                 'available', 'held', 1, ?,
                 jsonb_build_object('value', '1', 'precision', 20), now())`,
        [
          id("fsmov"),
          capacityId,
          attemptIds[0],
          campaignId,
          itemId,
          "a".repeat(64),
        ]
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails closed when a partial checkpoint exists without the commit marker", async () => {
      const { capacityId, itemId } = await seedPopulatedCapacity()
      await execute(
        `insert into flash_sale_capacity_movement_checkpoint
          (id, activation_id, capacity_id, campaign_item_id, shard_no,
           opening_granted_quantity, opening_available_quantity,
           opening_held_quantity, opening_consumed_quantity, capacity_version,
           activated_at, raw_opening_granted_quantity,
           raw_opening_available_quantity, raw_opening_held_quantity,
           raw_opening_consumed_quantity)
         values (?, 'partial', ?, ?, 0, 10, 7, 2, 1, 4, now(),
           jsonb_build_object('value', '10', 'precision', 20),
           jsonb_build_object('value', '7', 'precision', 20),
           jsonb_build_object('value', '2', 'precision', 20),
           jsonb_build_object('value', '1', 'precision', 20))`,
        [id("fsmovcp"), capacityId, itemId]
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      expect(
        await execute("select id from flash_sale_capacity_movement_control")
      ).toEqual([])
    })

    it("fails closed when an idempotent replay finds an incomplete checkpoint set", async () => {
      await seedPopulatedCapacity()
      const activated = await service.activateAllocationMovementLedger({})
      await execute(
        `delete from flash_sale_capacity_movement_checkpoint
          where activation_id = ?`,
        [activated.activation_id]
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it.each([
      [
        "raw quantity drift",
        `update flash_sale_capacity_movement_checkpoint
            set raw_opening_held_quantity = jsonb_build_object('value', '9', 'precision', 20)`,
      ],
      [
        "activation timestamp drift",
        `update flash_sale_capacity_movement_checkpoint
            set activated_at = activated_at + interval '1 second'`,
      ],
      [
        "foreign activation",
        `update flash_sale_capacity_movement_checkpoint
            set activation_id = 'foreign-activation'`,
      ],
      [
        "soft-deleted checkpoint",
        `update flash_sale_capacity_movement_checkpoint set deleted_at = now()`,
      ],
      [
        "control digest drift",
        `update flash_sale_capacity_movement_control
            set checkpoint_digest = '${"c".repeat(64)}'`,
      ],
      [
        "semantically valid checkpoint id drift",
        `update flash_sale_capacity_movement_checkpoint
            set id = 'fsmovcp-digest-drift'`,
      ],
    ])("fails closed on replay after %s", async (_label, mutation) => {
      await seedPopulatedCapacity()
      await service.activateAllocationMovementLedger({})
      await execute(mutation)
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails closed when the sole control row is soft-deleted", async () => {
      await service.activateAllocationMovementLedger({})
      await execute(
        `update flash_sale_capacity_movement_control set deleted_at = now()`
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("rejects a baseline whose materialized held balance has no matching hold", async () => {
      const policyId = id("fsapol")
      await execute(
        `insert into flash_sale_allocation_policy
          (id, campaign_id, rules_version, configuration_hash, state, starts_at,
           ends_at, hold_ttl_seconds, per_subject_limit, version)
         values (?, ?, 1, ?, ?, now() - interval '1 hour',
                 now() + interval '1 hour', 300, 10, 1)`,
        [policyId, id("campaign"), "b".repeat(64), AllocationPolicyState.OPEN]
      )
      await execute(
        `insert into flash_sale_capacity
          (id, allocation_policy_id, campaign_item_id, shard_no, state,
           granted_quantity, held_quantity, consumed_quantity, rules_version,
           version, raw_granted_quantity, raw_held_quantity,
           raw_consumed_quantity)
         values (?, ?, ?, 0, ?, 10, 1, 0, 1, 1,
           jsonb_build_object('value', '10', 'precision', 20),
           jsonb_build_object('value', '1', 'precision', 20),
           jsonb_build_object('value', '0', 'precision', 20))`,
        [id("fscap"), policyId, id("item"), CapacityState.OPEN]
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      expect(
        await execute("select id from flash_sale_capacity_movement_control")
      ).toEqual([])
    })

    it.each([
      [
        "hold item identity",
        `update flash_sale_allocation_hold set campaign_item_id = 'wrong-item'
          where state = 'held'`,
      ],
      [
        "hold raw quantity",
        `update flash_sale_allocation_hold
            set raw_quantity = jsonb_build_object('value', '9', 'precision', 20)
          where state = 'held'`,
      ],
    ])("rejects a baseline with corrupt %s", async (_label, mutation) => {
      await seedPopulatedCapacity()
      await execute(mutation)
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("enforces movement and checkpoint constraints in PostgreSQL", async () => {
      const { capacityId, itemId, campaignId, attemptIds } =
        await seedPopulatedCapacity()
      const insertMovement = async (
        movementId: string,
        kind: string,
        fromBucket: string,
        toBucket: string
      ) =>
        await execute(
          `insert into flash_sale_capacity_movement
            (id, capacity_id, attempt_id, campaign_id, subject_id,
             campaign_item_id, transition_version, kind, from_bucket,
             to_bucket, quantity, fence_token, raw_quantity)
           values (?, ?, ?, ?, 'subject-constraint', ?, 2, ?, ?, ?, 1, ?,
                   jsonb_build_object('value', '1', 'precision', 20))`,
          [
            movementId,
            capacityId,
            attemptIds[0],
            campaignId,
            itemId,
            kind,
            fromBucket,
            toBucket,
            "b".repeat(64),
          ]
        )
      await expect(
        insertMovement(id("fsmov"), "hold", "held", "available")
      ).rejects.toThrow()
      const validMovementId = id("fsmov")
      await insertMovement(validMovementId, "hold", "available", "held")
      await expect(
        insertMovement(id("fsmov"), "hold", "available", "held")
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement set transition_version = 0 where id = ?",
          [validMovementId]
        )
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement set quantity = 0 where id = ?",
          [validMovementId]
        )
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement set fence_token = 'bad' where id = ?",
          [validMovementId]
        )
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement set campaign_id = '' where id = ?",
          [validMovementId]
        )
      ).rejects.toThrow()

      const insertCheckpoint = async (
        checkpointId: string,
        available: number
      ) =>
        await execute(
          `insert into flash_sale_capacity_movement_checkpoint
            (id, activation_id, capacity_id, campaign_item_id, shard_no,
             opening_granted_quantity, opening_available_quantity,
             opening_held_quantity, opening_consumed_quantity,
             capacity_version, activated_at, raw_opening_granted_quantity,
             raw_opening_available_quantity, raw_opening_held_quantity,
             raw_opening_consumed_quantity)
           values (?, 'constraint-activation', ?, ?, 0, 10, ?, 2, 1, 4,
                   now(),
                   jsonb_build_object('value', '10', 'precision', 20),
                   jsonb_build_object('value', ?::text, 'precision', 20),
                   jsonb_build_object('value', '2', 'precision', 20),
                   jsonb_build_object('value', '1', 'precision', 20))`,
          [checkpointId, capacityId, itemId, available, available]
        )
      await expect(insertCheckpoint(id("fsmovcp"), 8)).rejects.toThrow()
      const validCheckpointId = id("fsmovcp")
      await insertCheckpoint(validCheckpointId, 7)
      await expect(insertCheckpoint(id("fsmovcp"), 7)).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement_checkpoint set capacity_version = 0 where id = ?",
          [validCheckpointId]
        )
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement_checkpoint set shard_no = -1 where id = ?",
          [validCheckpointId]
        )
      ).rejects.toThrow()
      await expect(
        execute(
          "update flash_sale_capacity_movement_checkpoint set activation_id = '' where id = ?",
          [validCheckpointId]
        )
      ).rejects.toThrow()

      await expect(
        execute(
          `insert into flash_sale_capacity_movement_control
            (id, activation_id, required_after, schema_version, checkpoint_digest)
           values ('allocation-movement-ledger', 'activation', now(), 1, 'bad')`
        )
      ).rejects.toThrow()
      await expect(
        execute(
          `insert into flash_sale_capacity_movement_control
            (id, activation_id, required_after, schema_version, checkpoint_digest)
           values ('not-the-ledger-singleton', 'activation', now(), 1, ?)`,
          ["d".repeat(64)]
        )
      ).rejects.toThrow()
    })

    it("blocks every generated write surface for all ledger models", async () => {
      const methods = [
        "createCapacityMovements",
        "updateCapacityMovements",
        "upsertCapacityMovements",
        "deleteCapacityMovements",
        "softDeleteCapacityMovements",
        "restoreCapacityMovements",
        "createCapacityMovementCheckpoints",
        "updateCapacityMovementCheckpoints",
        "upsertCapacityMovementCheckpoints",
        "deleteCapacityMovementCheckpoints",
        "softDeleteCapacityMovementCheckpoints",
        "restoreCapacityMovementCheckpoints",
        "createCapacityMovementControls",
        "updateCapacityMovementControls",
        "upsertCapacityMovementControls",
        "deleteCapacityMovementControls",
        "softDeleteCapacityMovementControls",
        "restoreCapacityMovementControls",
      ] as const
      for (const method of methods) {
        await expect(
          (service[method] as unknown as () => Promise<never>)()
        ).rejects.toMatchObject({ message: WRITE_COMMAND_REQUIRED })
      }
    })
  },
})
