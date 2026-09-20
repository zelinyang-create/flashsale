import { MedusaError } from "@medusajs/framework/utils"
import middlewares from "../middlewares"
import { validateFlashSaleCheckoutParams } from "../store/flash-sales/middlewares"

describe("flash-sale Store route middleware registration", () => {
  it("registers mandatory customer auth, path validation, and exact-body validation", () => {
    const route = (middlewares.routes ?? []).find(
      (entry) => entry.matcher === "/store/flash-sales/:campaign_id/checkout"
    )

    expect(route).toMatchObject({ methods: ["POST"] })
    expect(route?.middlewares).toHaveLength(3)
  })

  it("accepts only bounded campaign path identifiers", () => {
    const next = jest.fn()
    validateFlashSaleCheckoutParams(
      { params: { campaign_id: "campaign_valid-1" } } as never,
      {} as never,
      next
    )
    expect(next).toHaveBeenCalledTimes(1)

    for (const campaign_id of ["", "bad campaign!", "x".repeat(256)]) {
      expect(() =>
        validateFlashSaleCheckoutParams(
          { params: { campaign_id } } as never,
          {} as never,
          jest.fn()
        )
      ).toThrow(
        expect.objectContaining({ type: MedusaError.Types.INVALID_DATA })
      )
    }
  })
})
