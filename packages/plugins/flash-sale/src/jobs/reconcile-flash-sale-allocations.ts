import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  DEFAULT_RECONCILIATION_SAMPLE_LIMIT,
  MAX_RECONCILIATION_SAMPLE_LIMIT,
  ReconcileAllocationResult,
} from "../modules/flash-sale-allocation/application"
import FlashSaleAllocationModuleService from "../modules/flash-sale-allocation/service"
import { FlashSalePluginModule } from "../types"

const SAMPLE_LIMIT_ENV = "FLASH_SALE_RECONCILIATION_SAMPLE_LIMIT"
const CAMPAIGN_ID_ENV = "FLASH_SALE_RECONCILIATION_CAMPAIGN_ID"

export function parseReconciliationSampleLimit(value: string | undefined) {
  if (value === undefined || value === "") {
    return DEFAULT_RECONCILIATION_SAMPLE_LIMIT
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      `${SAMPLE_LIMIT_ENV} must be a positive integer`
    )
  }
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_RECONCILIATION_SAMPLE_LIMIT
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      `${SAMPLE_LIMIT_ENV} must be at most ${MAX_RECONCILIATION_SAMPLE_LIMIT}`
    )
  }
  return parsed
}

export function parseReconciliationCampaignId(value: string | undefined) {
  if (value === undefined || value === "") {
    return undefined
  }
  if (!value.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      `${CAMPAIGN_ID_ENV} must be a non-blank string`
    )
  }
  return value
}

export async function inspectFlashSaleAllocations(
  container: MedusaContainer,
  command: { campaign_id?: string; sample_limit?: number } = {}
): Promise<ReconcileAllocationResult> {
  const allocation = container.resolve<FlashSaleAllocationModuleService>(
    FlashSalePluginModule.ALLOCATION
  )
  return await allocation.reconcileAllocation(command)
}

export default async function reconcileFlashSaleAllocationsJob(
  container: MedusaContainer
): Promise<ReconcileAllocationResult> {
  const result = await inspectFlashSaleAllocations(container, {
    campaign_id: parseReconciliationCampaignId(process.env[CAMPAIGN_ID_ENV]),
    sample_limit: parseReconciliationSampleLimit(process.env[SAMPLE_LIMIT_ENV]),
  })
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  if (result.skipped) {
    logger.warn(
      JSON.stringify({
        event: "flash_sale_allocation_reconciliation_skipped",
        campaign_scope: process.env[CAMPAIGN_ID_ENV] ? "configured" : "all",
        snapshot_at: result.snapshot_at.toISOString(),
        reason: result.skip_reason,
      })
    )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Flash sale allocation reconciliation was skipped because the same scope is already running"
    )
  }
  if (result.healthy) {
    return result
  }

  logger.warn(
    JSON.stringify({
      event: "flash_sale_allocation_reconciliation_unhealthy",
      campaign_scope: process.env[CAMPAIGN_ID_ENV] ? "configured" : "all",
      snapshot_at: result.snapshot_at.toISOString(),
      issue_count: result.issue_count,
      counts: result.counts,
    })
  )
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `Flash sale allocation reconciliation found ${result.issue_count} invariant issue(s)`
  )
}

export const config = {
  name: "flash-sale-reconcile-allocations",
  schedule: "0 */5 * * * *",
}

export { CAMPAIGN_ID_ENV, SAMPLE_LIMIT_ENV }
