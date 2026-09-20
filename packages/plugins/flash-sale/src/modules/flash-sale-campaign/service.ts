import { Context } from "@medusajs/framework/types"
import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from "@medusajs/framework/utils"
import {
  CampaignState,
  CreateFlashSaleCampaignInput,
  CreateFlashSaleCampaignItemInput,
  FlashSaleCampaignDTO,
  FlashSaleCampaignItemDTO,
  TransitionCampaignStateFromSnapshotCommand,
  TransitionCampaignStateWithVersionCommand,
  UpdateCampaignItemQuotaInput,
  UpdateFlashSaleCampaignInput,
  UpdateFlashSaleCampaignItemInput,
} from "../../types"
import {
  assertCampaignStateTransition,
  assertPositiveInteger,
  assertPositiveQuota,
  assertSnapshotTransitionCommand,
  assertValidCampaignWindow,
  assertVersionedTransitionCommand,
  InvalidCampaignDataError,
  InvalidCampaignStateTransitionError,
} from "./domain"
import Campaign from "./models/campaign"
import CampaignItem from "./models/campaign-item"

type CampaignRow = {
  id: string
  state: CampaignState
  starts_at: Date | null
  ends_at: Date | null
  version: number
  rules_version: number
}

type CampaignItemRow = {
  id: string
  campaign_id: string
  quota: number | string
  version: number
}

const CAMPAIGN_CREATE_FIELDS = [
  "name",
  "description",
  "starts_at",
  "ends_at",
  "hold_ttl_seconds",
  "per_subject_limit",
  "metadata",
  "state",
  "version",
  "rules_version",
  "campaign_epoch",
] as const
const CAMPAIGN_UPDATE_FIELDS = [
  "id",
  "name",
  "description",
  "starts_at",
  "ends_at",
  "hold_ttl_seconds",
  "per_subject_limit",
  "metadata",
] as const
const CAMPAIGN_ITEM_CREATE_FIELDS = [
  "campaign_id",
  "variant_id",
  "location_id",
  "quota",
  "metadata",
  "version",
] as const
const CAMPAIGN_ITEM_UPDATE_FIELDS = ["id", "metadata"] as const
const QUOTA_COMMAND_FIELDS = ["id", "quota"] as const

function hasOwn(data: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(data, field)
}

function assertOnlyFields(
  data: object,
  allowed: readonly string[],
  operation: string
): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      throw new InvalidCampaignDataError(
        `${key} cannot be changed through ${operation}`
      )
    }
  }
}

function conflict(message: string): never {
  throw new MedusaError(MedusaError.Types.CONFLICT, message)
}

function assertNonBlankString(
  field: string,
  value: unknown
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCampaignDataError(`${field} is required`)
  }
}

function normalizeIds(ids: string | string[]): string[] {
  const normalized = [...(Array.isArray(ids) ? ids : [ids])].sort()
  if (normalized.length === 0) {
    throw new InvalidCampaignDataError("At least one id is required")
  }
  normalized.forEach((id) => assertNonBlankString("id", id))
  return [...new Set(normalized)]
}

function asCampaignDTO(value: unknown): FlashSaleCampaignDTO {
  return value as FlashSaleCampaignDTO
}

function asCampaignDTOs(value: unknown): FlashSaleCampaignDTO[] {
  return value as FlashSaleCampaignDTO[]
}

function asCampaignItemDTO(value: unknown): FlashSaleCampaignItemDTO {
  return value as FlashSaleCampaignItemDTO
}

function asCampaignItemDTOs(value: unknown): FlashSaleCampaignItemDTO[] {
  return value as FlashSaleCampaignItemDTO[]
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

function isMappedCampaignItemUniqueViolation(error: unknown): boolean {
  return (
    error instanceof MedusaError &&
    error.type === MedusaError.Types.INVALID_DATA &&
    error.message.startsWith("Flash sale campaign item with campaign_id:") &&
    error.message.includes("variant_id:") &&
    error.message.endsWith("already exists.")
  )
}

function rethrowAsMedusaError(error: unknown): never {
  if (
    isUniqueConstraintViolation(error) ||
    isMappedCampaignItemUniqueViolation(error)
  ) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      "A flash-sale campaign item already exists for this campaign, variant, and location"
    )
  }
  if (
    error instanceof InvalidCampaignDataError ||
    error instanceof InvalidCampaignStateTransitionError
  ) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, error.message)
  }
  throw error
}

