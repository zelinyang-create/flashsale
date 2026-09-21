import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import path from "path"
import {
  AllocationCommandErrorCode,
  ClaimAndHoldQuotaCommand,
  ProvisionAllocationCommand,
  createAllocationConfigurationHash,
} from "../application"
import {
  AllocationPolicyState,
  CapacityMovementBucket,
  CapacityMovementCheckpointKind,
  CapacityMovementKind,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../../../types"
import { createCapacityMovementFingerprint } from "../domain"
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
import { PostgresAllocationAttemptStore } from "../persistence"
import FlashSaleAllocationModuleService from "../service"

jest.setTimeout(240000)

type Execute = (sql: string, params?: unknown[]) => Promise<unknown[]>
let sequence = 0
const id = (label: string) => `${label}-movement-writer-${process.pid}-${++sequence}`
const hash = (value: number) => value.toString(16).padStart(64, "0")

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

    const provisionCommand = (
      campaignId: string,
      itemIds: readonly string[] = [`${campaignId}-item`]
    ): ProvisionAllocationCommand => {
      const base = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 20,
        items: itemIds.map((campaign_item_id) => ({
          campaign_item_id,
          quota: 100,
        })),
      }
      return {
        ...base,
        configuration_hash: createAllocationConfigurationHash(base),
      }
    }

    async function provisionOpen(
      campaignId = id("campaign"),
      itemIds: readonly string[] = [`${campaignId}-item`]
    ) {
      const command = provisionCommand(campaignId, itemIds)
      const provisioned = await service.provisionAllocation(command)
      await service.openAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
      return { command, provisioned, campaignId, itemIds }
    }

    const holdCommand = (
      campaignId: string,
      itemIds: readonly string[],
      key = ++sequence
    ): ClaimAndHoldQuotaCommand => ({
      campaign_id: campaignId,
      subject_id: id("subject"),
      cart_id: id("cart"),
      idempotency_key_hash: hash(key),
      expected_rules_version: 1,
      items: itemIds.map((campaign_item_id) => ({
        campaign_item_id,
        quantity: 2,
      })),
    })

    it("writes hold v2 and settlement consume v4 atomically and replays exactly", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const held = await service.claimAndHoldQuota(command)
      expect(held).toMatchObject({
        status: "held",
        replayed: false,
        attempt: { version: 2 },
      })
      const replay = await service.claimAndHoldQuota(command)
      expect(replay).toMatchObject({ status: "held", replayed: true })
      const attemptId = held.attempt.id
      await service.beginQuotaSettlement({
        attempt_id: attemptId,
        settlement_id: "settlement-1",
      })
      await service.consumeQuotaSettlement({
        attempt_id: attemptId,
        settlement_id: "settlement-1",
      })
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: attemptId,
          settlement_id: "settlement-1",
        })
      ).resolves.toMatchObject({ replayed: true, attempt: { version: 4 } })

      const rows = (await execute(
        `select transition_version::int, kind, from_bucket, to_bucket,
                quantity::text, raw_quantity->>'value' as raw_quantity,
                fence_token
           from flash_sale_capacity_movement
          where attempt_id = ? order by transition_version`,
        [attemptId]
      )) as Array<Record<string, unknown>>
      expect(rows).toEqual([
        expect.objectContaining({
          transition_version: 2,
          kind: "hold",
          from_bucket: "available",
          to_bucket: "held",
          quantity: "2",
          raw_quantity: "2",
          fence_token: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
        expect.objectContaining({
          transition_version: 4,
          kind: "consume",
          from_bucket: "held",
          to_bucket: "consumed",
          quantity: "2",
          raw_quantity: "2",
          fence_token: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ])
    })

    it("uses direct v3 for cancel and expire", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const cancelHeld = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      const expireHeld = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (cancelHeld.status !== "held" || expireHeld.status !== "held") {
        throw new Error("expected held fixtures")
      }
      await service.cancelHeldQuota({ attempt_id: cancelHeld.attempt.id })
      await execute(
        `update flash_sale_purchase_attempt set expires_at = clock_timestamp() - interval '1 second'
          where id = ?`,
        [expireHeld.attempt.id]
      )
      await service.expireQuota({ attempt_id: expireHeld.attempt.id })
      await expect(
        service.cancelHeldQuota({ attempt_id: cancelHeld.attempt.id })
      ).resolves.toMatchObject({ replayed: true, attempt: { version: 3 } })
      await expect(
        service.expireQuota({ attempt_id: expireHeld.attempt.id })
      ).resolves.toMatchObject({ replayed: true, attempt: { version: 3 } })
      const rows = (await execute(
        `select attempt_id, transition_version::int, kind
           from flash_sale_capacity_movement
          where attempt_id in (?, ?) and transition_version = 3
          order by attempt_id`,
        [cancelHeld.attempt.id, expireHeld.attempt.id]
      )) as Array<Record<string, unknown>>
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt_id: cancelHeld.attempt.id,
            transition_version: 3,
            kind: "release",
          }),
          expect.objectContaining({
            attempt_id: expireHeld.attempt.id,
            transition_version: 3,
            kind: "expire",
          }),
        ])
      )
      expect(
        await execute(
          `select attempt_id, count(*)::int as count
             from flash_sale_capacity_movement
            where attempt_id in (?, ?) group by attempt_id order by attempt_id`,
          [cancelHeld.attempt.id, expireHeld.attempt.id]
        )
      ).toEqual(
        expect.arrayContaining([
          { attempt_id: cancelHeld.attempt.id, count: 2 },
          { attempt_id: expireHeld.attempt.id, count: 2 },
        ])
      )
    })

    it("writes settlement release v4 and replays its exact history", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = id("release-v4")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.releaseQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await expect(
        service.releaseQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).resolves.toMatchObject({ replayed: true, attempt: { version: 4 } })
      expect(
        await execute(
          `select transition_version::int, kind
             from flash_sale_capacity_movement where attempt_id = ?
            order by transition_version`,
          [held.attempt.id]
        )
      ).toEqual([
        { transition_version: 2, kind: "hold" },
        { transition_version: 4, kind: "release" },
      ])
    })

    it("rolls a provision checkpoint root and verifies concurrent exact replay", async () => {
      const activated = await service.activateAllocationMovementLedger({})
      const campaigns = [id("campaign-a"), id("campaign-b")]
      const commands = campaigns.map((campaign) => provisionCommand(campaign))
      const results = await Promise.all(
        commands.flatMap((command) => [
          service.provisionAllocation(command),
          service.provisionAllocation(command),
        ])
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(2)
      const checkpoints = (await execute(
        `select checkpoint_kind, count(*)::int as count
           from flash_sale_capacity_movement_checkpoint
          group by checkpoint_kind order by checkpoint_kind`
      )) as Array<{ checkpoint_kind: string; count: number }>
      expect(checkpoints).toEqual([
        {
          checkpoint_kind: CapacityMovementCheckpointKind.PROVISION,
          count: 2,
        },
      ])
      await expect(service.activateAllocationMovementLedger({})).resolves.toEqual({
        ...activated,
        checkpoint_count: 2,
        replayed: true,
      })
    })

    it("refuses to roll a fresh provision root over valid-looking checkpoint identity drift", async () => {
      await service.activateAllocationMovementLedger({})
      const firstCampaign = id("campaign-root-baseline")
      await service.provisionAllocation(provisionCommand(firstCampaign))
      const before = (await execute(
        `select checkpoint_digest from flash_sale_capacity_movement_control`
      )) as Array<{ checkpoint_digest: string }>
      await execute(
        `update flash_sale_capacity_movement_checkpoint
            set campaign_item_id = ?
          where campaign_item_id = ?`,
        [id("valid-but-drifted-item"), `${firstCampaign}-item`]
      )

      const secondCampaign = id("campaign-root-rejected")
      await expect(
        service.provisionAllocation(provisionCommand(secondCampaign))
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      expect(
        await execute(
          `select
             (select count(*)::int from flash_sale_allocation_policy
               where campaign_id = ?) as policies,
             (select checkpoint_digest from flash_sale_capacity_movement_control) as digest`,
          [secondCampaign]
        )
      ).toEqual([{ policies: 0, digest: before[0].checkpoint_digest }])
    })

    it("requires physical Capacity and Checkpoint one-to-one coverage on replay and provision", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      await execute(
        `update flash_sale_capacity set deleted_at = clock_timestamp()
          where allocation_policy_id = ?`,
        [fixture.provisioned.policy.id]
      )
      await expect(
        service.activateAllocationMovementLedger({})
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      await expect(
        service.provisionAllocation(provisionCommand(id("coverage-provision")))
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("does not require a fabricated hold movement for a pre-cutover hold", async () => {
      const fixture = await provisionOpen()
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const activated = await service.activateAllocationMovementLedger({})
      // Deliberately move the legacy timestamps across the cutover. Replay is
      // decided by durable bindings, never by wall-clock ordering.
      await execute(
        `update flash_sale_allocation_hold
            set created_at = clock_timestamp() + interval '1 day'
          where attempt_id = ?`,
        [held.attempt.id]
      )
      await service.cancelHeldQuota({ attempt_id: held.attempt.id })
      await expect(
        service.cancelHeldQuota({ attempt_id: held.attempt.id })
      ).resolves.toMatchObject({ replayed: true })
      const rows = (await execute(
        `select transition_version::int, kind
           from flash_sale_capacity_movement where attempt_id = ?`,
        [held.attempt.id]
      )) as Array<Record<string, unknown>>
      expect(rows).toEqual([{ transition_version: 3, kind: "release" }])
      const bindings = (await execute(
        `select hold_movement_activation_id, terminal_movement_activation_id
           from flash_sale_purchase_attempt where id = ?`,
        [held.attempt.id]
      )) as Array<Record<string, unknown>>
      expect(bindings).toEqual([
        {
          hold_movement_activation_id: null,
          terminal_movement_activation_id: activated.activation_id,
        },
      ])
    })

    it("fails a fresh hold on an exact pre-existing movement and rolls balances back", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const claimed = await service.claimAttempt(command)
      const capacities = (await execute(
        `select id, campaign_item_id from flash_sale_capacity
          where allocation_policy_id = ?`,
        [fixture.provisioned.policy.id]
      )) as Array<{ id: string; campaign_item_id: string }>
      const expected = {
        schema_version: 1 as const,
        capacity_id: capacities[0].id,
        attempt_id: claimed.attempt.id,
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        campaign_item_id: capacities[0].campaign_item_id,
        transition_version: 2,
        kind: CapacityMovementKind.HOLD,
        from_bucket: CapacityMovementBucket.AVAILABLE,
        to_bucket: CapacityMovementBucket.HELD,
        quantity: "2",
      }
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         values (?, ?, ?, ?, ?, ?, 2, 'hold', 'available', 'held', 2, ?,
                 jsonb_build_object('value', '2', 'precision', 20))`,
        [
          id("fsmov-preexisting"),
          expected.capacity_id,
          expected.attempt_id,
          expected.campaign_id,
          expected.subject_id,
          expected.campaign_item_id,
          createCapacityMovementFingerprint(expected),
        ]
      )
      await expect(service.holdQuota({
        attempt_id: claimed.attempt.id,
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        cart_id: command.cart_id,
        expected_rules_version: command.expected_rules_version,
        items: command.items,
      }))
        .rejects.toMatchObject({
          code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
        })
      const snapshot = (await execute(
        `select a.state, a.version::int,
                c.held_quantity::int as held,
                (select count(*)::int from flash_sale_allocation_hold h
                  where h.attempt_id = a.id) as holds
           from flash_sale_purchase_attempt a
           join flash_sale_capacity c on c.id = ?
          where a.id = ?`,
        [expected.capacity_id, expected.attempt_id]
      )) as Array<Record<string, unknown>>
      expect(snapshot).toEqual([
        {
          state: PurchaseAttemptState.PENDING,
          version: 1,
          held: 0,
          holds: 0,
        },
      ])
    })

    it("fails a two-item fresh settlement on a second-item movement conflict and rolls balances back", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-two-item-settlement-conflict")
      const fixture = await provisionOpen(campaignId, [
        `${campaignId}-a`,
        `${campaignId}-b`,
      ])
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = id("settlement")
      const committing = await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      const holdRows = (await execute(
        `select capacity_id, campaign_item_id, quantity::text
           from flash_sale_allocation_hold where attempt_id = ?`,
        [held.attempt.id]
      )) as Array<{
        capacity_id: string
        campaign_item_id: string
        quantity: string
      }>
      const expected = {
        schema_version: 1 as const,
        capacity_id: holdRows[1].capacity_id,
        attempt_id: held.attempt.id,
        campaign_id: held.attempt.campaign_id,
        subject_id: held.attempt.subject_id,
        campaign_item_id: holdRows[1].campaign_item_id,
        transition_version: 4,
        kind: CapacityMovementKind.CONSUME,
        from_bucket: CapacityMovementBucket.HELD,
        to_bucket: CapacityMovementBucket.CONSUMED,
        quantity: holdRows[1].quantity,
      }
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         values (?, ?, ?, ?, ?, ?, 4, 'consume', 'held', 'consumed',
                 ?::numeric, ?, jsonb_build_object('value', ?, 'precision', 20))`,
        [
          id("fsmov-preexisting-consume"),
          expected.capacity_id,
          expected.attempt_id,
          expected.campaign_id,
          expected.subject_id,
          expected.campaign_item_id,
          expected.quantity,
          createCapacityMovementFingerprint(expected),
          expected.quantity,
        ]
      )
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      const snapshot = (await execute(
        `select a.state, a.version::int,
                count(*) filter (where h.state = 'held')::int as held_holds,
                sum(c.held_quantity)::int as held,
                sum(c.consumed_quantity)::int as consumed
           from flash_sale_purchase_attempt a
           join flash_sale_allocation_hold h on h.attempt_id = a.id
           join flash_sale_capacity c on c.id = h.capacity_id
          where a.id = ? group by a.state, a.version`,
        [held.attempt.id]
      )) as Array<Record<string, unknown>>
      expect(committing.attempt.version).toBe(3)
      expect(snapshot).toEqual([
        {
          state: PurchaseAttemptState.QUOTA_COMMITTING,
          version: 3,
          held_holds: 2,
          held: 4,
          consumed: 0,
        },
      ])
    })

    it.each([
      [
        "missing movement",
        `delete from flash_sale_capacity_movement where attempt_id = ? and kind = 'hold'`,
      ],
      [
        "drifted raw quantity",
        `update flash_sale_capacity_movement
            set raw_quantity = jsonb_build_object('value', '9', 'precision', 20)
          where attempt_id = ? and kind = 'hold'`,
      ],
    ])("fails replay on %s", async (_label, mutation) => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") throw new Error("expected held")
      await execute(mutation, [held.attempt.id])
      await expect(service.claimAndHoldQuota(command)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails replay when the persisted activation binding drifts from Control", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_purchase_attempt
            set hold_movement_activation_id = 'different-valid-activation'
          where id = ?`,
        [held.attempt.id]
      )
      await expect(service.claimAndHoldQuota(command)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it.each([
      ["null", null],
      ["wrong", "different-valid-activation"],
    ])("fails replay when the terminal activation binding is %s", async (_label, binding) => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = id("terminal-binding")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.consumeQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await execute(
        `update flash_sale_purchase_attempt
            set terminal_movement_activation_id = ? where id = ?`,
        [binding, held.attempt.id]
      )
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails terminal replay when binding and the complete terminal Movement set are both removed", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = id("terminal-binding-and-history")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await service.consumeQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      await execute(
        `update flash_sale_purchase_attempt
            set terminal_movement_activation_id = null where id = ?`,
        [held.attempt.id]
      )
      await execute(
        `delete from flash_sale_capacity_movement
          where attempt_id = ? and transition_version = 4`,
        [held.attempt.id]
      )
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails a held replay on a null binding or an extra historical version", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const firstCommand = holdCommand(fixture.campaignId, fixture.itemIds)
      const first = await service.claimAndHoldQuota(firstCommand)
      if (first.status !== "held") throw new Error("expected held")
      await execute(
        `update flash_sale_purchase_attempt
            set hold_movement_activation_id = null where id = ?`,
        [first.attempt.id]
      )
      await expect(service.claimAndHoldQuota(firstCommand)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })

      const secondCommand = holdCommand(fixture.campaignId, fixture.itemIds)
      const second = await service.claimAndHoldQuota(secondCommand)
      if (second.status !== "held") throw new Error("expected held")
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         select ?, capacity_id, attempt_id, campaign_id, subject_id,
                campaign_item_id, 99, kind, from_bucket, to_bucket,
                quantity, fence_token, raw_quantity
           from flash_sale_capacity_movement
          where attempt_id = ? and transition_version = 2`,
        [id("fsmov-extra-version"), second.attempt.id]
      )
      await expect(service.claimAndHoldQuota(secondCommand)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("fails closed on physical Movement history before and after QUOTA_REJECTED", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const rejectedCommand = {
        ...holdCommand(fixture.campaignId, fixture.itemIds),
        items: fixture.itemIds.map((campaign_item_id) => ({
          campaign_item_id,
          quantity: 101,
        })),
      }
      const rejected = await service.claimAndHoldQuota(rejectedCommand)
      if (rejected.status !== "rejected") throw new Error("expected rejected")
      const capacity = (await execute(
        `select id, campaign_item_id from flash_sale_capacity
          where allocation_policy_id = ?`,
        [fixture.provisioned.policy.id]
      )) as Array<{ id: string; campaign_item_id: string }>
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         values (?, ?, ?, ?, ?, ?, 99, 'hold', 'available', 'held', 1, ?,
                 jsonb_build_object('value', '1', 'precision', 20))`,
        [
          id("rejected-history"),
          capacity[0].id,
          rejected.attempt.id,
          rejected.attempt.campaign_id,
          rejected.attempt.subject_id,
          capacity[0].campaign_item_id,
          "a".repeat(64),
        ]
      )
      await expect(
        service.claimAndHoldQuota(rejectedCommand)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })

      const freshCommand = {
        ...holdCommand(fixture.campaignId, fixture.itemIds),
        items: rejectedCommand.items,
      }
      const pending = await service.claimAttempt(freshCommand)
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         values (?, ?, ?, ?, ?, ?, 88, 'hold', 'available', 'held', 1, ?,
                 jsonb_build_object('value', '1', 'precision', 20))`,
        [
          id("pending-reject-history"),
          capacity[0].id,
          pending.attempt.id,
          pending.attempt.campaign_id,
          pending.attempt.subject_id,
          capacity[0].campaign_item_id,
          "b".repeat(64),
        ]
      )
      await expect(
        service.holdQuota({
          attempt_id: pending.attempt.id,
          campaign_id: freshCommand.campaign_id,
          subject_id: freshCommand.subject_id,
          cart_id: freshCommand.cart_id,
          expected_rules_version: freshCommand.expected_rules_version,
          items: freshCommand.items,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      expect(
        await execute(
          `select state from flash_sale_purchase_attempt where id = ?`,
          [pending.attempt.id]
        )
      ).toEqual([{ state: PurchaseAttemptState.PENDING }])
    })

    it("preserves large integer quantity in numeric, raw JSON, and fingerprint", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-large-quantity")
      const quantity = 2_147_483_647
      const base = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2020-01-01T00:00:00.000Z",
        ends_at: "2035-01-01T00:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: quantity,
        items: [
          {
            campaign_item_id: `${campaignId}-item`,
            quota: Number.MAX_SAFE_INTEGER,
          },
        ],
      }
      const provisioned = await service.provisionAllocation({
        ...base,
        configuration_hash: createAllocationConfigurationHash(base),
      })
      await service.openAllocation({
        policy_id: provisioned.policy.id,
        expected_rules_version: 1,
        expected_version: 1,
      })
      const command = {
        ...holdCommand(campaignId, [base.items[0].campaign_item_id]),
        items: [
          {
            campaign_item_id: base.items[0].campaign_item_id,
            quantity,
          },
        ],
      }
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") throw new Error("expected held")
      const row = (await execute(
        `select capacity_id, attempt_id, campaign_id, subject_id,
                campaign_item_id, transition_version::int, kind,
                from_bucket, to_bucket, quantity::text,
                raw_quantity->>'value' as raw_value,
                raw_quantity->>'precision' as raw_precision, fence_token
           from flash_sale_capacity_movement where attempt_id = ?`,
        [held.attempt.id]
      )) as Array<Record<string, string | number>>
      expect(row[0]).toMatchObject({
        quantity: quantity.toString(10),
        raw_value: quantity.toString(10),
        raw_precision: "20",
      })
      expect(row[0].fence_token).toBe(
        createCapacityMovementFingerprint({
          schema_version: 1,
          capacity_id: String(row[0].capacity_id),
          attempt_id: String(row[0].attempt_id),
          campaign_id: String(row[0].campaign_id),
          subject_id: String(row[0].subject_id),
          campaign_item_id: String(row[0].campaign_item_id),
          transition_version: Number(row[0].transition_version),
          kind: CapacityMovementKind.HOLD,
          from_bucket: CapacityMovementBucket.AVAILABLE,
          to_bucket: CapacityMovementBucket.HELD,
          quantity: quantity.toString(10),
        })
      )
      await expect(service.claimAndHoldQuota(command)).resolves.toMatchObject({
        replayed: true,
      })
    })

    it.each([
      [
        "soft-deleted movement",
        `update flash_sale_capacity_movement set deleted_at = clock_timestamp()
          where attempt_id = ? and kind = 'hold'`,
      ],
      [
        "extra physical movement",
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         select ? || '-extra', capacity_id, attempt_id, campaign_id, subject_id,
                ? || '-extra-item', transition_version, kind, from_bucket,
                to_bucket, quantity, fence_token, raw_quantity
           from flash_sale_capacity_movement
          where attempt_id = ? and kind = 'hold'`,
      ],
    ])("fails exact-set replay on %s", async (label, mutation) => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const held = await service.claimAndHoldQuota(command)
      if (held.status !== "held") throw new Error("expected held")
      if (label === "extra physical movement") {
        await execute(mutation, [id("fsmov"), id("campaign-item"), held.attempt.id])
      } else {
        await execute(mutation, [held.attempt.id])
      }
      await expect(service.claimAndHoldQuota(command)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("writes and replays exact two-item hold, consume, and release sets", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-two-item-success")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      await provisionOpen(campaignId, itemIds)
      const consumeCommand = holdCommand(campaignId, itemIds)
      const releaseCommand = holdCommand(campaignId, itemIds)
      const consumed = await service.claimAndHoldQuota(consumeCommand)
      const released = await service.claimAndHoldQuota(releaseCommand)
      if (consumed.status !== "held" || released.status !== "held") {
        throw new Error("expected two held attempts")
      }
      await service.beginQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: "two-item-consume",
      })
      await service.consumeQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: "two-item-consume",
      })
      await service.cancelHeldQuota({ attempt_id: released.attempt.id })
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: consumed.attempt.id,
          settlement_id: "two-item-consume",
        })
      ).resolves.toMatchObject({ replayed: true })
      await expect(
        service.cancelHeldQuota({ attempt_id: released.attempt.id })
      ).resolves.toMatchObject({ replayed: true })
      expect(
        await execute(
          `select kind, count(*)::int as count
             from flash_sale_capacity_movement
            where attempt_id in (?, ?) group by kind order by kind`,
          [consumed.attempt.id, released.attempt.id]
        )
      ).toEqual([
        { kind: "consume", count: 2 },
        { kind: "hold", count: 4 },
        { kind: "release", count: 2 },
      ])
    })

    it("rolls back a two-item fresh hold when only the second movement conflicts", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-two-item-hold-conflict")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      const fixture = await provisionOpen(campaignId, itemIds)
      const command = holdCommand(campaignId, itemIds)
      const claimed = await service.claimAttempt(command)
      const capacities = (await execute(
        `select id, campaign_item_id from flash_sale_capacity
          where allocation_policy_id = ? order by campaign_item_id`,
        [fixture.provisioned.policy.id]
      )) as Array<{ id: string; campaign_item_id: string }>
      const second = capacities[1]
      const expected = {
        schema_version: 1 as const,
        capacity_id: second.id,
        attempt_id: claimed.attempt.id,
        campaign_id: command.campaign_id,
        subject_id: command.subject_id,
        campaign_item_id: second.campaign_item_id,
        transition_version: 2,
        kind: CapacityMovementKind.HOLD,
        from_bucket: CapacityMovementBucket.AVAILABLE,
        to_bucket: CapacityMovementBucket.HELD,
        quantity: "2",
      }
      await execute(
        `insert into flash_sale_capacity_movement
          (id, capacity_id, attempt_id, campaign_id, subject_id,
           campaign_item_id, transition_version, kind, from_bucket, to_bucket,
           quantity, fence_token, raw_quantity)
         values (?, ?, ?, ?, ?, ?, 2, 'hold', 'available', 'held', 2, ?,
                 jsonb_build_object('value', '2', 'precision', 20))`,
        [
          id("fsmov-second-conflict"),
          expected.capacity_id,
          expected.attempt_id,
          expected.campaign_id,
          expected.subject_id,
          expected.campaign_item_id,
          createCapacityMovementFingerprint(expected),
        ]
      )
      await expect(
        service.holdQuota({
          attempt_id: claimed.attempt.id,
          campaign_id: command.campaign_id,
          subject_id: command.subject_id,
          cart_id: command.cart_id,
          expected_rules_version: command.expected_rules_version,
          items: command.items,
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      expect(
        await execute(
          `select
             (select state from flash_sale_purchase_attempt where id = ?) as state,
             (select count(*)::int from flash_sale_allocation_hold where attempt_id = ?) as holds,
             (select sum(held_quantity)::int from flash_sale_capacity
               where allocation_policy_id = ?) as held`,
          [claimed.attempt.id, claimed.attempt.id, fixture.provisioned.policy.id]
        )
      ).toEqual([{ state: "pending", holds: 0, held: 0 }])
    })

    it("fails two-item hold, consume, and release replay on second-item set drift", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-two-item-replay")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      await provisionOpen(campaignId, itemIds)
      const holdReplayCommand = holdCommand(campaignId, itemIds)
      const consumeCommand = holdCommand(campaignId, itemIds)
      const releaseCommand = holdCommand(campaignId, itemIds)
      const held = await service.claimAndHoldQuota(holdReplayCommand)
      const consumed = await service.claimAndHoldQuota(consumeCommand)
      const released = await service.claimAndHoldQuota(releaseCommand)
      if (
        held.status !== "held" ||
        consumed.status !== "held" ||
        released.status !== "held"
      ) {
        throw new Error("expected held fixtures")
      }
      await service.beginQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: "two-item-replay-consume",
      })
      await service.consumeQuotaSettlement({
        attempt_id: consumed.attempt.id,
        settlement_id: "two-item-replay-consume",
      })
      await service.cancelHeldQuota({ attempt_id: released.attempt.id })
      await execute(
        `delete from flash_sale_capacity_movement
          where attempt_id = ? and transition_version = 2 and campaign_item_id = ?`,
        [held.attempt.id, itemIds[1]]
      )
      await execute(
        `update flash_sale_capacity_movement
            set raw_quantity = jsonb_build_object('value', '99', 'precision', 20)
          where attempt_id = ? and transition_version = 4 and campaign_item_id = ?`,
        [consumed.attempt.id, itemIds[1]]
      )
      await execute(
        `update flash_sale_capacity_movement set deleted_at = clock_timestamp()
          where attempt_id = ? and transition_version = 3 and campaign_item_id = ?`,
        [released.attempt.id, itemIds[1]]
      )
      await expect(
        service.claimAndHoldQuota(holdReplayCommand)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: consumed.attempt.id,
          settlement_id: "two-item-replay-consume",
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
      await expect(
        service.cancelHeldQuota({ attempt_id: released.attempt.id })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.MOVEMENT_LEDGER_INVARIANT_VIOLATION,
      })
    })

    it("serializes activation against a concurrent writer without losing the cutover", async () => {
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const [activation, held] = await Promise.all([
        service.activateAllocationMovementLedger({}),
        service.claimAndHoldQuota(command),
      ])
      if (held.status !== "held") throw new Error("expected held")
      await expect(service.claimAndHoldQuota(command)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(service.activateAllocationMovementLedger({})).resolves.toEqual({
        ...activation,
        replayed: true,
      })
      const rows = (await execute(
        `select cp.opening_held_quantity::int as opening_held,
                coalesce(sum(m.quantity) filter (where m.kind = 'hold'), 0)::int as hold_delta,
                c.held_quantity::int as materialized_held
           from flash_sale_capacity c
           join flash_sale_capacity_movement_checkpoint cp on cp.capacity_id = c.id
           left join flash_sale_capacity_movement m on m.capacity_id = c.id
          where c.allocation_policy_id = ?
          group by cp.opening_held_quantity, c.held_quantity`,
        [fixture.provisioned.policy.id]
      )) as Array<Record<string, unknown>>
      expect(rows).toEqual([
        expect.objectContaining({ materialized_held: 2 }),
      ])
      expect(
        Number(rows[0].opening_held) + Number(rows[0].hold_delta)
      ).toBe(2)
    })

    it("rolls balances, movement, and outbox back at the post-movement failpoint", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresAllocationAttemptStore(repository, {
        hit: (name) => {
          if (name === "after_domain_transition_before_outbox") {
            throw new Error("injected after movement")
          }
        },
      })
      await expect(
        store.claimAndHoldQuota({
          ...command,
          request_hash: "f".repeat(64),
          items: command.items,
        })
      ).rejects.toThrow("injected after movement")
      const rows = (await execute(
        `select
          (select count(*)::int from flash_sale_purchase_attempt
            where campaign_id = ?) as attempts,
          (select count(*)::int from flash_sale_capacity_movement
            where campaign_id = ?) as movements,
          (select count(*)::int from flash_sale_allocation_outbox_event e
            join flash_sale_purchase_attempt a on a.id = e.aggregate_id
           where a.campaign_id = ?) as events,
          (select sum(held_quantity)::int from flash_sale_capacity c
            join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
           where p.campaign_id = ?) as held`,
        [fixture.campaignId, fixture.campaignId, fixture.campaignId, fixture.campaignId]
      )) as Array<Record<string, unknown>>
      expect(rows).toEqual([
        { attempts: 0, movements: 0, events: 0, held: 0 },
      ])
    })

    it("rolls an active hold back after Outbox append but before commit", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const command = holdCommand(fixture.campaignId, fixture.itemIds)
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresAllocationAttemptStore(repository, {
        hit: (name) => {
          if (name === "after_outbox_append_before_commit") {
            throw new Error("injected after hold Outbox")
          }
        },
      })
      await expect(
        store.claimAndHoldQuota({
          ...command,
          request_hash: "d".repeat(64),
          items: command.items,
        })
      ).rejects.toThrow("injected after hold Outbox")
      expect(
        await execute(
          `select
             (select count(*)::int from flash_sale_purchase_attempt
               where campaign_id = ?) as attempts,
             (select count(*)::int from flash_sale_capacity_movement
               where campaign_id = ?) as movements,
             (select count(*)::int from flash_sale_allocation_outbox_event e
               join flash_sale_purchase_attempt a on a.id = e.aggregate_id
              where a.campaign_id = ?) as events,
             (select sum(held_quantity)::int from flash_sale_capacity
               where allocation_policy_id = ?) as held`,
          [
            fixture.campaignId,
            fixture.campaignId,
            fixture.campaignId,
            fixture.provisioned.policy.id,
          ]
        )
      ).toEqual([{ attempts: 0, movements: 0, events: 0, held: 0 }])
    })

    it("rolls back after the first of two Movement inserts", async () => {
      await service.activateAllocationMovementLedger({})
      const campaignId = id("campaign-first-movement-fault")
      const itemIds = [`${campaignId}-a`, `${campaignId}-b`]
      const fixture = await provisionOpen(campaignId, itemIds)
      const command = holdCommand(campaignId, itemIds)
      let observedFirstInsert = false
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresAllocationAttemptStore(repository, {
        hit: (name) => {
          if (name === "after_first_capacity_movement_append") {
            observedFirstInsert = true
            throw new Error("injected after first Movement insert")
          }
        },
      })
      await expect(
        store.claimAndHoldQuota({
          ...command,
          request_hash: "e".repeat(64),
          items: command.items,
        })
      ).rejects.toThrow("injected after first Movement insert")
      expect(observedFirstInsert).toBe(true)
      expect(
        await execute(
          `select
             (select count(*)::int from flash_sale_purchase_attempt
               where campaign_id = ?) as attempts,
             (select count(*)::int from flash_sale_capacity_movement
               where campaign_id = ?) as movements,
             (select count(*)::int from flash_sale_allocation_hold h
               join flash_sale_capacity c on c.id = h.capacity_id
              where c.allocation_policy_id = ?) as holds,
             (select sum(held_quantity)::int from flash_sale_capacity
               where allocation_policy_id = ?) as held`,
          [campaignId, campaignId, fixture.provisioned.policy.id, fixture.provisioned.policy.id]
        )
      ).toEqual([{ attempts: 0, movements: 0, holds: 0, held: 0 }])
    })

    it("rolls settlement back after Outbox append and succeeds on retry", async () => {
      await service.activateAllocationMovementLedger({})
      const fixture = await provisionOpen()
      const held = await service.claimAndHoldQuota(
        holdCommand(fixture.campaignId, fixture.itemIds)
      )
      if (held.status !== "held") throw new Error("expected held")
      const settlementId = id("after-outbox-settlement")
      await service.beginQuotaSettlement({
        attempt_id: held.attempt.id,
        settlement_id: settlementId,
      })
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.forkManager(),
      })
      const store = new PostgresAllocationAttemptStore(repository, {
        hit: (name) => {
          if (name === "after_outbox_append_before_commit") {
            throw new Error("injected after settlement Outbox")
          }
        },
      })
      await expect(
        store.consumeQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).rejects.toThrow("injected after settlement Outbox")
      expect(
        await execute(
          `select a.state, a.version::int,
                  (select count(*)::int from flash_sale_capacity_movement m
                    where m.attempt_id = a.id and m.transition_version = 4) as terminal_movements,
                  (select count(*)::int from flash_sale_allocation_outbox_event e
                    where e.aggregate_id = a.id and e.aggregate_version = 4) as terminal_events
             from flash_sale_purchase_attempt a where a.id = ?`,
          [held.attempt.id]
        )
      ).toEqual([{
        state: PurchaseAttemptState.QUOTA_COMMITTING,
        version: 3,
        terminal_movements: 0,
        terminal_events: 0,
      }])
      await expect(
        service.consumeQuotaSettlement({
          attempt_id: held.attempt.id,
          settlement_id: settlementId,
        })
      ).resolves.toMatchObject({ replayed: false, attempt: { version: 4 } })
    })
  },
})
