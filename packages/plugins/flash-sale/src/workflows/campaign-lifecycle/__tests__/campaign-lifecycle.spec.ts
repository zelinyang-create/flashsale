import { MedusaContainer } from "@medusajs/framework"
import { asValue, createContainer } from "@medusajs/framework/awilix"
import fs from "fs"
import path from "path"

import { createAllocationConfigurationHash } from "../../../modules/flash-sale-allocation"
import {
  AllocationPolicyDTO,
  AllocationPolicyState,
  AllocationCampaignFenceDTO,
  AllocationFenceDisposition,
  CampaignState,
  CapacityState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  FlashSalePluginModule,
  PurchaseAttemptState,
} from "../../../types"
import {
  AllocationLifecycleModuleService,
  CampaignLifecycleModuleService,
} from "../contracts"
import {
  activateCampaignWorkflow,
  cancelCampaignWorkflow,
  endCampaignWorkflow,
  scheduleCampaignWorkflow,
} from "../workflows"

type Operation =
  | "allocation:provision"
  | "allocation:open"
  | "allocation:fence"
  | `campaign:${CampaignState}`

const clone = <T>(value: T): T => structuredClone(value)

class FakeCampaignModule implements CampaignLifecycleModuleService {
  campaign: FlashSaleCampaignDTO = {
    id: "campaign_1",
    name: "Launch",
    description: null,
    state: CampaignState.DRAFT,
    starts_at: new Date("2030-01-01T00:00:00.000Z"),
    ends_at: new Date("2030-01-01T01:00:00.000Z"),
    version: 1,
    rules_version: 1,
    campaign_epoch: 1,
    hold_ttl_seconds: 300,
    per_subject_limit: 2,
    metadata: null,
  }
  items: FlashSaleCampaignItemDTO[] = [
    {
      id: "campaign_item_1",
      campaign_id: "campaign_1",
      variant_id: "variant_1",
      location_id: null,
      quota: 10,
      version: 1,
      metadata: null,
    },
  ]
  failTransitionOnce: CampaignState | null = null
  mutateEveryItemRead = false

  constructor(private readonly operations: Operation[]) {}

  async retrieveCampaign(id: string): Promise<FlashSaleCampaignDTO> {
    if (id !== this.campaign.id) {
      throw new Error("campaign not found")
    }
    return clone(this.campaign)
  }

  async listCampaignItems(): Promise<FlashSaleCampaignItemDTO[]> {
    if (this.mutateEveryItemRead && this.items[0]) {
      this.items[0].quota += 1
      this.items[0].version += 1
    }
    return clone(this.items)
  }

  private transition(state: CampaignState): FlashSaleCampaignDTO {
    this.operations.push(`campaign:${state}`)
    if (this.failTransitionOnce === state) {
      this.failTransitionOnce = null
      throw new Error(`injected ${state} failure`)
    }
    const allowed: Record<CampaignState, CampaignState[]> = {
      [CampaignState.DRAFT]: [CampaignState.DRAFT, CampaignState.SCHEDULED, CampaignState.CANCELLED],
      [CampaignState.SCHEDULED]: [CampaignState.SCHEDULED, CampaignState.ACTIVE, CampaignState.CANCELLED],
      [CampaignState.ACTIVE]: [CampaignState.ACTIVE, CampaignState.ENDED, CampaignState.CANCELLED],
      [CampaignState.ENDED]: [CampaignState.ENDED],
      [CampaignState.CANCELLED]: [CampaignState.CANCELLED],
    }
    if (!allowed[this.campaign.state].includes(state)) {
      throw new Error(`invalid transition ${this.campaign.state} -> ${state}`)
    }
    if (this.campaign.state !== state) {
      this.campaign.state = state
      this.campaign.version += 1
    }
    return clone(this.campaign)
  }

  async transitionCampaignStateFromSnapshot(
    command: Parameters<CampaignLifecycleModuleService["transitionCampaignStateFromSnapshot"]>[0]
  ): Promise<FlashSaleCampaignDTO> {
    if (command.campaign_id !== this.campaign.id) {
      throw new Error("campaign not found")
    }
    const expectedItems = [...command.expected_items].sort((left, right) =>
      left.campaign_item_id.localeCompare(right.campaign_item_id)
    )
    const actualItems = this.items
      .map((item) => ({
        campaign_item_id: item.id,
        quota: item.quota,
        version: item.version,
      }))
      .sort((left, right) =>
        left.campaign_item_id.localeCompare(right.campaign_item_id)
      )
    if (
      command.expected_version !== this.campaign.version ||
      command.expected_rules_version !== this.campaign.rules_version ||
      JSON.stringify(expectedItems) !== JSON.stringify(actualItems)
    ) {
      throw new Error("CAMPAIGN_SNAPSHOT_CONFLICT")
    }
    return this.transition(command.target_state)
  }

