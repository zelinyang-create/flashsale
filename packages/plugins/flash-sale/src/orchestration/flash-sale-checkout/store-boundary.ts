import { createHash } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import {
  FlashSaleCheckoutOrchestrationError,
  FlashSaleCheckoutOrchestrationErrorCode,
  FlashSaleCheckoutResult,
} from "./contracts"
import {
  CanonicalCartError,
  CanonicalCartErrorCode,
} from "./canonical-cart-reader"

const IDEMPOTENCY_DOMAIN = "medusa:flash-sale-checkout:v1\0"
const MAX_IDEMPOTENCY_KEY_BYTES = 255
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export enum FlashSaleStoreBoundaryErrorCode {
  IDEMPOTENCY_KEY_REQUIRED = "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_INVALID = "IDEMPOTENCY_KEY_INVALID",
  AUTHENTICATED_CUSTOMER_REQUIRED = "AUTHENTICATED_CUSTOMER_REQUIRED",
}

export class FlashSaleStoreBoundaryError extends Error {
  constructor(readonly code: FlashSaleStoreBoundaryErrorCode, message: string) {
    super(message)
    this.name = "FlashSaleStoreBoundaryError"
  }
}

export function hashFlashSaleIdempotencyKey(value: unknown): string {
  if (value === undefined) {
    throw new FlashSaleStoreBoundaryError(
      FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      "Idempotency-Key header is required"
    )
  }
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new FlashSaleStoreBoundaryError(
      FlashSaleStoreBoundaryErrorCode.IDEMPOTENCY_KEY_INVALID,
      "Idempotency-Key header is invalid"
    )
  }
  return createHash("sha256")
    .update(IDEMPOTENCY_DOMAIN, "utf8")
    .update(value, "utf8")
    .digest("hex")
}

export type FlashSaleCheckoutHttpResponse = Readonly<{
  status: 200 | 202 | 409
  body: Readonly<Record<string, unknown>>
}>

export function mapFlashSaleCheckoutResult(
  result: FlashSaleCheckoutResult
): FlashSaleCheckoutHttpResponse {
  if (result.status === "completed") {
    return {
      status: 200,
      body: {
        status: result.status,
        execution_id: result.execution_id,
        order_id: result.order_id,
        replayed: result.replayed,
      },
    }
  }
  if (result.status === "unknown") {
    return {
      status: 202,
      body: {
        status: result.status,
        code: "COMMERCE_RESULT_UNKNOWN",
        execution_id: result.execution_id,
        replayed: result.replayed,
      },
    }
  }
  if (result.status === "in_progress") {
    return {
      status: 202,
      body: {
        status: result.status,
        code: result.reason,
        execution_id: result.execution_id,
        replayed: result.replayed,
      },
    }
  }
  if (result.status === "manual_review") {
    return {
      status: 202,
      body: {
        status: "unknown",
        code: "MANUAL_REVIEW_REQUIRED",
        execution_id: result.execution_id,
        replayed: result.replayed,
      },
    }
  }
  if (result.status === "canceled") {
    return {
      status: 409,
      body: {
        status: result.status,
        code: result.error_code,
        execution_id: result.execution_id,
        replayed: result.replayed,
      },
    }
  }
  return {
    status: 409,
    body: {
      status: "canceled",
      code: result.error_code,
      replayed: result.replayed,
    },
  }
}

export function toPublicFlashSaleCheckoutError(error: unknown): MedusaError {
  if (error instanceof MedusaError) {
    if (
      error.type === MedusaError.Types.UNAUTHORIZED ||
      error.type === MedusaError.Types.FORBIDDEN
    ) {
      return new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Authenticated customer is required"
      )
    }
    if (error.type === MedusaError.Types.NOT_FOUND) {
      return new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "Flash-sale checkout resource was not found"
      )
    }
    if (error.type === MedusaError.Types.CONFLICT) {
      return new MedusaError(
        MedusaError.Types.CONFLICT,
        "Flash-sale checkout conflicts with an existing request"
      )
    }
    if (
      error.type === MedusaError.Types.NOT_ALLOWED ||
      error.type === MedusaError.Types.INVALID_ARGUMENT ||
      error.type === MedusaError.Types.INVALID_DATA
    ) {
      return new MedusaError(
        error.type,
        "Flash-sale checkout request is not allowed"
      )
    }
    return new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Flash-sale checkout is temporarily unavailable"
    )
  }
  if (error instanceof FlashSaleStoreBoundaryError) {
    const type =
      error.code ===
      FlashSaleStoreBoundaryErrorCode.AUTHENTICATED_CUSTOMER_REQUIRED
        ? MedusaError.Types.UNAUTHORIZED
        : MedusaError.Types.INVALID_DATA
    return new MedusaError(type, error.message)
  }
  if (error instanceof CanonicalCartError) {
    if (
      error.code === CanonicalCartErrorCode.CART_NOT_FOUND_OR_UNAVAILABLE
    ) {
      return new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "Cart is not available"
      )
    }
    if (
      error.code === CanonicalCartErrorCode.EXECUTION_IDENTITY_CONFLICT ||
      error.code === CanonicalCartErrorCode.MULTIPLE_FLASH_SALE_CAMPAIGNS ||
      error.code === CanonicalCartErrorCode.CART_NOT_CHECKOUT_READY
    ) {
      return new MedusaError(
        MedusaError.Types.CONFLICT,
        "Cart conflicts with flash-sale checkout state"
      )
    }
    return new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Cart is not eligible for flash-sale checkout"
    )
  }
  if (error instanceof FlashSaleCheckoutOrchestrationError) {
    if (
      error.code === FlashSaleCheckoutOrchestrationErrorCode.INVALID_COMMAND
    ) {
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Flash-sale checkout request is invalid"
      )
    }
    if (
      error.code ===
      FlashSaleCheckoutOrchestrationErrorCode.INVALID_PERSISTED_STATE
    ) {
      return new MedusaError(
        MedusaError.Types.CONFLICT,
        "Flash-sale checkout state conflicts with this request"
      )
    }
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined
  if (
    typeof code === "string" &&
    (code.endsWith("_CONFLICT") || code.includes("FENCE"))
  ) {
    return new MedusaError(
      MedusaError.Types.CONFLICT,
      "Flash-sale checkout conflicts with an existing request"
    )
  }
  return new MedusaError(
    MedusaError.Types.UNEXPECTED_STATE,
    "Flash-sale checkout is temporarily unavailable"
  )
}
