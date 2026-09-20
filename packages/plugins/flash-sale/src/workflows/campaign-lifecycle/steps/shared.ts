import { MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

import { createAllocationConfigurationHash } from "../../../modules/flash-sale-allocation"
import {
  AllocationPolicyDTO,
  CampaignState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  FlashSalePluginModule,
} from "../../../types"
import {
  AllocationLifecycleModuleService,
  AllocationPolicyReference,
  CampaignAllocationSnapshot,
  CampaignLifecycleModuleService,
  CampaignLifecycleWorkflowInput,
  SerializableCampaign,
} from "../contracts"

const INPUT_FIELDS = new Set(["campaign_id"])

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

function assertExactPlainRecord(
  value: unknown,
  fields: ReadonlySet<string>
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Campaign lifecycle input must be a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("Campaign lifecycle input must be a plain object")
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== fields.size ||
    keys.some((key) => {
      if (typeof key !== "string" || !fields.has(key)) {
        return true
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })
  ) {
    invalid("Campaign lifecycle input must contain exactly campaign_id")
  }
}

function iso(value: Date | string | null, field: string): string {
  if (value === null) {
    invalid(`${field} is required`)
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    invalid(`${field} must be a valid instant`)
  }
  return date.toISOString()
}

function mapCampaign(campaign: FlashSaleCampaignDTO): SerializableCampaign {
  return {
    id: campaign.id,
    state: campaign.state,
    starts_at: iso(campaign.starts_at, "starts_at"),
    ends_at: iso(campaign.ends_at, "ends_at"),
    version: campaign.version,
    rules_version: campaign.rules_version,
    hold_ttl_seconds: campaign.hold_ttl_seconds,
    per_subject_limit: campaign.per_subject_limit,
  }
}

function mapItems(items: FlashSaleCampaignItemDTO[]) {
  return items
    .map((item) => ({
      campaign_item_id: item.id,
      quota: item.quota,
      version: item.version,
    }))
    .sort((left, right) =>
      left.campaign_item_id.localeCompare(right.campaign_item_id)
    )
}

function stableSnapshotKey(
  campaign: FlashSaleCampaignDTO,
  items: FlashSaleCampaignItemDTO[]
): string {
  return JSON.stringify({ campaign: mapCampaign(campaign), items: mapItems(items) })
}

async function readStableSnapshot(
  service: CampaignLifecycleModuleService,
  campaignId: string
): Promise<CampaignAllocationSnapshot> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const firstCampaign = await service.retrieveCampaign(campaignId)
    const firstItems = await service.listCampaignItems(
      { campaign_id: campaignId },
      { order: { id: "ASC" } }
    )
    const secondCampaign = await service.retrieveCampaign(campaignId)
    const secondItems = await service.listCampaignItems(
      { campaign_id: campaignId },
      { order: { id: "ASC" } }
    )
    if (
      stableSnapshotKey(firstCampaign, firstItems) !==
      stableSnapshotKey(secondCampaign, secondItems)
    ) {
      continue
    }
    if (secondItems.length === 0) {
      invalid(`Campaign ${campaignId} must contain at least one item`)
    }
    const campaign = mapCampaign(secondCampaign)
    const items = mapItems(secondItems)
    const hash = createAllocationConfigurationHash({
      campaign_id: campaign.id,
      rules_version: campaign.rules_version,
      starts_at: campaign.starts_at,
      ends_at: campaign.ends_at,
      hold_ttl_seconds: campaign.hold_ttl_seconds,
      per_subject_limit: campaign.per_subject_limit,
      items,
    })
    return { ...campaign, configuration_hash: hash, items }
  }
  invalid(`Campaign ${campaignId} changed while its allocation snapshot was read`)
}

function assertState(
  campaign: Pick<SerializableCampaign, "id" | "state">,
  allowed: readonly CampaignState[],
  operation: string
): void {
  if (!allowed.includes(campaign.state)) {
    invalid(
      `Campaign ${campaign.id} cannot ${operation} from ${campaign.state}`
    )
  }
}

function policyReference(policy: AllocationPolicyDTO): AllocationPolicyReference
function policyReference(
  policy: {
    id: string
    campaign_id: string
    state: AllocationPolicyDTO["state"]
    rules_version: number
    configuration_hash: string
    version: number
  }
): AllocationPolicyReference
function policyReference(
  policy: {
    id: string
    campaign_id: string
    state: AllocationPolicyDTO["state"]
    rules_version: number
    configuration_hash: string
    version: number
  }
): AllocationPolicyReference {
  return {
    id: policy.id,
    campaign_id: policy.campaign_id,
    state: policy.state,
    rules_version: policy.rules_version,
    configuration_hash: policy.configuration_hash,
    version: policy.version,
  }
}

export const validateCampaignLifecycleInputStep = createStep(
  "validate-campaign-lifecycle-input",
  async (input: CampaignLifecycleWorkflowInput) => {
    assertExactPlainRecord(input, INPUT_FIELDS)
    if (typeof input.campaign_id !== "string" || !input.campaign_id.trim()) {
      invalid("campaign_id must be a non-empty string")
    }
    return new StepResponse({ campaign_id: input.campaign_id })
  }
)

export const readScheduleCampaignSnapshotStep = createStep(
  "read-schedule-campaign-snapshot",
  async (input: CampaignLifecycleWorkflowInput, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    const snapshot = await readStableSnapshot(service, input.campaign_id)
    assertState(
      snapshot,
      [CampaignState.DRAFT, CampaignState.SCHEDULED],
      "schedule"
    )
    return new StepResponse(snapshot)
  }
)

export const readActivateCampaignSnapshotStep = createStep(
  "read-activate-campaign-snapshot",
  async (input: CampaignLifecycleWorkflowInput, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    const snapshot = await readStableSnapshot(service, input.campaign_id)
    assertState(
      snapshot,
      [CampaignState.SCHEDULED, CampaignState.ACTIVE],
      "activate"
    )
    return new StepResponse(snapshot)
  }
)

export const readCancelableCampaignStep = createStep(
  "read-cancelable-campaign",
  async (input: CampaignLifecycleWorkflowInput, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    const campaign = mapCampaign(await service.retrieveCampaign(input.campaign_id))
    assertState(
      campaign,
      [
        CampaignState.DRAFT,
        CampaignState.SCHEDULED,
        CampaignState.ACTIVE,
        CampaignState.CANCELLED,
      ],
      "cancel"
    )
    return new StepResponse(campaign)
  }
)

export const readEndableCampaignStep = createStep(
  "read-endable-campaign",
  async (input: CampaignLifecycleWorkflowInput, { container }) => {
    const service = container.resolve<CampaignLifecycleModuleService>(
      FlashSalePluginModule.CAMPAIGN
    )
    const campaign = mapCampaign(await service.retrieveCampaign(input.campaign_id))
    assertState(
      campaign,
      [CampaignState.ACTIVE, CampaignState.ENDED],
      "end"
    )
    return new StepResponse(campaign)
  }
)

export { mapCampaign, policyReference, readStableSnapshot }
