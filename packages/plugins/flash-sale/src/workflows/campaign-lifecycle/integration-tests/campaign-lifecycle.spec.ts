import { MedusaContainer } from "@medusajs/framework"
import { asValue, createContainer } from "@medusajs/framework/awilix"
import { MikroOrmBaseRepository } from "@medusajs/framework/utils"
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"

import {
  AllocationCommandErrorCode,
  FlashSaleAllocationModuleService,
} from "../../../modules/flash-sale-allocation"
import {
  Campaign,
  CampaignItem,
  FlashSaleCampaignModuleService,
} from "../../../modules/flash-sale-campaign"
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
} from "../../../modules/flash-sale-allocation/models"
import {
  AllocationPolicyState,
  AllocationPolicyDTO,
  CampaignState,
  FlashSalePluginModule,
} from "../../../types"
import {
  activateCampaignWorkflow,
  cancelCampaignWorkflow,
  endCampaignWorkflow,
  scheduleCampaignWorkflow,
} from "../workflows"
import { AllocationLifecycleModuleService } from "../contracts"

jest.setTimeout(120000)

const campaignMigrations = path.resolve(
  __dirname,
  "../../../modules/flash-sale-campaign/migrations"
)
const allocationMigrations = path.resolve(
  __dirname,
  "../../../modules/flash-sale-allocation/migrations"
)

