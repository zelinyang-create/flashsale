import { asValue, createContainer } from "@medusajs/framework/awilix"
import type { MedusaContainer } from "@medusajs/framework/types"
import expireAllocationsJob, {
  config,
  DEFAULT_EXPIRY_BATCH_SIZE,
  parseExpiryBatchSize,
} from "../expire-allocations"
import { FlashSalePluginModule } from "../../types"

describe("expire allocations job", () => {
  afterEach(() => {
    delete process.env.FLASH_SALE_EXPIRY_BATCH_SIZE
  })

  it("exports a loader-compatible schedule and resolves the module by token", async () => {
    const expireDueQuota = jest.fn().mockResolvedValue({
      scanned: 0,
      expired: 0,
      conflicted: 0,
      failed: 0,
      failures: [],
      attempt_ids: [],
    })
    const container = createContainer()
    container.register({
      [FlashSalePluginModule.ALLOCATION]: asValue({ expireDueQuota }),
    })
    process.env.FLASH_SALE_EXPIRY_BATCH_SIZE = "37"

    await expect(
      expireAllocationsJob(container as unknown as MedusaContainer)
    ).resolves.toMatchObject({
      scanned: 0,
    })
    expect(expireDueQuota).toHaveBeenCalledWith({ limit: 37 })
    expect(config).toEqual({
      name: "flash-sale-expire-allocations",
      schedule: "*/15 * * * * *",
    })
  })

  it("strictly parses a bounded environment batch", () => {
    expect(parseExpiryBatchSize(undefined)).toBe(DEFAULT_EXPIRY_BATCH_SIZE)
    expect(parseExpiryBatchSize("")).toBe(DEFAULT_EXPIRY_BATCH_SIZE)
    expect(parseExpiryBatchSize("1000")).toBe(1000)
    for (const value of ["0", "-1", "+1", "1.0", " 1", "1001", "x"]) {
      expect(() => parseExpiryBatchSize(value)).toThrow()
    }
  })
})
