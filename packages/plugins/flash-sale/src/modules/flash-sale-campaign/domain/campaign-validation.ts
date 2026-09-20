export type CampaignDateValue = Date | string | null | undefined

export class InvalidCampaignDataError extends Error {
  readonly code = "INVALID_CAMPAIGN_DATA"

  constructor(message: string) {
    super(message)
    this.name = "InvalidCampaignDataError"
  }
}

function parseCampaignDate(
  field: string,
  value: CampaignDateValue
): Date | null {
  if (value === null || value === undefined) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new InvalidCampaignDataError(`${field} must be a valid date`)
  }

  return date
}

export function assertValidCampaignWindow(
  startsAt: CampaignDateValue,
  endsAt: CampaignDateValue,
  options: { required?: boolean } = {}
): void {
  const start = parseCampaignDate("starts_at", startsAt)
  const end = parseCampaignDate("ends_at", endsAt)

  if (options.required && (!start || !end)) {
    throw new InvalidCampaignDataError(
      "starts_at and ends_at are required before scheduling a campaign"
    )
  }

  if ((start && !end) || (!start && end)) {
    throw new InvalidCampaignDataError(
      "starts_at and ends_at must be provided together"
    )
  }

  if (start && end && start.getTime() >= end.getTime()) {
    throw new InvalidCampaignDataError("starts_at must be before ends_at")
  }
}

export function assertPositiveInteger(field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidCampaignDataError(`${field} must be a positive integer`)
  }
}

export function assertPositiveQuota(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidCampaignDataError("quota must be a positive integer")
  }
}
