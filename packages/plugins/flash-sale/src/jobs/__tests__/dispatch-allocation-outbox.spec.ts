import { MEDUSA_SKIP_FILE } from "@medusajs/framework/utils"

describe("Allocation outbox job registration", () => {
  const original = process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED

  afterEach(() => {
    jest.resetModules()
    if (original === undefined) {
      delete process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED
    } else {
      process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED = original
    }
  })

  it("is not autoloaded in the default disabled deployment", () => {
    delete process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED
    jest.isolateModules(() => {
      const job = require("../dispatch-allocation-outbox")
      expect(job[MEDUSA_SKIP_FILE]).toBe(true)
    })
  })

  it("is discoverable only after explicit dispatcher enablement", () => {
    process.env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED = "true"
    jest.isolateModules(() => {
      const job = require("../dispatch-allocation-outbox")
      expect(job[MEDUSA_SKIP_FILE]).toBe(false)
      expect(job.config.name).toBe("flash-sale-dispatch-outboxes")
    })
  })
})
