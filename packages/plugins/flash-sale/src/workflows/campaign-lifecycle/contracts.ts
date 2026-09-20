import {
  AllocationCampaignFenceResult,
  AllocationControlResult,
  FenceAndCloseCampaignAllocationCommand,
  ClaimAndHoldQuotaCommand,
  HoldQuotaResult,
  ProvisionAllocationCommand,
  TransitionAllocationCommand,
} from "../../modules/flash-sale-allocation"
import {
  AllocationPolicyDTO,
  AllocationPolicyState,
  AllocationCampaignFenceDTO,
  CampaignState,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  TransitionCampaignStateFromSnapshotCommand,
  TransitionCampaignStateWithVersionCommand,
} from "../../types"

export type CampaignLifecycleWorkflowInput = Readonly<{
  campaign_id: string
}>

export type SerializableCampaign = Readonly<{
  id: string
  state: CampaignState
  starts_at: string
  ends_at: string
  version: number
  rules_version: number
  hold_ttl_seconds: number
  per_subject_limit: number
}>

export type CampaignAllocationSnapshot = SerializableCampaign &
  Readonly<{
    configuration_hash: string
    items: readonly Readonly<{
      campaign_item_id: string
      quota: number
      version: number
    }>[]
  }>

export type AllocationPolicyReference = Readonly<{
  id: string
  campaign_id: string
  state: AllocationPolicyState
  rules_version: number
  configuration_hash: string
  version: number
}>

export type AllocationCampaignFenceReference = Readonly<{
  id: string
  campaign_id: string
  disposition: AllocationCampaignFenceDTO["disposition"]
  campaign_version: number
  rules_version: number
  version: number
}>

export type TerminalAllocationResult = Readonly<{
  fence: AllocationCampaignFenceReference
  allocation_policy: AllocationPolicyReference | null
}>

export type LifecycleResult = Readonly<{
  campaign: SerializableCampaign
  allocation_policy: AllocationPolicyReference | null
  allocation_fence: AllocationCampaignFenceReference | null
}>

/**
 * The workflow layer depends only on public module capabilities. Keeping these
 * contracts here prevents either business module from importing the other.
 */
export interface CampaignLifecycleModuleService {
  retrieveCampaign(id: string): Promise<FlashSaleCampaignDTO>
  listCampaignItems(
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<FlashSaleCampaignItemDTO[]>
  transitionCampaignStateFromSnapshot(
    command: TransitionCampaignStateFromSnapshotCommand
  ): Promise<FlashSaleCampaignDTO>
  transitionCampaignStateWithVersion(
    command: TransitionCampaignStateWithVersionCommand
  ): Promise<FlashSaleCampaignDTO>
}

export interface AllocationLifecycleModuleService {
  provisionAllocation(
    command: ProvisionAllocationCommand
  ): Promise<AllocationControlResult>
  openAllocation(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult>
  closeAllocation(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult>
  fenceAndCloseCampaignAllocation(
    command: FenceAndCloseCampaignAllocationCommand
  ): Promise<AllocationCampaignFenceResult>
  listAllocationPolicies(
    filters?: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<AllocationPolicyDTO[]>
  claimAndHoldQuota(
    command: ClaimAndHoldQuotaCommand
  ): Promise<HoldQuotaResult>
}