async function expectWorkflowFailure(
  execution: Promise<unknown>,
  message: string
): Promise<void> {
  const result = (await execution) as { thrownError?: unknown }
  expect(result.thrownError).toMatchObject({
    message: expect.stringContaining(message),
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

moduleIntegrationTestRunner<FlashSaleCampaignModuleService>({
  moduleName: FlashSalePluginModule.CAMPAIGN,
  resolve: path.resolve(__dirname, "../../../modules/flash-sale-campaign"),
  cwd: path.resolve(__dirname, "../../../../.."),
  dbName: "medusa-flash-sale-lifecycle",
  moduleModels: [
    Campaign,
    CampaignItem,
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
  pathToMigrations: [campaignMigrations, allocationMigrations],
  testSuite: ({ MikroOrmWrapper, service: campaignService }) => {
    function createLifecycleHarness(
      hooks: {
        afterProvision?: () => Promise<void>
        beforeOpen?: () => Promise<void>
      } = {}
    ) {
      const repository = new MikroOrmBaseRepository({
        manager: MikroOrmWrapper.getOrm().em,
      })
      const allocationService = new FlashSaleAllocationModuleService({
        baseRepository: repository,
      })
      const manager = MikroOrmWrapper.forkManager()
      // The Allocation service is instantiated against the real repository in
      // this dual-module harness. Generated read services are normally wired by
      // the module loader, so the harness supplies only that read port while
      // every write still goes through the real Allocation Module Service.
      const allocationPort: AllocationLifecycleModuleService = {
        provisionAllocation: async (command) => {
          const result = await allocationService.provisionAllocation(command)
          await hooks.afterProvision?.()
          return result
        },
        openAllocation: async (command) => {
          await hooks.beforeOpen?.()
          return await allocationService.openAllocation(command)
        },
        closeAllocation: (command) =>
          allocationService.closeAllocation(command),
        fenceAndCloseCampaignAllocation: (command) =>
          allocationService.fenceAndCloseCampaignAllocation(command),
        claimAndHoldQuota: (command) =>
          allocationService.claimAndHoldQuota(command),
        listAllocationPolicies: async (filters = {}) => {
          const rows = (await manager.execute(
            `select id, campaign_id, rules_version, configuration_hash, state,
                    starts_at, ends_at, hold_ttl_seconds, per_subject_limit,
                    version, created_at, updated_at, deleted_at
               from flash_sale_allocation_policy
              where campaign_id = ?
                and (?::int is null or rules_version = ?::int)
                and deleted_at is null
              order by id`,
            [
              filters.campaign_id,
              filters.rules_version ?? null,
              filters.rules_version ?? null,
            ]
          )) as AllocationPolicyDTO[]
          return rows
        },
      }
      const container = createContainer() as unknown as MedusaContainer
      container.register({
        [FlashSalePluginModule.CAMPAIGN]: asValue(campaignService),
        [FlashSalePluginModule.ALLOCATION]: asValue(allocationPort),
      })
      return { allocationPort, container, manager }
    }

    it("uses real modules and converges across open and Campaign failure windows", async () => {
      const { allocationPort, container, manager } = createLifecycleHarness()
      const now = Date.now()
      const campaign = await campaignService.createCampaigns({
        name: "Lifecycle integration",
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 3_600_000),
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
      })
      const item = await campaignService.createCampaignItems({
        campaign_id: campaign.id,
        variant_id: "variant_lifecycle",
        quota: 10,
      })

      const scheduled = await scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect(scheduled.result).toMatchObject({
        campaign: { state: CampaignState.SCHEDULED },
        allocation_policy: { state: AllocationPolicyState.PREPARED },
      })

      await manager.execute(`create or replace function flash_sale_workflow_fail_open()
        returns trigger language plpgsql as $$ begin
          if new.state = 'open' then raise exception 'workflow open failpoint'; end if;
          return new;
        end $$`)
      await manager.execute(`create trigger flash_sale_workflow_fail_open_trigger
        before update on flash_sale_capacity for each row
        execute function flash_sale_workflow_fail_open()`)
      try {
        await expectWorkflowFailure(
          activateCampaignWorkflow(container).run({
            input: { campaign_id: campaign.id },
            throwOnError: false,
          }),
          "workflow open failpoint"
        )
      } finally {
        await manager.execute(
          "drop trigger if exists flash_sale_workflow_fail_open_trigger on flash_sale_capacity"
        )
        await manager.execute(
          "drop function if exists flash_sale_workflow_fail_open()"
        )
      }
      expect((await campaignService.retrieveCampaign(campaign.id)).state).toBe(
        CampaignState.ACTIVE
      )
      let policies = await allocationPort.listAllocationPolicies({
        campaign_id: campaign.id,
      })
      expect(policies[0].state).toBe(AllocationPolicyState.PREPARED)
      await expect(
        allocationPort.claimAndHoldQuota({
          campaign_id: campaign.id,
          subject_id: "subject_fail_closed",
          cart_id: "cart_fail_closed",
          idempotency_key_hash: "a".repeat(64),
          expected_rules_version: policies[0].rules_version,
          items: [{ campaign_item_id: item.id, quantity: 1 }],
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
      })

      const activated = await activateCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect(activated.result).toMatchObject({
        campaign: { state: CampaignState.ACTIVE },
        allocation_policy: { state: AllocationPolicyState.OPEN },
      })
      await expect(
        allocationPort.claimAndHoldQuota({
          campaign_id: campaign.id,
          subject_id: "subject_admitted",
          cart_id: "cart_admitted",
          idempotency_key_hash: "b".repeat(64),
          expected_rules_version: activated.result.campaign.rules_version,
          items: [{ campaign_item_id: item.id, quantity: 1 }],
        })
      ).resolves.toMatchObject({ status: "held" })

      await manager.execute(`create or replace function flash_sale_workflow_fail_cancel()
        returns trigger language plpgsql as $$ begin
          if new.state = 'cancelled' then raise exception 'workflow cancel failpoint'; end if;
          return new;
        end $$`)
      await manager.execute(`create trigger flash_sale_workflow_fail_cancel_trigger
        before update on flash_sale_campaign for each row
        execute function flash_sale_workflow_fail_cancel()`)
      try {
        await expectWorkflowFailure(
          cancelCampaignWorkflow(container).run({
            input: { campaign_id: campaign.id },
            throwOnError: false,
          }),
          "workflow cancel failpoint"
        )
      } finally {
        await manager.execute(
          "drop trigger if exists flash_sale_workflow_fail_cancel_trigger on flash_sale_campaign"
        )
        await manager.execute(
          "drop function if exists flash_sale_workflow_fail_cancel()"
        )
      }
      expect((await campaignService.retrieveCampaign(campaign.id)).state).toBe(
        CampaignState.ACTIVE
      )
      policies = await allocationPort.listAllocationPolicies({
        campaign_id: campaign.id,
      })
      expect(policies[0].state).toBe(AllocationPolicyState.CLOSED)

      const cancelled = await cancelCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect(cancelled.result).toMatchObject({
        campaign: { state: CampaignState.CANCELLED },
        allocation_policy: { state: AllocationPolicyState.CLOSED },
      })
    })

    it("keeps schedule and end failure windows fail-closed and retryable", async () => {
      const { allocationPort, container, manager } = createLifecycleHarness()
      const now = Date.now()
      const campaign = await campaignService.createCampaigns({
        name: "Lifecycle schedule and end failure windows",
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 3_600_000),
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
      })
      const item = await campaignService.createCampaignItems({
        campaign_id: campaign.id,
        variant_id: "variant_schedule_end_lifecycle",
        quota: 10,
      })

      await manager.execute(`create or replace function flash_sale_workflow_fail_schedule()
        returns trigger language plpgsql as $$ begin
          if new.state = 'scheduled' then raise exception 'workflow schedule failpoint'; end if;
          return new;
        end $$`)
      await manager.execute(`create trigger flash_sale_workflow_fail_schedule_trigger
        before update on flash_sale_campaign for each row
        execute function flash_sale_workflow_fail_schedule()`)
      try {
        await expectWorkflowFailure(
          scheduleCampaignWorkflow(container).run({
            input: { campaign_id: campaign.id },
            throwOnError: false,
          }),
          "workflow schedule failpoint"
        )
      } finally {
        await manager.execute(
          "drop trigger if exists flash_sale_workflow_fail_schedule_trigger on flash_sale_campaign"
        )
        await manager.execute(
          "drop function if exists flash_sale_workflow_fail_schedule()"
        )
      }
      expect((await campaignService.retrieveCampaign(campaign.id)).state).toBe(
        CampaignState.DRAFT
      )
      let policies = await allocationPort.listAllocationPolicies({
        campaign_id: campaign.id,
      })
      expect(policies).toHaveLength(1)
      expect(policies[0].state).toBe(AllocationPolicyState.PREPARED)
      await expect(
        allocationPort.claimAndHoldQuota({
          campaign_id: campaign.id,
          subject_id: "subject_schedule_fail_closed",
          cart_id: "cart_schedule_fail_closed",
          idempotency_key_hash: "c".repeat(64),
          expected_rules_version: policies[0].rules_version,
          items: [{ campaign_item_id: item.id, quantity: 1 }],
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.FLASH_SALE_NOT_ACTIVE,
      })

      await scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      await activateCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })

      await manager.execute(`create or replace function flash_sale_workflow_fail_end()
        returns trigger language plpgsql as $$ begin
          if new.state = 'ended' then raise exception 'workflow end failpoint'; end if;
          return new;
        end $$`)
      await manager.execute(`create trigger flash_sale_workflow_fail_end_trigger
        before update on flash_sale_campaign for each row
        execute function flash_sale_workflow_fail_end()`)
      try {
        await expectWorkflowFailure(
          endCampaignWorkflow(container).run({
            input: { campaign_id: campaign.id },
            throwOnError: false,
          }),
          "workflow end failpoint"
        )
      } finally {
        await manager.execute(
          "drop trigger if exists flash_sale_workflow_fail_end_trigger on flash_sale_campaign"
        )
        await manager.execute(
          "drop function if exists flash_sale_workflow_fail_end()"
        )
      }
      expect((await campaignService.retrieveCampaign(campaign.id)).state).toBe(
        CampaignState.ACTIVE
      )
      policies = await allocationPort.listAllocationPolicies({
        campaign_id: campaign.id,
      })
      expect(policies[0].state).toBe(AllocationPolicyState.CLOSED)

      const ended = await endCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect(ended.result).toMatchObject({
        campaign: { state: CampaignState.ENDED },
        allocation_policy: { state: AllocationPolicyState.CLOSED },
      })
    })

    it("rejects an exact schedule-vs-edit interleaving, then supersedes and converges", async () => {
      const provisionReached = deferred()
      const resumeSchedule = deferred()
      const { container, manager } = createLifecycleHarness({
        afterProvision: async () => {
          provisionReached.resolve()
          await resumeSchedule.promise
        },
      })
      const now = Date.now()
      const campaign = await campaignService.createCampaigns({
        name: "Lifecycle schedule versus edit",
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 3_600_000),
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
      })
      const item = await campaignService.createCampaignItems({
        campaign_id: campaign.id,
        variant_id: "variant_schedule_edit",
        quota: 10,
      })
      const beforeEdit = await campaignService.retrieveCampaign(campaign.id)

      const scheduling = scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
        throwOnError: false,
      })
      await provisionReached.promise
      await campaignService.updateCampaignItemQuota({ id: item.id, quota: 11 })
      resumeSchedule.resolve()

      await expectWorkflowFailure(scheduling, "items changed")
      const afterEdit = await campaignService.retrieveCampaign(campaign.id)
      expect(afterEdit).toMatchObject({
        state: CampaignState.DRAFT,
        version: beforeEdit.version + 1,
        rules_version: beforeEdit.rules_version + 1,
      })

      const scheduled = await scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      expect(scheduled.result).toMatchObject({
        campaign: {
          state: CampaignState.SCHEDULED,
          rules_version: afterEdit.rules_version,
        },
        allocation_policy: {
          state: AllocationPolicyState.PREPARED,
          rules_version: afterEdit.rules_version,
        },
      })
      const policies = (await manager.execute(
        `select rules_version, state from flash_sale_allocation_policy
          where campaign_id = ? order by rules_version`,
        [campaign.id]
      )) as Array<{ rules_version: number; state: AllocationPolicyState }>
      expect(policies).toEqual([
        {
          rules_version: beforeEdit.rules_version,
          state: AllocationPolicyState.CLOSED,
        },
        {
          rules_version: afterEdit.rules_version,
          state: AllocationPolicyState.PREPARED,
        },
      ])
    })

    it("makes an exact schedule-vs-cancel interleaving terminal and fenced", async () => {
      const provisionReached = deferred()
      const resumeSchedule = deferred()
      const { container, manager } = createLifecycleHarness({
        afterProvision: async () => {
          provisionReached.resolve()
          await resumeSchedule.promise
        },
      })
      const now = Date.now()
      const campaign = await campaignService.createCampaigns({
        name: "Lifecycle schedule versus cancel",
        starts_at: new Date(now - 60_000),
        ends_at: new Date(now + 3_600_000),
        hold_ttl_seconds: 300,
        per_subject_limit: 2,
      })
      await campaignService.createCampaignItems({
        campaign_id: campaign.id,
        variant_id: "variant_schedule_cancel",
        quota: 10,
      })

      const scheduling = scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
        throwOnError: false,
      })
      await provisionReached.promise
      const cancelled = await cancelCampaignWorkflow(container).run({
        input: { campaign_id: campaign.id },
      })
      resumeSchedule.resolve()
      await expectWorkflowFailure(scheduling, "version changed")

      expect(cancelled.result).toMatchObject({
        campaign: { state: CampaignState.CANCELLED },
        allocation_fence: { disposition: "cancelled" },
      })
      const allocationRows = (await manager.execute(
        `select
           (select count(*)::int from flash_sale_allocation_campaign_fence
             where campaign_id = ? and disposition = 'cancelled') as fences,
           (select count(*)::int from flash_sale_allocation_policy
             where campaign_id = ? and state in ('prepared', 'open')) as live_policies,
           (select count(*)::int from flash_sale_capacity c
             join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
             where p.campaign_id = ? and c.state in ('prepared', 'open')) as live_capacities`,
        [campaign.id, campaign.id, campaign.id]
      )) as Array<{
        fences: number
        live_policies: number
        live_capacities: number
      }>
      expect(allocationRows[0]).toEqual({
        fences: 1,
        live_policies: 0,
        live_capacities: 0,
      })
    })

    it.each([
      ["cancel", CampaignState.CANCELLED, cancelCampaignWorkflow],
      ["end", CampaignState.ENDED, endCampaignWorkflow],
    ] as const)(
      "prevents Allocation OPEN in an exact activate-vs-%s interleaving",
      async (_operation, terminalState, terminalWorkflow) => {
        const openReached = deferred()
        const resumeOpen = deferred()
        const { container, manager } = createLifecycleHarness({
          beforeOpen: async () => {
            openReached.resolve()
            await resumeOpen.promise
          },
        })
        const now = Date.now()
        const campaign = await campaignService.createCampaigns({
          name: `Lifecycle activate versus ${terminalState}`,
          starts_at: new Date(now - 60_000),
          ends_at: new Date(now + 3_600_000),
          hold_ttl_seconds: 300,
          per_subject_limit: 2,
        })
        await campaignService.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: `variant_activate_${terminalState}`,
          quota: 10,
        })
        await scheduleCampaignWorkflow(container).run({
          input: { campaign_id: campaign.id },
        })

        const activating = activateCampaignWorkflow(container).run({
          input: { campaign_id: campaign.id },
          throwOnError: false,
        })
        await openReached.promise
        const terminal = await terminalWorkflow(container).run({
          input: { campaign_id: campaign.id },
        })
        resumeOpen.resolve()
        await expectWorkflowFailure(activating, "fenced")

        expect(terminal.result.campaign.state).toBe(terminalState)
        const states = (await manager.execute(
          `select p.state as policy_state, min(c.state) as capacity_state,
                  max(c.state) as max_capacity_state
             from flash_sale_allocation_policy p
             join flash_sale_capacity c on c.allocation_policy_id = p.id
            where p.campaign_id = ? group by p.state`,
          [campaign.id]
        )) as Array<{
          policy_state: AllocationPolicyState
          capacity_state: string
          max_capacity_state: string
        }>
        expect(states).toEqual([
          {
            policy_state: AllocationPolicyState.CLOSED,
            capacity_state: "closed",
            max_capacity_state: "closed",
          },
        ])
      }
    )
  },
})
