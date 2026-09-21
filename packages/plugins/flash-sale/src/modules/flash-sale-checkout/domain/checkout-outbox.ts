import { CheckoutExecutionState } from "../../../types"
import {
  CHECKOUT_OUTBOX_AGGREGATE_TYPE,
  CHECKOUT_OUTBOX_SCHEMA_VERSION,
  CheckoutEventIdentity,
  CheckoutOutboxEventName,
  CheckoutOutboxEventNameValue,
  canonicalJson,
  compareUtf16CodeUnits,
  hashCheckoutEventIdentity,
} from "../../../shared"
import type { CheckoutExecutionSnapshot } from "./contracts"

export type CheckoutOutboxPayload = Readonly<{
  execution_id: string
  attempt_id: string
  campaign_id: string
  rules_version: number
  state: CheckoutExecutionState
  items: readonly Readonly<{
    campaign_item_id: string
    variant_id: string
    quantity: number
  }>[]
  order_id?: string
  error_code?: string
}>

export type CheckoutOutboxEnvelope = CheckoutEventIdentity &
  Readonly<{ payload: CheckoutOutboxPayload; event_hash: string }>

export class CheckoutOutboxValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CheckoutOutboxValidationError"
  }
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/

export function sanitizeCheckoutOutboxErrorCode(value: string): string {
  return ERROR_CODE.test(value) ? value : "CHECKOUT_ERROR_UNCLASSIFIED"
}

export function checkoutOutboxEventNameFor(
  state: CheckoutExecutionState
): CheckoutOutboxEventNameValue {
  switch (state) {
    case CheckoutExecutionState.PREPARED:
      return CheckoutOutboxEventName.PREPARED
    case CheckoutExecutionState.COMMERCE_PENDING:
      return CheckoutOutboxEventName.COMMERCE_PENDING
    case CheckoutExecutionState.COMMERCE_SUCCEEDED:
      return CheckoutOutboxEventName.COMMERCE_SUCCEEDED
    case CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED:
      return CheckoutOutboxEventName.COMMERCE_DEFINITIVE_FAILED
    case CheckoutExecutionState.COMMERCE_UNKNOWN:
      return CheckoutOutboxEventName.COMMERCE_UNKNOWN
    case CheckoutExecutionState.COMPLETED:
      return CheckoutOutboxEventName.COMPLETED
    case CheckoutExecutionState.CANCELED:
      return CheckoutOutboxEventName.CANCELED
    default:
      throw new CheckoutOutboxValidationError(
        `No checkout outbox event exists for state ${state}`
      )
  }
}

export function buildCheckoutOutboxEnvelope(
  snapshot: CheckoutExecutionSnapshot
): CheckoutOutboxEnvelope {
  const execution = snapshot.execution
  if (
    !execution.outbox_stream_started ||
    execution.business_version < 1 ||
    !execution.business_changed_at
  ) {
    throw new CheckoutOutboxValidationError(
      "Checkout outbox stream has not been started"
    )
  }
  const payload: CheckoutOutboxPayload = Object.freeze({
    execution_id: execution.id,
    attempt_id: execution.attempt_id,
    campaign_id: execution.campaign_id,
    rules_version: execution.rules_version,
    state: execution.state,
    items: Object.freeze(
      snapshot.items
        .map((item) =>
          Object.freeze({
            campaign_item_id: item.campaign_item_id,
            variant_id: item.variant_id,
            quantity: item.quantity,
          })
        )
        .sort((left, right) => {
          const campaign = compareUtf16CodeUnits(
            left.campaign_item_id,
            right.campaign_item_id
          )
          return campaign === 0
            ? compareUtf16CodeUnits(left.variant_id, right.variant_id)
            : campaign
        })
    ),
    ...(execution.state === CheckoutExecutionState.COMMERCE_SUCCEEDED ||
    execution.state === CheckoutExecutionState.COMPLETED
      ? { order_id: execution.order_id! }
      : {}),
    ...(execution.state ===
      CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED ||
    execution.state === CheckoutExecutionState.COMMERCE_UNKNOWN ||
    execution.state === CheckoutExecutionState.CANCELED
      ? {
          error_code: sanitizeCheckoutOutboxErrorCode(
            execution.last_error_code ?? "CHECKOUT_ERROR_UNCLASSIFIED"
          ),
        }
      : {}),
  })
  const identity: CheckoutEventIdentity = {
    event_name: checkoutOutboxEventNameFor(execution.state),
    schema_version: CHECKOUT_OUTBOX_SCHEMA_VERSION,
    aggregate_type: CHECKOUT_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: execution.id,
    aggregate_version: execution.business_version,
    payload,
  }
  const serialized = canonicalJson(payload)
  if (Buffer.byteLength(serialized, "utf8") > 65_536) {
    throw new CheckoutOutboxValidationError(
      "Checkout outbox payload exceeds 65536 bytes"
    )
  }
  return Object.freeze({
    ...identity,
    payload,
    event_hash: hashCheckoutEventIdentity(identity),
  })
}
