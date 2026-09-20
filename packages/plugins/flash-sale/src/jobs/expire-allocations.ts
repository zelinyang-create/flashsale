import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import {
  ExpireDueQuotaResult,
  MAX_EXPIRY_BATCH_SIZE,
} from "../modules/flash-sale-allocation/application"
import FlashSaleAllocationModuleService from "../modules/flash-sale-allocation/service"
import { FlashSalePluginModule } from "../types"

const DEFAULT_EXPIRY_BATCH_SIZE = 100

export function parseExpiryBatchSize(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_EXPIRY_BATCH_SIZE
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "FLASH_SALE_EXPIRY_BATCH_SIZE must be a positive integer"
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_EXPIRY_BATCH_SIZE) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      `FLASH_SALE_EXPIRY_BATCH_SIZE must be at most ${MAX_EXPIRY_BATCH_SIZE}`
    )
  }
  return parsed
}

export default async function expireAllocationsJob(
  container: MedusaContainer
): Promise<ExpireDueQuotaResult> {
  const allocation = container.resolve<FlashSaleAllocationModuleService>(
    FlashSalePluginModule.ALLOCATION
  )
  return await allocation.expireDueQuota({
    limit: parseExpiryBatchSize(process.env.FLASH_SALE_EXPIRY_BATCH_SIZE),
  })
}

export const config = {
  name: "flash-sale-expire-allocations",
  schedule: "*/15 * * * * *",
}

export { DEFAULT_EXPIRY_BATCH_SIZE }