  async transitionCampaignStateWithVersion(
    command: Parameters<CampaignLifecycleModuleService["transitionCampaignStateWithVersion"]>[0]
  ): Promise<FlashSaleCampaignDTO> {
    if (command.campaign_id !== this.campaign.id) {
      throw new Error("campaign not found")
    }
    if (
      command.expected_rules_version !== this.campaign.rules_version ||
      (this.campaign.state !== command.target_state &&
        command.expected_version !== this.campaign.version)
    ) {
      throw new Error("CAMPAIGN_VERSION_CONFLICT")
    }
    return this.transition(command.target_state)
  }
}

class FakeAllocationModule implements AllocationLifecycleModuleService {
  policy: AllocationPolicyDTO | null = null
  fence: AllocationCampaignFenceDTO | null = null
  failOpenOnce = false
  afterProvisionOnce: (() => void) | null = null

  constructor(private readonly operations: Operation[]) {}

  private result(replayed: boolean) {
    if (!this.policy) {
      throw new Error("policy not found")
    }
    return {
      policy: clone(this.policy),
      capacities: [
        {
          id: "capacity_1",
          allocation_policy_id: this.policy.id,
          campaign_item_id: "campaign_item_1",
          shard_no: 0,
          state:
            this.policy.state === AllocationPolicyState.PREPARED
              ? CapacityState.PREPARED
              : this.policy.state === AllocationPolicyState.OPEN
              ? CapacityState.OPEN
              : CapacityState.CLOSED,
          granted_quantity: 10,
          held_quantity: 0,
          consumed_quantity: 0,
          rules_version: this.policy.rules_version,
          version: this.policy.version,
          created_at: this.policy.created_at,
          updated_at: this.policy.updated_at,
          deleted_at: null,
        },
      ],
      replayed,
    }
  }

  async provisionAllocation(command: Parameters<AllocationLifecycleModuleService["provisionAllocation"]>[0]) {
    this.operations.push("allocation:provision")
    if (this.fence) {
      throw new Error("ALLOCATION_CAMPAIGN_FENCED")
    }
    const expectedHash = createAllocationConfigurationHash({
      campaign_id: command.campaign_id,
      rules_version: command.rules_version,
      starts_at: command.starts_at,
      ends_at: command.ends_at,
      hold_ttl_seconds: command.hold_ttl_seconds,
      per_subject_limit: command.per_subject_limit,
      items: command.items,
    })
    if (command.configuration_hash !== expectedHash) {
      throw new Error("invalid canonical hash")
    }
    if (this.policy) {
      if (this.policy.rules_version > command.rules_version) {
        throw new Error("ACTIVE_POLICY_CONFLICT")
      }
      if (this.policy.rules_version === command.rules_version) {
        if (this.policy.configuration_hash !== command.configuration_hash) {
          throw new Error("IDEMPOTENCY_CONFLICT")
        }
        return this.result(true)
      }
      if (this.policy.state !== AllocationPolicyState.PREPARED) {
        throw new Error("ACTIVE_POLICY_CONFLICT")
      }
      if (this.policy.configuration_hash === command.configuration_hash) {
        throw new Error("IDEMPOTENCY_CONFLICT")
      }
      this.policy.state = AllocationPolicyState.CLOSED
      this.policy.version += 1
    }
    this.policy = {
      id: "policy_1",
      campaign_id: command.campaign_id,
      rules_version: command.rules_version,
      configuration_hash: command.configuration_hash,
      state: AllocationPolicyState.PREPARED,
      starts_at: new Date(command.starts_at),
      ends_at: new Date(command.ends_at),
      hold_ttl_seconds: command.hold_ttl_seconds,
      per_subject_limit: command.per_subject_limit,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    }
    const afterProvision = this.afterProvisionOnce
    this.afterProvisionOnce = null
    afterProvision?.()
    return this.result(false)
  }