function validateCampaignValues(
  data: {
    starts_at?: Date | string | null
    ends_at?: Date | string | null
    hold_ttl_seconds?: number
    per_subject_limit?: number
  },
  current?: Pick<CampaignRow, "starts_at" | "ends_at">
): void {
  const startsAt = hasOwn(data, "starts_at")
    ? data.starts_at
    : current?.starts_at
  const endsAt = hasOwn(data, "ends_at") ? data.ends_at : current?.ends_at
  assertValidCampaignWindow(startsAt, endsAt)
  for (const field of ["hold_ttl_seconds", "per_subject_limit"] as const) {
    if (data[field] !== undefined) {
      assertPositiveInteger(field, data[field])
    }
  }
}

class FlashSaleCampaignModuleService extends MedusaService({
  Campaign,
  CampaignItem,
}) {
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaigns(
    data: CreateFlashSaleCampaignInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO>
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaigns(
    data: CreateFlashSaleCampaignInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO[]>
  @InjectManager()
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaigns(
    data: CreateFlashSaleCampaignInput | CreateFlashSaleCampaignInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO | FlashSaleCampaignDTO[]> {
    try {
      if (Array.isArray(data)) {
        return await this.createCampaigns_(data, sharedContext)
      }
      return await this.createCampaigns_(data, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  protected async createCampaigns_(
    data: CreateFlashSaleCampaignInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO>
  protected async createCampaigns_(
    data: CreateFlashSaleCampaignInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO[]>
  @InjectTransactionManager()
  protected async createCampaigns_(
    data: CreateFlashSaleCampaignInput | CreateFlashSaleCampaignInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO | FlashSaleCampaignDTO[]> {
    const isArray = Array.isArray(data)
    const input = isArray ? data : [data]
    const normalized = input.map((campaign) => {
      const runtimeInput = campaign as object & {
        state?: CampaignState
        version?: number
        rules_version?: number
        campaign_epoch?: number
      }
      assertOnlyFields(runtimeInput, CAMPAIGN_CREATE_FIELDS, "createCampaigns")
      assertNonBlankString("name", campaign.name)
      if (
        runtimeInput.state !== undefined &&
        runtimeInput.state !== CampaignState.DRAFT
      ) {
        throw new InvalidCampaignDataError(
          "Campaigns must be created in the draft state"
        )
      }
      for (const field of [
        "version",
        "rules_version",
        "campaign_epoch",
      ] as const) {
        if (runtimeInput[field] !== undefined && runtimeInput[field] !== 1) {
          throw new InvalidCampaignDataError(
            `Campaigns must be created with ${field} 1`
          )
        }
      }
      validateCampaignValues(campaign)
      return {
        name: campaign.name,
        description: campaign.description,
        starts_at: campaign.starts_at,
        ends_at: campaign.ends_at,
        hold_ttl_seconds: campaign.hold_ttl_seconds,
        per_subject_limit: campaign.per_subject_limit,
        metadata: campaign.metadata,
        state: CampaignState.DRAFT,
        version: 1,
        rules_version: 1,
        campaign_epoch: 1,
      }
    })
    const created = await super.createCampaigns(normalized, sharedContext)
    return isArray ? asCampaignDTOs(created) : asCampaignDTOs(created)[0]
  }

  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaigns(
    data: UpdateFlashSaleCampaignInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO>
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaigns(
    data: UpdateFlashSaleCampaignInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO[]>
  @InjectManager()
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaigns(
    data: UpdateFlashSaleCampaignInput | UpdateFlashSaleCampaignInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO | FlashSaleCampaignDTO[]> {
    try {
      if (Array.isArray(data)) {
        return await this.updateCampaigns_(data, sharedContext)
      }
      return await this.updateCampaigns_(data, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  protected async updateCampaigns_(
    data: UpdateFlashSaleCampaignInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO>
  protected async updateCampaigns_(
    data: UpdateFlashSaleCampaignInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignDTO[]>
  @InjectTransactionManager()
  protected async updateCampaigns_(
    data: UpdateFlashSaleCampaignInput | UpdateFlashSaleCampaignInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO | FlashSaleCampaignDTO[]> {
    const isArray = Array.isArray(data)
    const input = isArray ? data : [data]

    for (const update of input) {
      assertOnlyFields(update, CAMPAIGN_UPDATE_FIELDS, "updateCampaigns")
      assertNonBlankString("Campaign id", update.id)
      if (update.name !== undefined) {
        assertNonBlankString("name", update.name)
      }
    }

    const campaignIds = normalizeIds(input.map((update) => update.id))
    if (campaignIds.length !== input.length) {
      throw new InvalidCampaignDataError(
        "Campaign updates must contain unique ids"
      )
    }
    await this.lockCampaignsForUpdate_(campaignIds, sharedContext)

    const normalized: Array<
      UpdateFlashSaleCampaignInput & {
        version?: number
        rules_version?: number
      }
    > = []

    for (const update of input) {
      const current = asCampaignDTO(
        await super.retrieveCampaign(
          update.id,
          { options: { refresh: true } },
          sharedContext
        )
      )
      if (current.state !== CampaignState.DRAFT) {
        throw new InvalidCampaignDataError(
          `Campaign ${current.id} must be in draft state`
        )
      }

      validateCampaignValues(update, current)
      const changesRules = Object.keys(update).some(
        (field) => field !== "id" && field !== "metadata"
      )
      if (changesRules) {
        assertPositiveInteger("version", current.version)
        assertPositiveInteger("rules_version", current.rules_version)
        normalized.push({
          ...update,
          version: current.version + 1,
          rules_version: current.rules_version + 1,
        })
      } else {
        // Metadata is deliberately outside the allocation snapshot. Updating it
        // must not invalidate an already provisioned rules version.
        normalized.push(update)
      }
    }

    const updated = await super.updateCampaigns(normalized, sharedContext)
    return isArray ? asCampaignDTOs(updated) : asCampaignDTOs(updated)[0]
  }

  async upsertCampaigns(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "upsertCampaigns is disabled; use createCampaigns or updateCampaigns"
    )
  }

  @InjectManager()
  async transitionCampaignState(
    id: string,
    state: CampaignState,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    try {
      return await this.transitionCampaignState_(id, state, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async transitionCampaignState_(
    id: string,
    state: CampaignState,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    assertNonBlankString("Campaign id", id)
    await this.lockCampaignsForUpdate_([id], sharedContext)
    const campaign = asCampaignDTO(
      await super.retrieveCampaign(
        id,
        { options: { refresh: true } },
        sharedContext
      )
    )
    const currentState = campaign.state
    assertPositiveInteger("version", campaign.version)
    assertCampaignStateTransition(currentState, state)
    if (state === CampaignState.SCHEDULED || state === CampaignState.ACTIVE) {
      assertValidCampaignWindow(campaign.starts_at, campaign.ends_at, {
        required: true,
      })
    }
    if (currentState === state) {
      return campaign
    }
    return asCampaignDTO(
      await super.updateCampaigns(
        { id, state, version: campaign.version + 1 },
        sharedContext
      )
    )
  }

  @InjectManager()
  async transitionCampaignStateFromSnapshot(
    command: TransitionCampaignStateFromSnapshotCommand,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    try {
      return await this.transitionCampaignStateFromSnapshot_(
        command,
        sharedContext
      )
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async transitionCampaignStateFromSnapshot_(
    command: TransitionCampaignStateFromSnapshotCommand,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    assertSnapshotTransitionCommand(command)
    const expectedItems = command.expected_items
    const expectedIds = expectedItems
      .map((item) => item.campaign_item_id)
      .sort()
    if (new Set(expectedIds).size !== expectedIds.length) {
      throw new InvalidCampaignDataError(
        "expected_items must contain unique campaign_item_id values"
      )
    }

    await this.lockCampaignsForUpdate_([command.campaign_id], sharedContext)
    const campaign = asCampaignDTO(
      await super.retrieveCampaign(
        command.campaign_id,
        { options: { refresh: true } },
        sharedContext
      )
    )
    const liveItems = await this.lockLiveCampaignItemsForUpdate_(
      command.campaign_id,
      sharedContext
    )
    this.assertSnapshotItemsMatch_(
      expectedItems,
      liveItems,
      command.campaign_id
    )

    return await this.transitionLockedCampaignWithVersion_(
      campaign,
      command.target_state,
      command.expected_version,
      command.expected_rules_version,
      sharedContext
    )
  }

  @InjectManager()
  async transitionCampaignStateWithVersion(
    command: TransitionCampaignStateWithVersionCommand,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    try {
      return await this.transitionCampaignStateWithVersion_(
        command,
        sharedContext
      )
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async transitionCampaignStateWithVersion_(
    command: TransitionCampaignStateWithVersionCommand,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    assertVersionedTransitionCommand(command)
    await this.lockCampaignsForUpdate_([command.campaign_id], sharedContext)
    const campaign = asCampaignDTO(
      await super.retrieveCampaign(
        command.campaign_id,
        { options: { refresh: true } },
        sharedContext
      )
    )
    return await this.transitionLockedCampaignWithVersion_(
      campaign,
      command.target_state,
      command.expected_version,
      command.expected_rules_version,
      sharedContext
    )
  }

  @InjectManager()
  // @ts-expect-error MedusaService's generated method accepts a wider delete contract.
  async deleteCampaigns(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<never> {
    return await this.deleteCampaigns_(ids, sharedContext)
  }

  @InjectTransactionManager()
  protected async deleteCampaigns_(
    _ids: string | string[],
    @MedusaContext() _sharedContext: Context = {}
  ): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Hard deletion of flash-sale campaigns is disabled"
    )
  }

  @InjectManager()
  // @ts-expect-error MedusaService's generated method accepts a wider soft-delete contract.
  async softDeleteCampaigns(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    try {
      await this.softDeleteCampaigns_(ids, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async softDeleteCampaigns_(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const normalizedIds = normalizeIds(ids)
    await this.lockCampaignsForUpdate_(normalizedIds, sharedContext)
    const campaigns = await Promise.all(
      normalizedIds.map(async (id) =>
        asCampaignDTO(
          await super.retrieveCampaign(
            id,
            { options: { refresh: true } },
            sharedContext
          )
        )
      )
    )
    for (const campaign of campaigns) {
      if (
        ![
          CampaignState.DRAFT,
          CampaignState.CANCELLED,
          CampaignState.ENDED,
        ].includes(campaign.state)
      ) {
        throw new InvalidCampaignDataError(
          `Campaign ${campaign.id} in ${campaign.state} state cannot be deleted`
        )
      }
    }
    await super.softDeleteCampaigns(normalizedIds, undefined, sharedContext)
  }

  @InjectManager()
  // @ts-expect-error Public restoration is deliberately disabled for audited campaign records.
  async restoreCampaigns(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<never> {
    return await this.restoreCampaigns_(ids, sharedContext)
  }

  @InjectTransactionManager()
  protected async restoreCampaigns_(
    _ids: string | string[],
    @MedusaContext() _sharedContext: Context = {}
  ): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Campaign restoration is disabled; create a new campaign instead"
    )
  }

  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaignItems(
    data: CreateFlashSaleCampaignItemInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO>
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaignItems(
    data: CreateFlashSaleCampaignItemInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO[]>
  @InjectManager()
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async createCampaignItems(
    data: CreateFlashSaleCampaignItemInput | CreateFlashSaleCampaignItemInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO | FlashSaleCampaignItemDTO[]> {
    try {
      if (Array.isArray(data)) {
        return await this.createCampaignItems_(data, sharedContext)
      }
      return await this.createCampaignItems_(data, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  protected async createCampaignItems_(
    data: CreateFlashSaleCampaignItemInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO>
  protected async createCampaignItems_(
    data: CreateFlashSaleCampaignItemInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO[]>
  @InjectTransactionManager()
  protected async createCampaignItems_(
    data: CreateFlashSaleCampaignItemInput | CreateFlashSaleCampaignItemInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO | FlashSaleCampaignItemDTO[]> {
    const isArray = Array.isArray(data)
    const input = isArray ? data : [data]
    const campaignIds = input.map((item) => {
      assertOnlyFields(item, CAMPAIGN_ITEM_CREATE_FIELDS, "createCampaignItems")
      assertNonBlankString("campaign_id", item.campaign_id)
      assertNonBlankString("variant_id", item.variant_id)
      if (item.location_id !== undefined && item.location_id !== null) {
        assertNonBlankString("location_id", item.location_id)
      }
      assertPositiveQuota(item.quota)
      const runtimeInput = item as object & { version?: number }
      if (runtimeInput.version !== undefined && runtimeInput.version !== 1) {
        throw new InvalidCampaignDataError(
          "Campaign items must be created with version 1"
        )
      }
      return item.campaign_id
    })
    await this.assertCampaignsAreDraft_(campaignIds, sharedContext)
    const normalized = input.map((item) => ({
      campaign_id: item.campaign_id,
      variant_id: item.variant_id,
      location_id: item.location_id,
      quota: item.quota,
      metadata: item.metadata,
      version: 1,
    }))
    const created = await super.createCampaignItems(normalized, sharedContext)
    await this.bumpCampaignRuleVersions_(campaignIds, sharedContext)
    return isArray
      ? asCampaignItemDTOs(created)
      : asCampaignItemDTOs(created)[0]
  }

  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaignItems(
    data: UpdateFlashSaleCampaignItemInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO>
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaignItems(
    data: UpdateFlashSaleCampaignItemInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO[]>
  @InjectManager()
  // @ts-expect-error The generated Medusa property is intentionally narrowed by this public API.
  async updateCampaignItems(
    data: UpdateFlashSaleCampaignItemInput | UpdateFlashSaleCampaignItemInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO | FlashSaleCampaignItemDTO[]> {
    try {
      if (Array.isArray(data)) {
        return await this.updateCampaignItems_(data, sharedContext)
      }
      return await this.updateCampaignItems_(data, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  protected async updateCampaignItems_(
    data: UpdateFlashSaleCampaignItemInput,
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO>
  protected async updateCampaignItems_(
    data: UpdateFlashSaleCampaignItemInput[],
    sharedContext?: Context
  ): Promise<FlashSaleCampaignItemDTO[]>
  @InjectTransactionManager()
  protected async updateCampaignItems_(
    data: UpdateFlashSaleCampaignItemInput | UpdateFlashSaleCampaignItemInput[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO | FlashSaleCampaignItemDTO[]> {
    const isArray = Array.isArray(data)
    const input = isArray ? data : [data]
    input.forEach((item) => {
      assertOnlyFields(item, CAMPAIGN_ITEM_UPDATE_FIELDS, "updateCampaignItems")
      assertNonBlankString("Campaign item id", item.id)
    })
    const updated = await super.updateCampaignItems(input, sharedContext)
    return isArray
      ? asCampaignItemDTOs(updated)
      : asCampaignItemDTOs(updated)[0]
  }

  @InjectManager()
  async updateCampaignItemQuota(
    data: UpdateCampaignItemQuotaInput,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO> {
    try {
      return await this.updateCampaignItemQuota_(data, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async updateCampaignItemQuota_(
    data: UpdateCampaignItemQuotaInput,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignItemDTO> {
    assertOnlyFields(data, QUOTA_COMMAND_FIELDS, "updateCampaignItemQuota")
    assertNonBlankString("Campaign item id", data.id)
    assertPositiveQuota(data.quota)
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    const itemRows = (await transaction("flash_sale_campaign_item")
      .select(["id", "campaign_id"])
      .where({ id: data.id })
      .whereNull("deleted_at")) as Pick<CampaignItemRow, "id" | "campaign_id">[]
    if (itemRows.length !== 1) {
      throw new InvalidCampaignDataError(
        `Campaign item ${data.id} was not found`
      )
    }
    await this.assertCampaignsAreDraft_(
      [itemRows[0].campaign_id],
      sharedContext
    )
    await this.lockCampaignItemsForUpdate_([data.id], sharedContext)
    const item = asCampaignItemDTO(
      await super.retrieveCampaignItem(
        data.id,
        { options: { refresh: true } },
        sharedContext
      )
    )
    assertPositiveInteger("version", item.version)
    const updated = asCampaignItemDTO(
      await super.updateCampaignItems(
        { id: item.id, quota: data.quota, version: item.version + 1 },
        sharedContext
      )
    )
    await this.bumpCampaignRuleVersions_(
      [itemRows[0].campaign_id],
      sharedContext
    )
    return updated
  }

  async upsertCampaignItems(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "upsertCampaignItems is disabled; use createCampaignItems or updateCampaignItems"
    )
  }

  @InjectManager()
  // @ts-expect-error MedusaService's generated method accepts a wider delete contract.
  async deleteCampaignItems(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<never> {
    return await this.deleteCampaignItems_(ids, sharedContext)
  }

  @InjectTransactionManager()
  protected async deleteCampaignItems_(
    _ids: string | string[],
    @MedusaContext() _sharedContext: Context = {}
  ): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Hard deletion of flash-sale campaign items is disabled"
    )
  }

  @InjectManager()
  // @ts-expect-error MedusaService's generated method accepts a wider soft-delete contract.
  async softDeleteCampaignItems(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    try {
      await this.softDeleteCampaignItems_(ids, sharedContext)
    } catch (error) {
      rethrowAsMedusaError(error)
    }
  }

  @InjectTransactionManager()
  protected async softDeleteCampaignItems_(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const normalizedIds = normalizeIds(ids)
    const campaignIds = await this.getCampaignIdsForItems_(
      normalizedIds,
      sharedContext
    )
    await this.assertCampaignsAreDraft_(campaignIds, sharedContext)
    await this.lockCampaignItemsForUpdate_(normalizedIds, sharedContext)
    await super.softDeleteCampaignItems(normalizedIds, undefined, sharedContext)
    await this.bumpCampaignRuleVersions_(campaignIds, sharedContext)
  }

  @InjectManager()
  // @ts-expect-error Public restoration is deliberately disabled for campaign items.
  async restoreCampaignItems(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<never> {
    return await this.restoreCampaignItems_(ids, sharedContext)
  }

  @InjectTransactionManager()
  protected async restoreCampaignItems_(
    _ids: string | string[],
    @MedusaContext() _sharedContext: Context = {}
  ): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Campaign item restoration is disabled; create a new campaign item instead"
    )
  }

  @InjectTransactionManager()
  protected async assertCampaignsAreDraft_(
    campaignIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const normalizedIds = normalizeIds(campaignIds)
    await this.lockCampaignsForUpdate_(normalizedIds, sharedContext)
    const campaigns = await Promise.all(
      normalizedIds.map(async (id) =>
        asCampaignDTO(
          await super.retrieveCampaign(
            id,
            { options: { refresh: true } },
            sharedContext
          )
        )
      )
    )
    for (const campaign of campaigns) {
      if (campaign.state !== CampaignState.DRAFT) {
        throw new InvalidCampaignDataError(
          `Campaign ${campaign.id} must be in draft state`
        )
      }
    }
  }

  @InjectTransactionManager()
  protected async getCampaignIdsForItems_(
    itemIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<string[]> {
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    const rows = (await transaction("flash_sale_campaign_item")
      .select(["id", "campaign_id"])
      .whereIn("id", itemIds)
      .whereNull("deleted_at")) as Pick<CampaignItemRow, "id" | "campaign_id">[]
    if (rows.length !== itemIds.length) {
      throw new InvalidCampaignDataError(
        "One or more campaign items were not found"
      )
    }
    return rows.map((row) => row.campaign_id)
  }

  @InjectTransactionManager()
  protected async lockCampaignsForUpdate_(
    ids: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    await transaction("flash_sale_campaign")
      .select("id")
      .whereIn("id", [...new Set(ids)].sort())
      .whereNull("deleted_at")
      .orderBy("id")
      .forUpdate()
  }

  @InjectTransactionManager()
  protected async lockCampaignItemsForUpdate_(
    ids: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    await transaction("flash_sale_campaign_item")
      .select("id")
      .whereIn("id", [...new Set(ids)].sort())
      .whereNull("deleted_at")
      .orderBy("id")
      .forUpdate()
  }

  @InjectTransactionManager()
  protected async lockLiveCampaignItemsForUpdate_(
    campaignId: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<CampaignItemRow[]> {
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    return (await transaction("flash_sale_campaign_item")
      .select(["id", "campaign_id", "quota", "version"])
      .where({ campaign_id: campaignId })
      .whereNull("deleted_at")
      .orderBy("id")
      .forUpdate()) as CampaignItemRow[]
  }

  private assertSnapshotItemsMatch_(
    expectedItems: readonly {
      campaign_item_id: string
      quota: number
      version: number
    }[],
    liveItems: CampaignItemRow[],
    campaignId: string
  ): void {
    const expected = [...expectedItems].sort((left, right) =>
      left.campaign_item_id.localeCompare(right.campaign_item_id)
    )
    if (
      expected.length !== liveItems.length ||
      expected.some((item, index) => {
        const live = liveItems[index]
        return (
          item.campaign_item_id !== live.id ||
          item.quota !== Number(live.quota) ||
          item.version !== live.version
        )
      })
    ) {
      conflict(
        `Campaign ${campaignId} items changed after its allocation snapshot was captured`
      )
    }
  }

  @InjectTransactionManager()
  protected async transitionLockedCampaignWithVersion_(
    campaign: FlashSaleCampaignDTO,
    targetState: CampaignState,
    expectedVersion: number,
    expectedRulesVersion: number,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<FlashSaleCampaignDTO> {
    if (campaign.rules_version !== expectedRulesVersion) {
      conflict(
        `Campaign ${campaign.id} rules version changed before transition`
      )
    }

    if (campaign.state === targetState) {
      if (
        campaign.version !== expectedVersion &&
        campaign.version !== expectedVersion + 1
      ) {
        conflict(
          `Campaign ${campaign.id} version changed before transition replay`
        )
      }
      if (
        targetState === CampaignState.SCHEDULED ||
        targetState === CampaignState.ACTIVE
      ) {
        assertValidCampaignWindow(campaign.starts_at, campaign.ends_at, {
          required: true,
        })
      }
      return campaign
    }

    if (campaign.version !== expectedVersion) {
      conflict(`Campaign ${campaign.id} version changed before transition`)
    }
    assertCampaignStateTransition(campaign.state, targetState)
    if (
      targetState === CampaignState.SCHEDULED ||
      targetState === CampaignState.ACTIVE
    ) {
      assertValidCampaignWindow(campaign.starts_at, campaign.ends_at, {
        required: true,
      })
    }

    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    const updated = await transaction("flash_sale_campaign")
      .where({
        id: campaign.id,
        state: campaign.state,
        version: expectedVersion,
        rules_version: expectedRulesVersion,
      })
      .whereNull("deleted_at")
      .update({
        state: targetState,
        version: expectedVersion + 1,
        updated_at: transaction.fn.now(),
      })
      .returning("id")
    if (updated.length !== 1) {
      conflict(`Campaign ${campaign.id} changed during transition`)
    }
    return asCampaignDTO(
      await super.retrieveCampaign(
        campaign.id,
        { options: { refresh: true } },
        sharedContext
      )
    )
  }

  @InjectTransactionManager()
  protected async bumpCampaignRuleVersions_(
    campaignIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const ids = [...new Set(campaignIds)].sort()
    const transaction = this.getTransactionManager(
      sharedContext.transactionManager
    ).getTransactionContext()
    const updated = await transaction("flash_sale_campaign")
      .whereIn("id", ids)
      .whereNull("deleted_at")
      .update({
        version: transaction.raw("version + 1"),
        rules_version: transaction.raw("rules_version + 1"),
        updated_at: transaction.fn.now(),
      })
      .returning("id")
    if (updated.length !== ids.length) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Failed to version every changed flash-sale campaign"
      )
    }
  }

  private getTransactionManager(value: unknown): SqlEntityManager {
    const manager = value as SqlEntityManager | undefined
    if (!manager || !manager.getTransactionContext()) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Flash-sale write commands must run inside a transaction"
      )
    }
    return manager
  }
}

export default FlashSaleCampaignModuleService
