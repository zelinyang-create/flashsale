import { asValue, createContainer } from "@medusajs/framework/awilix"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { FlashSalePluginModule } from "../../types"
import reconcileFlashSaleAllocationsJob, {
  CAMPAIGN_ID_ENV,
  config,
  inspectFlashSaleAllocations,
  parseReconciliationCampaignId,
  parseReconciliationSampleLimit,
  SAMPLE_LIMIT_ENV,
} from "../reconcile-flash-sale-allocations"

describe("flash sale allocation reconciliation job", () => {
  afterEach(() => {
    delete process.env[CAMPAIGN_ID_ENV]
    delete process.env[SAMPLE_LIMIT_ENV]
  })

  const makeContainer = (result: Record<string, unknown>) => {
    const reconcileAllocation = jest.fn().mockResolvedValue(result)
    const logger = { warn: jest.fn() }
    const container = createContainer()
    container.register({
      [FlashSalePluginModule.ALLOCATION]: asValue({ reconcileAllocation }),
      [ContainerRegistrationKeys.LOGGER]: asValue(logger),
    })
    return {
      container: container as unknown as MedusaContainer,
      reconcileAllocation,
      logger,
    }
  }

  it("supports a callable dry-run and a healthy scheduled run", async () => {
    const result = {
      snapshot_at: new Date("2030-01-01T00:00:00.000Z"),
      healthy: true,
      skipped: false,
      skip_reason: null,
      issue_count: 0,
      counts: {},
      samples: [],
    }
    const { container, reconcileAllocation, logger } = makeContainer(result)
    process.env[CAMPAIGN_ID_ENV] = "campaign-1"
    process.env[SAMPLE_LIMIT_ENV] = "7"

    await expect(reconcileFlashSaleAllocationsJob(container)).resolves.toEqual(
      result
    )
    expect(reconcileAllocation).toHaveBeenCalledWith({
      campaign_id: "campaign-1",
      sample_limit: 7,
    })
    await expect(
      inspectFlashSaleAllocations(container, { sample_limit: 1 })
    ).resolves.toEqual(result)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(config.name).toBe("flash-sale-reconcile-allocations")
  })

  it("logs only aggregate diagnostics and fails an unhealthy job", async () => {
    const sensitive = {
      idempotency: "a".repeat(64),
      subject: "customer@example.com",
      cart: "secret-cart",
    }
    const { container, logger } = makeContainer({
      snapshot_at: new Date("2030-01-01T00:00:00.000Z"),
      healthy: false,
      skipped: false,
      skip_reason: null,
      issue_count: 2,
      counts: { CAPACITY_HELD_MISMATCH: 2 },
      samples: [
        {
          code: "CAPACITY_HELD_MISMATCH",
          entity_type: "capacity",
          entity_id: Object.values(sensitive).join("-"),
        },
      ],
    })

    await expect(reconcileFlashSaleAllocationsJob(container)).rejects.toThrow(
      "found 2 invariant issue(s)"
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const logged = logger.warn.mock.calls[0][0]
    expect(logged).toContain("CAPACITY_HELD_MISMATCH")
    for (const value of Object.values(sensitive)) {
      expect(logged).not.toContain(value)
    }
  })

  it("reports a same-scope skip distinctly from invariant drift", async () => {
    const { container, logger } = makeContainer({
      snapshot_at: new Date("2030-01-01T00:00:00.000Z"),
      healthy: false,
      skipped: true,
      skip_reason: "ALREADY_RUNNING",
      issue_count: 0,
      counts: {},
      samples: [],
    })

    await expect(reconcileFlashSaleAllocationsJob(container)).rejects.toThrow(
      "same scope is already running"
    )
    const logged = logger.warn.mock.calls[0][0]
    expect(logged).toContain("reconciliation_skipped")
    expect(logged).toContain("ALREADY_RUNNING")
    expect(logged).not.toContain("reconciliation_unhealthy")
  })

  it("propagates store errors without converting them to healthy", async () => {
    const container = createContainer()
    const failure = new Error("database unavailable")
    container.register({
      [FlashSalePluginModule.ALLOCATION]: asValue({
        reconcileAllocation: jest.fn().mockRejectedValue(failure),
      }),
    })
    await expect(
      reconcileFlashSaleAllocationsJob(container as unknown as MedusaContainer)
    ).rejects.toBe(failure)
  })

  it("strictly parses its bounded environment configuration", () => {
    expect(parseReconciliationSampleLimit(undefined)).toBe(20)
    expect(parseReconciliationSampleLimit("")).toBe(20)
    expect(parseReconciliationSampleLimit("100")).toBe(100)
    for (const value of ["0", "-1", "+1", "1.0", " 1", "101", "x"]) {
      expect(() => parseReconciliationSampleLimit(value)).toThrow()
    }
    expect(parseReconciliationCampaignId(undefined)).toBeUndefined()
    expect(parseReconciliationCampaignId("")).toBeUndefined()
    expect(parseReconciliationCampaignId("campaign-1")).toBe("campaign-1")
    expect(() => parseReconciliationCampaignId("   ")).toThrow()
  })
})