  async openAllocation(command: Parameters<AllocationLifecycleModuleService["openAllocation"]>[0]) {
    this.operations.push("allocation:open")
    if (this.fence) {
      throw new Error("ALLOCATION_CAMPAIGN_FENCED")
    }
    if (this.failOpenOnce) {
      this.failOpenOnce = false
      throw new Error("injected open failure")
    }
    if (!this.policy || command.policy_id !== this.policy.id) {
      throw new Error("policy not found")
    }
    if (this.policy.state === AllocationPolicyState.OPEN) {
      return this.result(true)
    }
    if (
      this.policy.state !== AllocationPolicyState.PREPARED ||
      command.expected_version !== this.policy.version ||
      command.expected_rules_version !== this.policy.rules_version
    ) {
      throw new Error("policy state conflict")
    }
    this.policy.state = AllocationPolicyState.OPEN
    this.policy.version += 1
    return this.result(false)
  }

  async closeAllocation(command: Parameters<AllocationLifecycleModuleService["closeAllocation"]>[0]) {
    if (!this.policy || command.policy_id !== this.policy.id) {
      throw new Error("policy not found")
    }
    if (this.policy.state === AllocationPolicyState.CLOSED) {
      return this.result(true)
    }
    if (
      command.expected_version !== this.policy.version ||
      command.expected_rules_version !== this.policy.rules_version
    ) {
      throw new Error("policy state conflict")
    }
    this.policy.state = AllocationPolicyState.CLOSED
    this.policy.version += 1
    return this.result(false)
  }

  async fenceAndCloseCampaignAllocation(
    command: Parameters<AllocationLifecycleModuleService["fenceAndCloseCampaignAllocation"]>[0]
  ) {
    this.operations.push("allocation:fence")
    if (this.fence && this.fence.disposition !== command.disposition) {
      throw new Error("ALLOCATION_CAMPAIGN_FENCE_CONFLICT")
    }
    const replayed = this.fence !== null
    if (!this.fence) {
      const now = new Date()
      this.fence = {
        id: "fence_1",
        campaign_id: command.campaign_id,
        disposition: command.disposition,
        campaign_version: command.campaign_version,
        rules_version: command.rules_version,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      }
    }
    const closedPolicies = []
    const closedCapacities = []
    if (
      this.policy &&
      this.policy.campaign_id === command.campaign_id &&
      this.policy.state !== AllocationPolicyState.CLOSED
    ) {
      this.policy.state = AllocationPolicyState.CLOSED
      this.policy.version += 1
      const closed = this.result(false)
      closedPolicies.push(closed.policy)
      closedCapacities.push(...closed.capacities)
    }
    return {
      fence: clone(this.fence),
      closed_policies: closedPolicies,
      closed_capacities: closedCapacities,
      replayed,
    }
  }

  async listAllocationPolicies(): Promise<AllocationPolicyDTO[]> {
    return this.policy ? [clone(this.policy)] : []
  }

  async claimAndHoldQuota() {
    if (this.policy?.state !== AllocationPolicyState.OPEN) {
      throw new Error("FLASH_SALE_NOT_ACTIVE")
    }
    const now = new Date()
    return {
      status: "held" as const,
      replayed: false,
      attempt: {
        id: "attempt_1",
        allocation_policy_id: this.policy.id,
        campaign_id: this.policy.campaign_id,
        subject_id: "subject_1",
        cart_id: "cart_1",
        idempotency_key_hash: "a".repeat(64),
        request_hash: "b".repeat(64),
        state: PurchaseAttemptState.QUOTA_HELD,
        rules_version: this.policy.rules_version,
        expires_at: new Date(now.getTime() + 60_000),
        version: 2,
        last_error_code: null,
        terminal_at: null,
        settlement_id: null,
        settlement_started_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
      holds: [],
    }
  }
}

let fixtureSequence = 0

function fixture() {
  const operations: Operation[] = []
  const campaign = new FakeCampaignModule(operations)
  const campaignId = `campaign_${++fixtureSequence}`
  campaign.campaign.id = campaignId
  campaign.items[0].campaign_id = campaignId
  campaign.items[0].id = `${campaignId}_item`
  const allocation = new FakeAllocationModule(operations)
  const container = createContainer() as unknown as MedusaContainer
  container.register({
    [FlashSalePluginModule.CAMPAIGN]: asValue(campaign),
    [FlashSalePluginModule.ALLOCATION]: asValue(allocation),
  })
  return { allocation, campaign, container, operations }
}

async function expectWorkflowFailure(
  execution: Promise<unknown>,
  message: string
): Promise<void> {
  const result = (await execution) as { thrownError?: unknown }
  expect(result.thrownError).toMatchObject({
    message: expect.stringContaining(message),
  })
}

describe("flash-sale campaign lifecycle workflows", () => {
  it("schedules in allocation-first order and replays to one PREPARED policy", async () => {
    const { allocation, campaign, container, operations } = fixture()

    const first = await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    const second = await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })

    expect(operations.slice(0, 2)).toEqual([
      "allocation:provision",
      `campaign:${CampaignState.SCHEDULED}`,
    ])
    expect(first.result.campaign.state).toBe(CampaignState.SCHEDULED)
    expect(first.result.allocation_policy?.state).toBe(
      AllocationPolicyState.PREPARED
    )
    expect(second.result.allocation_policy?.id).toBe(allocation.policy?.id)
    expect(campaign.campaign.state).toBe(CampaignState.SCHEDULED)
  })

