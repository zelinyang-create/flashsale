import {
  assertPositiveInteger,
  assertPositiveQuota,
  assertValidCampaignWindow,
  InvalidCampaignDataError,
} from "../campaign-validation"

describe("campaign validation", () => {
  describe("time window", () => {
    it("accepts a valid time window", () => {
      expect(() =>
        assertValidCampaignWindow(
          "2026-11-27T15:00:00.000Z",
          "2026-11-27T16:00:00.000Z"
        )
      ).not.toThrow()
    })

    it("rejects a reversed or empty time window", () => {
      expect(() =>
        assertValidCampaignWindow(
          "2026-11-27T16:00:00.000Z",
          "2026-11-27T15:00:00.000Z"
        )
      ).toThrow(InvalidCampaignDataError)
      expect(() =>
        assertValidCampaignWindow("2026-11-27T15:00:00.000Z", null)
      ).toThrow("starts_at and ends_at must be provided together")
    })

    it("rejects invalid dates", () => {
      expect(() =>
        assertValidCampaignWindow("not-a-date", "2026-11-27T16:00:00.000Z")
      ).toThrow("starts_at must be a valid date")
    })

    it("requires both dates when scheduling", () => {
      expect(() =>
        assertValidCampaignWindow(null, null, { required: true })
      ).toThrow("required before scheduling")
    })
  })

  describe("positive integers", () => {
    it.each([1, 30, Number.MAX_SAFE_INTEGER])(
      "accepts positive safe integer %s",
      (value) => {
        expect(() => assertPositiveInteger("version", value)).not.toThrow()
      }
    )

    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, "1", undefined])(
      "rejects invalid TTL, limit, or version value %s",
      (value) => {
        expect(() => assertPositiveInteger("hold_ttl_seconds", value)).toThrow(
          InvalidCampaignDataError
        )
      }
    )
  })

  describe("quota", () => {
    it.each([1, 10, Number.MAX_SAFE_INTEGER])(
      "accepts positive integral quota %s",
      (value) => {
        expect(() => assertPositiveQuota(value)).not.toThrow()
      }
    )

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 0n, "1", undefined])(
      "rejects invalid quota %s",
      (value) => {
        expect(() => assertPositiveQuota(value)).toThrow(
          InvalidCampaignDataError
        )
      }
    )
  })
})
