import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"

import {
  AllocationCommandErrorCode,
  ClaimAttemptCommand,
  createAllocationConfigurationHash,
  ProvisionAllocationCommand,
} from "../application"
import {
  AllocationFenceDisposition,
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

    const makeProvision = (
      campaignId: string,
      overrides: Partial<
        Omit<ProvisionAllocationCommand, "configuration_hash">
      > = {}
    ): ProvisionAllocationCommand => {
      const base = {
        campaign_id: campaignId,
        rules_version: 1,
        starts_at: "2030-01-01T00:00:00.000Z",
        ends_at: "2030-01-01T01:00:00.000Z",
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
        items: [
          { campaign_item_id: `${campaignId}-item-b`, quota: 20 },
          { campaign_item_id: `${campaignId}-item-a`, quota: 10 },
        ],
        ...overrides,
      }
      return {
        ...base,
        configuration_hash: createAllocationConfigurationHash(base),
      }
    }

    const expectCode = async (
      promise: Promise<unknown>,
      code: AllocationCommandErrorCode
    ) => await expect(promise).rejects.toMatchObject({ code })

    describe("allocation control plane", () => {
      it("provisions one canonical policy under same-snapshot concurrency", async () => {
        const campaignId = nextId("campaign-provision-same")
        const command = makeProvision(campaignId)

        const results = await Promise.all(
          Array.from({ length: 20 }, () => service.provisionAllocation(command))
        )

        expect(results.filter((result) => !result.replayed)).toHaveLength(1)
        expect(new Set(results.map((result) => result.policy.id)).size).toBe(1)
        expect(
          results[0].capacities.map((capacity) => capacity.campaign_item_id)
        ).toEqual([`${campaignId}-item-a`, `${campaignId}-item-b`])
        const counts = (await execute(
          `select
             (select count(*)::int from flash_sale_allocation_policy where campaign_id = ?) as policies,
             (select count(*)::int from flash_sale_capacity c join flash_sale_allocation_policy p
               on p.id = c.allocation_policy_id where p.campaign_id = ?) as capacities`,
          [campaignId, campaignId]
        )) as Array<{ policies: number; capacities: number }>
        expect(counts[0]).toEqual({ policies: 1, capacities: 2 })
      })

      it("returns a deterministic conflict for a different same-version snapshot", async () => {
        const campaignId = nextId("campaign-provision-conflict")
        const first = makeProvision(campaignId)
        const changed = makeProvision(campaignId, { per_subject_limit: 3 })
        const outcomes = await Promise.allSettled([
          service.provisionAllocation(first),
          service.provisionAllocation(changed),
        ])
        expect(
          outcomes.filter((outcome) => outcome.status === "fulfilled")
        ).toHaveLength(1)
        const rejection = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected"
        )
        expect(rejection?.reason).toMatchObject({
          code: AllocationCommandErrorCode.IDEMPOTENCY_CONFLICT,
        })
      })

      it("serializes concurrent rule revisions and leaves only the highest live", async () => {
        const campaignId = nextId("campaign-rules-race")
        const outcomes = await Promise.allSettled([
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 1 })
          ),
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 2 })
          ),
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 3 })
          ),
        ])

        expect(outcomes[2].status).toBe("fulfilled")
        const counts = (await execute(
          `select
             (select count(*)::int from flash_sale_allocation_policy where campaign_id = ?) as policies,
             (select count(*)::int from flash_sale_allocation_policy where campaign_id = ? and state = 'prepared') as live,
             (select max(rules_version)::int from flash_sale_allocation_policy where campaign_id = ?) as max_rules,
             (select count(*)::int from flash_sale_capacity c
               join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
               where p.campaign_id = ?) as capacities`,
          [campaignId, campaignId, campaignId, campaignId]
        )) as Array<{
          policies: number
          live: number
          max_rules: number
          capacities: number
        }>
        expect(counts[0].live).toBe(1)
        expect(counts[0].max_rules).toBe(3)
        expect(counts[0].capacities).toBe(counts[0].policies * 2)
      })

      it("rejects PostgreSQL boundary overflow before writing", async () => {
        const invalidCommands = [
          makeProvision(nextId("campaign-rules-overflow"), {
            rules_version: 2_147_483_648,
          }),
          makeProvision(nextId("campaign-limit-overflow"), {
            per_subject_limit: 2_147_483_648,
          }),
          makeProvision(nextId("campaign-year-zero"), {
            starts_at: "0000-01-01T00:00:00.000Z",
            ends_at: "0001-01-01T00:00:00.000Z",
          }),
        ]

        for (const invalid of invalidCommands) {
          await expectCode(
            service.provisionAllocation(invalid),
            AllocationCommandErrorCode.INVALID_COMMAND
          )
        }
        const rows = (await execute(
          `select count(*)::int as count from flash_sale_allocation_policy
            where campaign_id in (?, ?, ?)`,
          invalidCommands.map((command) => command.campaign_id)
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(0)
      })

      it("persists maximum supported integers and exact safe numeric quota", async () => {
        const campaignId = nextId("campaign-column-max")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId, {
            rules_version: 2_147_483_647,
            per_subject_limit: 2_147_483_647,
            starts_at: "9999-01-01T00:00:00.000Z",
            ends_at: "9999-01-01T01:00:00.000Z",
            items: [
              {
                campaign_item_id: `${campaignId}-item-max`,
                quota: Number.MAX_SAFE_INTEGER,
              },
            ],
          })
        )

        expect(provisioned.policy.rules_version).toBe(2_147_483_647)
        expect(provisioned.policy.per_subject_limit).toBe(2_147_483_647)
        const rows = (await execute(
          `select granted_quantity::text as granted,
                  raw_granted_quantity->>'value' as raw_granted
             from flash_sale_capacity where allocation_policy_id = ?`,
          [provisioned.policy.id]
        )) as Array<{ granted: string; raw_granted: string }>
        expect(rows[0]).toEqual({
          granted: String(Number.MAX_SAFE_INTEGER),
          raw_granted: String(Number.MAX_SAFE_INTEGER),
        })

        await expectCode(
          service.openAllocation({
            policy_id: provisioned.policy.id,
            expected_rules_version: 2_147_483_648,
            expected_version: 1,
          }),
          AllocationCommandErrorCode.INVALID_COMMAND
        )
        await expectCode(
          service.openAllocation({
            policy_id: provisioned.policy.id,
            expected_rules_version: 2_147_483_647,
            expected_version: 2_147_483_648,
          }),
          AllocationCommandErrorCode.INVALID_COMMAND
        )
        const unchanged = (await execute(
          `select p.state as policy_state, p.version as policy_version,
                  min(c.state) as capacity_state,
                  min(c.version)::int as capacity_version
             from flash_sale_allocation_policy p
             join flash_sale_capacity c on c.allocation_policy_id = p.id
            where p.id = ? group by p.state, p.version`,
          [provisioned.policy.id]
        )) as Array<{
          policy_state: AllocationPolicyState
          policy_version: number
          capacity_state: CapacityState
          capacity_version: number
        }>
        expect(unchanged[0]).toEqual({
          policy_state: AllocationPolicyState.PREPARED,
          policy_version: 1,
          capacity_state: CapacityState.PREPARED,
          capacity_version: 1,
        })
      })

      it("rolls back the policy when a later capacity insert fails", async () => {
        const campaignId = nextId("campaign-provision-rollback")
        await execute(`create or replace function flash_sale_test_fail_capacity()
          returns trigger language plpgsql as $$ begin
            if new.campaign_item_id = '${campaignId}-item-b' then
              raise exception 'injected capacity failure';
            end if;
            return new;
          end $$`)
        await execute(`create trigger flash_sale_test_fail_capacity_trigger
          before insert on flash_sale_capacity for each row
          execute function flash_sale_test_fail_capacity()`)
        try {
          await expect(
            service.provisionAllocation(makeProvision(campaignId))
          ).rejects.toThrow("injected capacity failure")
        } finally {
          await execute(
            "drop trigger if exists flash_sale_test_fail_capacity_trigger on flash_sale_capacity"
          )
          await execute(
            "drop function if exists flash_sale_test_fail_capacity()"
          )
        }
        const rows = (await execute(
          `select count(*)::int as count from flash_sale_allocation_policy
            where campaign_id = ?`,
          [campaignId]
        )) as Array<{ count: number }>
        expect(rows[0].count).toBe(0)
      })

      it("opens early, replays concurrent transitions, then closes atomically", async () => {
        const campaignId = nextId("campaign-transition")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        const openCommand = {
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 1,
        }
        const opened = await Promise.all(
          Array.from({ length: 12 }, () => service.openAllocation(openCommand))
        )
        expect(opened.filter((result) => !result.replayed)).toHaveLength(1)
        expect(
          opened.every(
            (result) => result.policy.state === AllocationPolicyState.OPEN
          )
        ).toBe(true)
        expect(
          opened.every((result) =>
            result.capacities.every(
              (capacity) => capacity.state === CapacityState.OPEN
            )
          )
        ).toBe(true)

        const closeCommand = {
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 2,
        }
        const closed = await Promise.all(
          Array.from({ length: 12 }, () =>
            service.closeAllocation(closeCommand)
          )
        )
        expect(closed.filter((result) => !result.replayed)).toHaveLength(1)
        expect(
          closed.every(
            (result) => result.policy.state === AllocationPolicyState.CLOSED
          )
        ).toBe(true)
        await expectCode(
          service.openAllocation({ ...openCommand, expected_version: 3 }),
          AllocationCommandErrorCode.ALLOCATION_POLICY_STATE_CONFLICT
        )
      })

      it("rolls back every capacity when a transition fails midway", async () => {
        const campaignId = nextId("campaign-open-rollback")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        await execute(`create or replace function flash_sale_test_fail_open()
          returns trigger language plpgsql as $$ begin
            if new.campaign_item_id = '${campaignId}-item-b' and new.state = 'open' then
              raise exception 'injected open failure';
            end if;
            return new;
          end $$`)
        await execute(`create trigger flash_sale_test_fail_open_trigger
          before update on flash_sale_capacity for each row
          execute function flash_sale_test_fail_open()`)
        try {
          await expect(
            service.openAllocation({
              policy_id: provisioned.policy.id,
              expected_rules_version: 1,
              expected_version: 1,
            })
          ).rejects.toThrow("injected open failure")
        } finally {
          await execute(
            "drop trigger if exists flash_sale_test_fail_open_trigger on flash_sale_capacity"
          )
          await execute("drop function if exists flash_sale_test_fail_open()")
        }
        const rows = (await execute(
          `select state, count(*)::int as count from flash_sale_capacity
            where allocation_policy_id = ? group by state`,
          [provisioned.policy.id]
        )) as Array<{ state: CapacityState; count: number }>
        expect(rows).toEqual([{ state: CapacityState.PREPARED, count: 2 }])
        const policies = (await execute(
          "select state, version from flash_sale_allocation_policy where id = ?",
          [provisioned.policy.id]
        )) as Array<{ state: AllocationPolicyState; version: number }>
        expect(policies[0]).toEqual({
          state: AllocationPolicyState.PREPARED,
          version: 1,
        })
      })

      it("lets only one opposite transition win from PREPARED", async () => {
        const campaignId = nextId("campaign-opposite-transition")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        const transition = {
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 1,
        }
        const outcomes = await Promise.allSettled([
          service.openAllocation(transition),
          service.closeAllocation(transition),
        ])
        expect(
          outcomes.filter((outcome) => outcome.status === "fulfilled")
        ).toHaveLength(1)
        const rejection = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected"
        )
        expect(rejection?.reason).toMatchObject({
          code: AllocationCommandErrorCode.ALLOCATION_POLICY_STATE_CONFLICT,
        })
        const rows = (await execute(
          `select p.state as policy_state,
                  count(distinct c.state)::int as capacity_state_count,
                  min(c.state) as capacity_state
             from flash_sale_allocation_policy p
             join flash_sale_capacity c on c.allocation_policy_id = p.id
            where p.id = ? group by p.state`,
          [provisioned.policy.id]
        )) as Array<{
          policy_state: AllocationPolicyState
          capacity_state_count: number
          capacity_state: CapacityState
        }>
        expect(rows[0].capacity_state_count).toBe(1)
        expect(rows[0].capacity_state).toBe(rows[0].policy_state)
      })

      it("allows a held attempt to settle after close while rejecting new claims", async () => {
        const campaignId = nextId("campaign-close-settle")
        const now = Date.now()
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId, {
            starts_at: new Date(now - 60_000).toISOString(),
            ends_at: new Date(now + 600_000).toISOString(),
          })
        )
        await service.openAllocation({
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 1,
        })
        const claim = (suffix: string): ClaimAttemptCommand => ({
          campaign_id: campaignId,
          subject_id: `subject-${suffix}`,
          cart_id: `cart-${suffix}`,
          idempotency_key_hash: suffix.padEnd(64, "a").slice(0, 64),
          expected_rules_version: 1,
          items: [{ campaign_item_id: `${campaignId}-item-a`, quantity: 1 }],
        })
        const held = await service.claimAndHoldQuota(claim("b"))
        expect(held.status).toBe("held")
        await service.closeAllocation({
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 2,
        })
        await expectCode(
          service.claimAndHoldQuota(claim("c")),
          AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE
        )
        const settlement = {
          attempt_id: held.attempt.id,
          settlement_id: `settlement-${campaignId}`,
        }
        await service.beginQuotaSettlement(settlement)
        const consumed = await service.consumeQuotaSettlement(settlement)
        expect(consumed.attempt.state).toBe(PurchaseAttemptState.QUOTA_CONSUMED)

        const invariantRows = (await execute(
          `select count(*)::int as bad from flash_sale_capacity
            where allocation_policy_id = ? and
              (held_quantity < 0 or consumed_quantity < 0 or
               held_quantity + consumed_quantity > granted_quantity or
               raw_held_quantity->>'value' <> held_quantity::text or
               raw_consumed_quantity->>'value' <> consumed_quantity::text)`,
          [provisioned.policy.id]
        )) as Array<{ bad: number }>
        expect(invariantRows[0].bad).toBe(0)
      })

      it("rejects unknown, symbol, and non-enumerable transition fields", async () => {
        const campaignId = nextId("campaign-exact-transition")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        const base = {
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 1,
        }
        const candidates = [
          { ...base, unknown: true },
          Object.assign({ ...base }, { [Symbol("secret")]: true }),
          Object.defineProperty({ ...base }, "secret", {
            value: true,
            enumerable: false,
          }),
        ]
        for (const candidate of candidates) {
          await expectCode(
            service.openAllocation(candidate),
            AllocationCommandErrorCode.INVALID_COMMAND
          )
        }
      })

      it("atomically supersedes an unused PREPARED snapshot with higher rules", async () => {
        const campaignId = nextId("campaign-supersede")
        const first = await service.provisionAllocation(
          makeProvision(campaignId, { rules_version: 1 })
        )
        const second = await service.provisionAllocation(
          makeProvision(campaignId, { rules_version: 2 })
        )

        expect(second.policy.rules_version).toBe(2)
        expect(second.policy.state).toBe(AllocationPolicyState.PREPARED)
        const rows = (await execute(
          `select p.id, p.rules_version, p.state,
                  count(distinct c.state)::int as capacity_states,
                  min(c.state) as capacity_state
             from flash_sale_allocation_policy p
             join flash_sale_capacity c on c.allocation_policy_id = p.id
            where p.campaign_id = ?
            group by p.id, p.rules_version, p.state
            order by p.rules_version`,
          [campaignId]
        )) as Array<{
          id: string
          rules_version: number
          state: AllocationPolicyState
          capacity_states: number
          capacity_state: CapacityState
        }>
        expect(rows).toEqual([
          {
            id: first.policy.id,
            rules_version: 1,
            state: AllocationPolicyState.CLOSED,
            capacity_states: 1,
            capacity_state: CapacityState.CLOSED,
          },
          {
            id: second.policy.id,
            rules_version: 2,
            state: AllocationPolicyState.PREPARED,
            capacity_states: 1,
            capacity_state: CapacityState.PREPARED,
          },
        ])
        await expectCode(
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 1 })
          ),
          AllocationCommandErrorCode.STALE_RULES_VERSION
        )

        await service.openAllocation({
          policy_id: second.policy.id,
          expected_rules_version: 2,
          expected_version: 1,
        })
        await expectCode(
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 3 })
          ),
          AllocationCommandErrorCode.ACTIVE_POLICY_CONFLICT
        )
      })

      it("refuses to supersede a PREPARED snapshot with any purchase activity", async () => {
        const campaignId = nextId("campaign-supersede-activity")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        const attemptId = nextId("fsatt")
        await execute(
          `insert into flash_sale_purchase_attempt
            (id, allocation_policy_id, campaign_id, subject_id, cart_id,
             idempotency_key_hash, request_hash, state, rules_version,
             expires_at, version)
           values (?, ?, ?, ?, ?, ?, ?, 'pending', 1,
                   now() + interval '5 minutes', 1)`,
          [
            attemptId,
            provisioned.policy.id,
            campaignId,
            nextId("subject"),
            nextId("cart"),
            "a".repeat(64),
            "b".repeat(64),
          ]
        )

        await expectCode(
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 2 })
          ),
          AllocationCommandErrorCode.ACTIVE_POLICY_CONFLICT
        )
        await execute(
          `insert into flash_sale_allocation_hold
            (id, attempt_id, capacity_id, campaign_item_id, quantity, state,
             expires_at, version, raw_quantity)
           values (?, ?, ?, ?, 1, 'held', now() + interval '5 minutes', 1,
                   jsonb_build_object('value', '1', 'precision', 20))`,
          [
            nextId("fsahold"),
            attemptId,
            provisioned.capacities[0].id,
            provisioned.capacities[0].campaign_item_id,
          ]
        )
        await execute(
          "update flash_sale_purchase_attempt set deleted_at = now() where id = ?",
          [attemptId]
        )
        await expectCode(
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 2 })
          ),
          AllocationCommandErrorCode.ACTIVE_POLICY_CONFLICT
        )
        const state = (await execute(
          "select state, version from flash_sale_allocation_policy where id = ?",
          [provisioned.policy.id]
        )) as Array<{ state: AllocationPolicyState; version: number }>
        expect(state[0]).toEqual({
          state: AllocationPolicyState.PREPARED,
          version: 1,
        })
      })

      it("rolls back the old close when a superseding snapshot insert fails", async () => {
        const campaignId = nextId("campaign-supersede-rollback")
        const first = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        await execute(`create or replace function flash_sale_test_fail_supersede()
          returns trigger language plpgsql as $$ begin
            if new.rules_version = 2 then
              raise exception 'injected supersede failure';
            end if;
            return new;
          end $$`)
        await execute(`create trigger flash_sale_test_fail_supersede_trigger
          before insert on flash_sale_capacity for each row
          execute function flash_sale_test_fail_supersede()`)
        try {
          await expect(
            service.provisionAllocation(
              makeProvision(campaignId, { rules_version: 2 })
            )
          ).rejects.toThrow("injected supersede failure")
        } finally {
          await execute(
            "drop trigger if exists flash_sale_test_fail_supersede_trigger on flash_sale_capacity"
          )
          await execute(
            "drop function if exists flash_sale_test_fail_supersede()"
          )
        }
        const rows = (await execute(
          `select p.state, p.version,
                  min(c.state) as capacity_state,
                  min(c.version)::int as capacity_version,
                  count(distinct p.rules_version)::int as rules_count
             from flash_sale_allocation_policy p
             join flash_sale_capacity c on c.allocation_policy_id = p.id
            where p.campaign_id = ?
            group by p.state, p.version`,
          [campaignId]
        )) as Array<Record<string, unknown>>
        expect(rows).toEqual([
          {
            state: AllocationPolicyState.PREPARED,
            version: 1,
            capacity_state: CapacityState.PREPARED,
            capacity_version: 1,
            rules_count: 1,
          },
        ])
        expect(first.policy.state).toBe(AllocationPolicyState.PREPARED)
      })

      it("persists a no-policy fence and replays only the same disposition", async () => {
        const campaignId = nextId("campaign-empty-fence")
        const command = {
          campaign_id: campaignId,
          disposition: AllocationFenceDisposition.CANCELLED,
          campaign_version: 7,
          rules_version: 3,
        }
        const first = await service.fenceAndCloseCampaignAllocation(command)
        const replay = await service.fenceAndCloseCampaignAllocation({
          ...command,
          campaign_version: 8,
          rules_version: 4,
        })

        expect(first).toMatchObject({
          replayed: false,
          closed_policies: [],
          closed_capacities: [],
          fence: command,
        })
        expect(replay.replayed).toBe(true)
        expect(replay.fence.campaign_version).toBe(7)
        await expectCode(
          service.fenceAndCloseCampaignAllocation({
            ...command,
            disposition: AllocationFenceDisposition.ENDED,
          }),
          AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCE_CONFLICT
        )
        await expectCode(
          service.provisionAllocation(makeProvision(campaignId)),
          AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCED
        )
      })

      it("fences and closes an OPEN policy, then stably rejects open and provision", async () => {
        const campaignId = nextId("campaign-fence-close")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        await service.openAllocation({
          policy_id: provisioned.policy.id,
          expected_rules_version: 1,
          expected_version: 1,
        })
        const fenced = await service.fenceAndCloseCampaignAllocation({
          campaign_id: campaignId,
          disposition: AllocationFenceDisposition.ENDED,
          campaign_version: 4,
          rules_version: 1,
        })

        expect(fenced.replayed).toBe(false)
        expect(fenced.closed_policies).toHaveLength(1)
        expect(fenced.closed_policies[0].state).toBe(
          AllocationPolicyState.CLOSED
        )
        expect(
          fenced.closed_capacities.every(
            (capacity) => capacity.state === CapacityState.CLOSED
          )
        ).toBe(true)
        await expectCode(
          service.openAllocation({
            policy_id: provisioned.policy.id,
            expected_rules_version: 1,
            expected_version: 3,
          }),
          AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCED
        )
        await expectCode(
          service.provisionAllocation(
            makeProvision(campaignId, { rules_version: 2 })
          ),
          AllocationCommandErrorCode.ALLOCATION_CAMPAIGN_FENCED
        )
      })

      it("serializes fence races with provision and open", async () => {
        const provisionCampaign = nextId("campaign-fence-provision-race")
        const provisionOutcomes = await Promise.allSettled([
          service.provisionAllocation(makeProvision(provisionCampaign)),
          service.fenceAndCloseCampaignAllocation({
            campaign_id: provisionCampaign,
            disposition: AllocationFenceDisposition.CANCELLED,
            campaign_version: 2,
            rules_version: 1,
          }),
        ])
        expect(provisionOutcomes[1].status).toBe("fulfilled")

        const openCampaign = nextId("campaign-fence-open-race")
        const provisioned = await service.provisionAllocation(
          makeProvision(openCampaign)
        )
        const openOutcomes = await Promise.allSettled([
          service.openAllocation({
            policy_id: provisioned.policy.id,
            expected_rules_version: 1,
            expected_version: 1,
          }),
          service.fenceAndCloseCampaignAllocation({
            campaign_id: openCampaign,
            disposition: AllocationFenceDisposition.ENDED,
            campaign_version: 3,
            rules_version: 1,
          }),
        ])
        expect(openOutcomes[1].status).toBe("fulfilled")

        for (const campaignId of [provisionCampaign, openCampaign]) {
          const state = (await execute(
            `select
               (select count(*)::int from flash_sale_allocation_campaign_fence where campaign_id = ?) as fences,
               (select count(*)::int from flash_sale_allocation_policy
                 where campaign_id = ? and state in ('prepared', 'open')) as active`,
            [campaignId, campaignId]
          )) as Array<{ fences: number; active: number }>
          expect(state[0]).toEqual({ fences: 1, active: 0 })
        }
      })

      it("rolls back both fence and closes when one capacity close fails", async () => {
        const campaignId = nextId("campaign-fence-rollback")
        const provisioned = await service.provisionAllocation(
          makeProvision(campaignId)
        )
        await execute(`create or replace function flash_sale_test_fail_fence()
          returns trigger language plpgsql as $$ begin
            if new.campaign_item_id = '${campaignId}-item-b' and new.state = 'closed' then
              raise exception 'injected fence failure';
            end if;
            return new;
          end $$`)
        await execute(`create trigger flash_sale_test_fail_fence_trigger
          before update on flash_sale_capacity for each row
          execute function flash_sale_test_fail_fence()`)
        try {
          await expect(
            service.fenceAndCloseCampaignAllocation({
              campaign_id: campaignId,
              disposition: AllocationFenceDisposition.CANCELLED,
              campaign_version: 2,
              rules_version: 1,
            })
          ).rejects.toThrow("injected fence failure")
        } finally {
          await execute(
            "drop trigger if exists flash_sale_test_fail_fence_trigger on flash_sale_capacity"
          )
          await execute("drop function if exists flash_sale_test_fail_fence()")
        }
        const rows = (await execute(
          `select
             (select count(*)::int from flash_sale_allocation_campaign_fence where campaign_id = ?) as fences,
             (select state from flash_sale_allocation_policy where id = ?) as policy_state,
             (select count(distinct state)::int from flash_sale_capacity where allocation_policy_id = ?) as capacity_states,
             (select min(state) from flash_sale_capacity where allocation_policy_id = ?) as capacity_state`,
          [
            campaignId,
            provisioned.policy.id,
            provisioned.policy.id,
            provisioned.policy.id,
          ]
        )) as Array<Record<string, unknown>>
        expect(rows[0]).toEqual({
          fences: 0,
          policy_state: AllocationPolicyState.PREPARED,
          capacity_states: 1,
          capacity_state: CapacityState.PREPARED,
        })
      })
    })
  },
})
