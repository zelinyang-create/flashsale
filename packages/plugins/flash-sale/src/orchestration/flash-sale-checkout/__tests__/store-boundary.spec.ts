import { createHash } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import {
  CanonicalCartError,
  CanonicalCartErrorCode,
} from "../canonical-cart-reader"
import {
  FlashSaleStoreBoundaryErrorCode,
  hashFlashSaleIdempotencyKey,
  mapFlashSaleCheckoutResult,
  toPublicFlashSaleCheckoutError,
} from "../store-boundary"

describe("flash-sale Store boundary", () => {
  it("hashes the exact raw key immediately with domain separation", () => {
    const first = hashFlashSaleIdempotencyKey("checkout-request-1")
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toBe(hashFlashSaleIdempotencyKey("checkout-request-1"))
    expect(first).not.toBe(
      createHash("sha256").update("checkout-request-1").digest("hex")
    )
    expect(first).not.toContain("checkout-request-1")
  })

  it.each([
    [undefined, FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_REQUIRED],
    ["", FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID],
    [" raw", FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID],
    ["raw\nkey", FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID],
    [["one", "two"], FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID],
    ["x".repeat(256), FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID],
  ])("rejects unsafe idempotency header %#", (value, code) => {
    expect(() => hashFlashSaleIdempotencyKey(value)).toThrow(
      expect.objectContaining({ code })
    )
  })

  it("maps internal result states without exposing unknown internals", () => {
    expect(
      mapFlashSaleCheckoutResult({
        status: "completed",
        execution_id: "execution-1",
        order_id: "order-1",
        replayed: true,
      })
    ).toEqual({
      status: 200,
      body: {
        status: "completed",
        execution_id: "execution-1",
        order_id: "order-1",
        replayed: true,
      },
    })
    expect(
      mapFlashSaleCheckoutResult({
        status: "unknown",
        execution_id: "execution-1",
        error_code: "PROVIDER_SECRET_DETAIL",
        replayed: false,
      })
    ).toEqual({
      status: 202,
      body: {
        status: "unknown",
        code: "COMMERCE_RESULT_UNKNOWN",
        execution_id: "execution-1",
        replayed: false,
      },
    })
  })

  it("makes missing and unauthorized carts externally indistinguishable", () => {
    const missing = toPublicFlashSaleCheckoutError(
      new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
        "database returned no row"
      )
    )
    const wrongOwner = toPublicFlashSaleCheckoutError(
      new CanonicalCartError(
        CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE,
        "sensitive owner detail"
      )
    )

    expect({ type: missing.type, message: missing.message }).toEqual({
      type: MedusaError.Types.NOT_FOUND,
      message: "Cart is not available",
    })
    expect({ type: wrongOwner.type, message: wrongOwner.message }).toEqual({
      type: missing.type,
      message: missing.message,
    })
  })

  it("maps validation and conflict failures to stable Medusa errors", () => {
    expect(
      toPublicFlashSaleCheckoutError(
        new CanonicalCartError(
          CanonicalCartErrorCode.CART_ITEMS_INVALID,
          "sensitive item detail"
        )
      )
    ).toMatchObject({ type: MedusaError.Types.INVALID_DATA })
    expect(
      toPublicFlashSaleCheckoutError(
        Object.assign(new Error("internal database detail"), {
          code: "CART_ATTEMPT_CONFLICT",
        })
      )
    ).toMatchObject({
      type: MedusaError.Types.CONFLICT,
      message: "Flash-sale checkout conflicts with an existing request",
    })
    expect(
      toPublicFlashSaleCheckoutError(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "provider account and database internals"
        )
      )
    ).toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: "Flash-sale checkout request is not allowed",
    })
  })
})
