import {
  AllocationDomainErrorCode,
  createCanonicalRequestFingerprint,
  normalizeAllocationItems,
} from ".."

describe("normalizeAllocationItems", () => {
  it("rejects empty item lists", () => {
    expect(() => normalizeAllocationItems([])).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.EMPTY_ALLOCATION_ITEMS,
      })
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects an invalid quantity of %p",
    (quantity) => {
      expect(() =>
        normalizeAllocationItems([{ campaign_item_id: "item-a", quantity }])
      ).toThrow(
        expect.objectContaining({
          code: AllocationDomainErrorCode.INVALID_ALLOCATION_ITEM_QUANTITY,
        })
      )
    }
  )

  it("rejects empty campaign item ids and duplicate items", () => {
    expect(() =>
      normalizeAllocationItems([{ campaign_item_id: "", quantity: 1 }])
    ).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.INVALID_CAMPAIGN_ITEM_ID,
      })
    )

    expect(() =>
      normalizeAllocationItems([
        { campaign_item_id: "item-a", quantity: 1 },
        { campaign_item_id: "item-a", quantity: 2 },
      ])
    ).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.DUPLICATE_CAMPAIGN_ITEM_ID,
      })
    )
  })

  it("sorts by campaign item id without mutating the caller's list", () => {
    const input = [
      { campaign_item_id: "item-z", quantity: 2 },
      { campaign_item_id: "item-a", quantity: 1 },
    ]

    expect(normalizeAllocationItems(input)).toEqual([
      { campaign_item_id: "item-a", quantity: 1 },
      { campaign_item_id: "item-z", quantity: 2 },
    ])
    expect(input.map((item) => item.campaign_item_id)).toEqual([
      "item-z",
      "item-a",
    ])
  })
})

describe("request and idempotency fingerprints", () => {
  const request = {
    schema_version: 1,
    campaign_id: "campaign-1",
    subject_id: "subject-1",
    cart_id: "cart-1",
    rules_version: 7,
    items: [
      { campaign_item_id: "item-b", quantity: 1 },
      { campaign_item_id: "item-a", quantity: 2 },
    ],
  }

  it("is insensitive to caller item order", () => {
    const reordered = {
      ...request,
      items: [...request.items].reverse(),
    }

    expect(createCanonicalRequestFingerprint(reordered)).toBe(
      createCanonicalRequestFingerprint(request)
    )
  })

  it.each([
    ["schema_version", 2],
    ["campaign_id", "campaign-2"],
    ["subject_id", "subject-2"],
    ["cart_id", "cart-2"],
    ["rules_version", 8],
  ])("changes when %s changes", (field, value) => {
    const changed = { ...request, [field]: value }

    expect(createCanonicalRequestFingerprint(changed)).not.toBe(
      createCanonicalRequestFingerprint(request)
    )
  })

  it("changes when a normalized item value changes", () => {
    const changed = {
      ...request,
      items: [
        { campaign_item_id: "item-b", quantity: 1 },
        { campaign_item_id: "item-a", quantity: 3 },
      ],
    }

    expect(createCanonicalRequestFingerprint(changed)).not.toBe(
      createCanonicalRequestFingerprint(request)
    )
  })

  it("accepts a null cart as a canonical business value", () => {
    expect(
      createCanonicalRequestFingerprint({
        ...request,
        cart_id: null,
      })
    ).toMatch(/^[a-f0-9]{64}$/)
  })

  it("distinguishes a null cart from a concrete cart", () => {
    expect(
      createCanonicalRequestFingerprint({
        ...request,
        cart_id: null,
      })
    ).not.toBe(createCanonicalRequestFingerprint(request))
  })

  it("rejects an empty non-null cart id", () => {
    expect(() =>
      createCanonicalRequestFingerprint({
        ...request,
        cart_id: "",
      })
    ).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.INVALID_FINGERPRINT_FIELD,
      })
    )
  })
})