  it("activates Campaign before Allocation and admits claims", async () => {
    const { allocation, campaign, container, operations } = fixture()
    await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    operations.length = 0

    const activated = await activateCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })

    expect(operations).toEqual([
      "allocation:provision",
      `campaign:${CampaignState.ACTIVE}`,
      "allocation:open",
    ])
    expect(activated.result.campaign.state).toBe(CampaignState.ACTIVE)
    expect(activated.result.allocation_policy?.state).toBe(
      AllocationPolicyState.OPEN
    )
    await expect(allocation.claimAndHoldQuota()).resolves.toMatchObject({
      status: "held",
    })
  })

  it("keeps activation fail-closed after open failure and converges on retry", async () => {
    const { allocation, campaign, container } = fixture()
    await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    allocation.failOpenOnce = true

    await expectWorkflowFailure(
      activateCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "injected open failure"
    )
    expect(campaign.campaign.state).toBe(CampaignState.ACTIVE)
    expect(allocation.policy?.state).toBe(AllocationPolicyState.PREPARED)
    await expect(allocation.claimAndHoldQuota()).rejects.toThrow(
      "FLASH_SALE_NOT_ACTIVE"
    )

    await activateCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    expect(campaign.campaign.state).toBe(CampaignState.ACTIVE)
    expect(allocation.policy?.state).toBe(AllocationPolicyState.OPEN)
  })

  it("closes before cancel and remains closed across a Campaign failure", async () => {
    const { allocation, campaign, container, operations } = fixture()
    await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    operations.length = 0
    campaign.failTransitionOnce = CampaignState.CANCELLED

    await expectWorkflowFailure(
      cancelCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "injected cancelled failure"
    )
    expect(operations.slice(0, 2)).toEqual([
      "allocation:fence",
      `campaign:${CampaignState.CANCELLED}`,
    ])
    expect(allocation.policy?.state).toBe(AllocationPolicyState.CLOSED)
    expect(campaign.campaign.state).toBe(CampaignState.SCHEDULED)

    await cancelCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    expect(allocation.policy?.state).toBe(AllocationPolicyState.CLOSED)
    expect(campaign.campaign.state).toBe(CampaignState.CANCELLED)
  })

  it("closes before end and remains closed across a Campaign failure", async () => {
    const { allocation, campaign, container, operations } = fixture()
    await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    await activateCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    operations.length = 0
    campaign.failTransitionOnce = CampaignState.ENDED

    await expectWorkflowFailure(
      endCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "injected ended failure"
    )
    expect(operations.slice(0, 2)).toEqual([
      "allocation:fence",
      `campaign:${CampaignState.ENDED}`,
    ])
    expect(allocation.policy?.state).toBe(AllocationPolicyState.CLOSED)
    expect(campaign.campaign.state).toBe(CampaignState.ACTIVE)

    await endCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })
    expect(campaign.campaign.state).toBe(CampaignState.ENDED)
  })

  it("rejects empty and unstable snapshots before provisioning", async () => {
    const empty = fixture()
    empty.campaign.items = []
    await expectWorkflowFailure(
      scheduleCampaignWorkflow(empty.container).run({
        input: { campaign_id: empty.campaign.campaign.id },
        throwOnError: false,
      }),
      "must contain at least one item"
    )
    expect(empty.allocation.policy).toBeNull()

    const unstable = fixture()
    unstable.campaign.mutateEveryItemRead = true
    await expectWorkflowFailure(
      scheduleCampaignWorkflow(unstable.container).run({
        input: { campaign_id: unstable.campaign.campaign.id },
        throwOnError: false,
      }),
      "changed while its allocation snapshot was read"
    )
    expect(unstable.allocation.policy).toBeNull()
  })

  it("rejects an item-set change between provision and Campaign commit", async () => {
    const { allocation, campaign, container } = fixture()
    allocation.afterProvisionOnce = () => {
      campaign.items.push({
        id: `${campaign.campaign.id}_late_item`,
        campaign_id: campaign.campaign.id,
        variant_id: "variant_late",
        location_id: null,
        quota: 1,
        version: 1,
        metadata: null,
      })
      campaign.campaign.version += 1
      campaign.campaign.rules_version += 1
    }

    await expectWorkflowFailure(
      scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "CAMPAIGN_SNAPSHOT_CONFLICT"
    )
    expect(campaign.campaign.state).toBe(CampaignState.DRAFT)
    expect(allocation.policy).toMatchObject({
      state: AllocationPolicyState.PREPARED,
      rules_version: 1,
    })
  })

  it("supersedes a stranded PREPARED policy after a legitimate rule edit", async () => {
    const { allocation, campaign, container } = fixture()
    campaign.failTransitionOnce = CampaignState.SCHEDULED
    await expectWorkflowFailure(
      scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "injected scheduled failure"
    )
    expect(allocation.policy?.state).toBe(AllocationPolicyState.PREPARED)

    campaign.campaign.per_subject_limit = 3
    campaign.campaign.version += 1
    campaign.campaign.rules_version += 1
    const scheduled = await scheduleCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })

    expect(scheduled.result.campaign.state).toBe(CampaignState.SCHEDULED)
    expect(scheduled.result.allocation_policy).toMatchObject({
      rules_version: 2,
      state: AllocationPolicyState.PREPARED,
    })
  })

  it("persists a no-policy cancel fence that blocks a later schedule", async () => {
    const { allocation, campaign, container } = fixture()

    const cancelled = await cancelCampaignWorkflow(container).run({
      input: { campaign_id: campaign.campaign.id },
    })

    expect(cancelled.result).toMatchObject({
      campaign: { state: CampaignState.CANCELLED },
      allocation_policy: null,
      allocation_fence: {
        disposition: AllocationFenceDisposition.CANCELLED,
      },
    })
    expect(allocation.fence?.campaign_id).toBe(campaign.campaign.id)
    await expectWorkflowFailure(
      scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id },
        throwOnError: false,
      }),
      "cannot schedule from cancelled"
    )
  })

  it("enforces the exact external workflow boundary", async () => {
    const { campaign, container } = fixture()
    await expectWorkflowFailure(
      scheduleCampaignWorkflow(container).run({
        input: { campaign_id: campaign.campaign.id, state: "active" } as never,
        throwOnError: false,
      }),
      "exactly campaign_id"
    )
  })

  it("keeps Campaign and Allocation production modules import-isolated", () => {
    const moduleRoot = path.resolve(__dirname, "../../../modules")
    const campaignFiles = fs
      .readdirSync(path.join(moduleRoot, "flash-sale-campaign"), {
        recursive: true,
      })
      .filter((entry) => String(entry).endsWith(".ts"))
      .filter(
        (entry) =>
          !String(entry).includes("__tests__") &&
          !String(entry).includes("integration-tests")
      )
    const allocationFiles = fs
      .readdirSync(path.join(moduleRoot, "flash-sale-allocation"), {
        recursive: true,
      })
      .filter((entry) => String(entry).endsWith(".ts"))
      .filter(
        (entry) =>
          !String(entry).includes("__tests__") &&
          !String(entry).includes("integration-tests")
      )

    for (const entry of campaignFiles) {
      const source = fs.readFileSync(
        path.join(moduleRoot, "flash-sale-campaign", String(entry)),
        "utf8"
      )
      expect(source).not.toContain("flash-sale-allocation")
    }
    for (const entry of allocationFiles) {
      const source = fs.readFileSync(
        path.join(moduleRoot, "flash-sale-allocation", String(entry)),
        "utf8"
      )
      expect(source).not.toContain("flash-sale-campaign")
    }
  })
})
