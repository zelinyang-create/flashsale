/**
 * Stable, transport-agnostic codes for allocation-domain validation errors.
 * The application boundary may map them to HTTP or workflow error contracts.
 */
export enum AllocationDomainErrorCode {
  INVALID_ALLOCATION_POLICY_STATE_TRANSITION = "INVALID_ALLOCATION_POLICY_STATE_TRANSITION",
  INVALID_PURCHASE_ATTEMPT_STATE_TRANSITION = "INVALID_PURCHASE_ATTEMPT_STATE_TRANSITION",
  INVALID_ALLOCATION_HOLD_STATE_TRANSITION = "INVALID_ALLOCATION_HOLD_STATE_TRANSITION",
  EMPTY_ALLOCATION_ITEMS = "EMPTY_ALLOCATION_ITEMS",
  INVALID_CAMPAIGN_ITEM_ID = "INVALID_CAMPAIGN_ITEM_ID",
  INVALID_ALLOCATION_ITEM_QUANTITY = "INVALID_ALLOCATION_ITEM_QUANTITY",
  DUPLICATE_CAMPAIGN_ITEM_ID = "DUPLICATE_CAMPAIGN_ITEM_ID",
  INVALID_FINGERPRINT_FIELD = "INVALID_FINGERPRINT_FIELD",
}

export class AllocationDomainError extends Error {
  constructor(readonly code: AllocationDomainErrorCode, message: string) {
    super(message)
    this.name = "AllocationDomainError"
  }
}
