export enum CampaignState {
  DRAFT = "draft",
  SCHEDULED = "scheduled",
  ACTIVE = "active",
  ENDED = "ended",
  CANCELLED = "cancelled",
}

export type FlashSaleMetadata = Record<string, unknown>

export type FlashSaleCampaignDTO = {
  id: string
  name: string
  description: string | null
  state: CampaignState
  starts_at: Date | null
  ends_at: Date | null
  version: number
  rules_version: number
  campaign_epoch: number
  hold_ttl_seconds: number
  per_subject_limit: number
  metadata: FlashSaleMetadata | null
}

export type FlashSaleCampaignItemDTO = {
  id: string
  campaign_id: string
  variant_id: string
  location_id: string | null
  quota: number
  version: number
  metadata: FlashSaleMetadata | null
}

export type CreateFlashSaleCampaignInput = {
  name: string
  description?: string | null
  starts_at?: Date | null
  ends_at?: Date | null
  hold_ttl_seconds?: number
  per_subject_limit?: number
  metadata?: FlashSaleMetadata | null
}

export type UpdateFlashSaleCampaignInput = {
  id: string
  name?: string
  description?: string | null
  starts_at?: Date | null
  ends_at?: Date | null
  hold_ttl_seconds?: number
  per_subject_limit?: number
  metadata?: FlashSaleMetadata | null
}

export type CreateFlashSaleCampaignItemInput = {
  campaign_id: string
  variant_id: string
  location_id?: string | null
  quota: number
  metadata?: FlashSaleMetadata | null
}

export type UpdateFlashSaleCampaignItemInput = {
  id: string
  metadata?: FlashSaleMetadata | null
}

export type UpdateCampaignItemQuotaInput = {
  id: string
  quota: number
}

export type CampaignItemSnapshotInput = Readonly<{
  campaign_item_id: string
  quota: number
  version: number
}>

/**
 * Compare-and-set command used when a lifecycle transition is coupled to an
 * allocation snapshot. The item list is the complete live item set, not a
 * partial filter.
 */
export type TransitionCampaignStateFromSnapshotCommand = Readonly<{
  campaign_id: string
  target_state: CampaignState
  expected_version: number
  expected_rules_version: number
  expected_items: readonly CampaignItemSnapshotInput[]
}>

/** Compare-and-set command for transitions that do not provision a snapshot. */
export type TransitionCampaignStateWithVersionCommand = Readonly<{
  campaign_id: string
  target_state: CampaignState
  expected_version: number
  expected_rules_version: number
}>
