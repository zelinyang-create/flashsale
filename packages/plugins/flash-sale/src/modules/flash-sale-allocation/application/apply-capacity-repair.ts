import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  ApplyCapacityRepairResult,
  ApplyCapacityRepairCommand,
  CapacityRepairApplyStore,
  DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  MAX_CAPACITY_REPAIR_APPLY_ACTIONS,
  MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS,
  PreparedApplyCapacityRepairCommand,
  RepairApprovalVerifier,
  VerifiedRepairApproval,
} from "./contracts"
import {
  compareRepairPlanKeys,
  repairPlanDigest,
} from "./dry-run-capacity-repair"

const APPLY_FIELDS = new Set([
  "request_id",
  "idempotency_key",
  "plan_run_id",
  "expected_plan_evidence_digest",
  "action_ids",
  "requester",
  "reason",
  "ticket",
  "approval_credential",
  "approval_reference",
  "statement_timeout_ms",
])

const DIGEST = /^[0-9a-f]{64}$/

function invalid(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.INVALID_COMMAND,
    message
  )
}

export class ApplyCapacityRepairHandler {
  constructor(
    private readonly store: CapacityRepairApplyStore,
    private readonly approvalVerifier: RepairApprovalVerifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(
    command: ApplyCapacityRepairCommand
  ): Promise<ApplyCapacityRepairResult> {
    const prepared = await prepareApplyCapacityRepairCommand(
      command,
      this.approvalVerifier,
      this.now()
    )
    return await this.store.applyCapacityRepair(prepared)
  }
}

function invalidApproval(message: string): never {
  throw new AllocationCommandError(
    AllocationCommandErrorCode.REPAIR_APPROVAL_INVALID,
    message
  )
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("applyCapacityRepair requires a plain command")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("applyCapacityRepair requires a plain command")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !APPLY_FIELDS.has(key)) {
      invalid("applyCapacityRepair received an unsupported command field")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid("applyCapacityRepair command fields must be plain values")
    }
    result[key] = descriptor.value
  }
  return result
}

function text(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  ) {
    invalid(`${field} must be a bounded, trimmed string`)
  }
  return value
}

function digest(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!DIGEST.test(result)) invalid(`${field} must be a lowercase SHA-256 digest`)
  return result
}

function date(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidApproval(`${field} is invalid`)
  }
  return new Date(value.getTime())
}

function verifiedText(value: unknown, field: string, maximum = 255): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  ) {
    invalidApproval(`${field} is invalid`)
  }
  return value
}

type NormalizedVerifiedApproval = Omit<
  VerifiedRepairApproval,
  "issued_at" | "not_before" | "expires_at"
> &
  Readonly<{
    issued_at: string
    not_before: string
    expires_at: string
  }>

function normalizeVerifiedApproval(
  approval: VerifiedRepairApproval,
  now: Date
): NormalizedVerifiedApproval {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    invalidApproval("approval verifier returned an invalid result")
  }
  const issuedAt = date(approval.issued_at, "approval issued_at")
  const notBefore = date(approval.not_before, "approval not_before")
  const expiresAt = date(approval.expires_at, "approval expires_at")
  if (
    issuedAt.getTime() > now.getTime() ||
    notBefore.getTime() > now.getTime() ||
    expiresAt.getTime() <= now.getTime()
  ) {
    invalidApproval("approval is not currently valid")
  }
  if (approval.purpose !== "capacity_repair_apply") {
    invalidApproval("approval purpose is invalid")
  }
  if (approval.plan_schema_version !== 2) {
    invalidApproval("approval plan schema is not Apply-eligible")
  }
  if (!Array.isArray(approval.roles) || approval.roles.length < 1) {
    invalidApproval("approval roles are invalid")
  }
  const roles = Object.freeze(
    [...new Set(approval.roles.map((role) =>
      verifiedText(role, "approval role")
    ))].sort(compareRepairPlanKeys)
  )
  return Object.freeze({
    approver: verifiedText(approval.approver, "approval approver"),
    issuer: verifiedText(approval.issuer, "approval issuer"),
    audience: verifiedText(approval.audience, "approval audience"),
    tenant: verifiedText(approval.tenant, "approval tenant"),
    jti: verifiedText(approval.jti, "approval jti", 512),
    issued_at: issuedAt.toISOString(),
    not_before: notBefore.toISOString(),
    expires_at: expiresAt.toISOString(),
    roles,
    purpose: approval.purpose,
    permission_version: verifiedText(
      approval.permission_version,
      "approval permission_version"
    ),
    approval_reference: verifiedText(
      approval.approval_reference,
      "approval reference",
      512
    ),
    plan_schema_version: approval.plan_schema_version,
    campaign_id: verifiedText(approval.campaign_id, "approval campaign_id"),
    plan_run_id: verifiedText(approval.plan_run_id, "approval plan_run_id"),
    plan_evidence_digest: digest(
      approval.plan_evidence_digest,
      "approval plan_evidence_digest"
    ),
    ordered_action_set_digest: digest(
      approval.ordered_action_set_digest,
      "approval ordered_action_set_digest"
    ),
  })
}

export function capacityRepairActionSetDigest(
  planRunId: string,
  orderedActionIds: readonly string[]
): string {
  return repairPlanDigest({
    schema: "capacity-repair-apply-action-set-v1",
    plan_run_id: planRunId,
    ordered_action_ids: orderedActionIds,
  })
}

export async function prepareApplyCapacityRepairCommand(
  command: ApplyCapacityRepairCommand,
  verifier: RepairApprovalVerifier,
  now = new Date()
): Promise<PreparedApplyCapacityRepairCommand> {
  const values = plainRecord(command)
  const hasRequestId = values.request_id !== undefined
  const hasIdempotencyKey = values.idempotency_key !== undefined
  if (hasRequestId === hasIdempotencyKey) {
    invalid("exactly one of request_id or idempotency_key is required")
  }
  const identityType = hasRequestId ? "request_id" : "idempotency_key"
  const identity = text(
    hasRequestId ? values.request_id : values.idempotency_key,
    identityType,
    hasRequestId ? 255 : 512
  )
  const planRunId = text(values.plan_run_id, "plan_run_id", 255)
  const planEvidenceDigest = digest(
    values.expected_plan_evidence_digest,
    "expected_plan_evidence_digest"
  )
  if (!Array.isArray(values.action_ids)) invalid("action_ids must be an array")
  if (
    values.action_ids.length < 1 ||
    values.action_ids.length > MAX_CAPACITY_REPAIR_APPLY_ACTIONS
  ) {
    invalid(`action_ids must contain 1-${MAX_CAPACITY_REPAIR_APPLY_ACTIONS} ids`)
  }
  const orderedActionIds = values.action_ids
    .map((value) => text(value, "action_id", 255))
    .sort(compareRepairPlanKeys)
  if (new Set(orderedActionIds).size !== orderedActionIds.length) {
    invalid("action_ids must be unique")
  }
  const requester = text(values.requester, "requester", 255)
  const reason = text(values.reason, "reason", 2_000)
  const ticket = text(values.ticket, "ticket", 255)
  const credential = text(
    values.approval_credential,
    "approval_credential",
    8_192
  )
  const reference = text(values.approval_reference, "approval_reference", 512)
  const timeout =
    values.statement_timeout_ms === undefined
      ? DEFAULT_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS
      : values.statement_timeout_ms
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > MAX_MOVEMENT_LEDGER_STATEMENT_TIMEOUT_MS
  ) {
    invalid("statement_timeout_ms is outside the supported range")
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    invalid("server verification time is invalid")
  }
  const actionSetDigest = capacityRepairActionSetDigest(
    planRunId,
    orderedActionIds
  )
  const approval = normalizeVerifiedApproval(
    await verifier.verify({ credential, reference }),
    now
  )
  if (
    approval.approval_reference !== reference ||
    approval.plan_run_id !== planRunId ||
    approval.plan_evidence_digest !== planEvidenceDigest ||
    approval.ordered_action_set_digest !== actionSetDigest
  ) {
    invalidApproval("approval binding does not match the repair plan command")
  }
  if (approval.approver === requester) {
    invalidApproval("repair approval requires a distinct approver")
  }
  const requestIdentityDigest = repairPlanDigest({
    domain: "capacity-repair-apply-request-identity-v1",
    identity_type: identityType,
    identity,
  })
  const approvalTokenDigest = repairPlanDigest({
    domain: "capacity-repair-approval-token-v1",
    credential,
  })
  const approvalReferenceDigest = repairPlanDigest({
    domain: "capacity-repair-approval-reference-v1",
    reference,
  })
  const approvalJtiDigest = repairPlanDigest({
    domain: "capacity-repair-approval-jti-v1",
    issuer: approval.issuer,
    jti: approval.jti,
  })
  const claimManifest = {
    schema: "capacity-repair-approval-claims-v1",
    approver: approval.approver,
    issuer: approval.issuer,
    audience: approval.audience,
    tenant: approval.tenant,
    jti_digest: approvalJtiDigest,
    issued_at: approval.issued_at,
    not_before: approval.not_before,
    expires_at: approval.expires_at,
    roles: approval.roles,
    purpose: approval.purpose,
    permission_version: approval.permission_version,
    approval_reference_digest: approvalReferenceDigest,
    plan_schema_version: approval.plan_schema_version,
    campaign_id: approval.campaign_id,
    plan_run_id: approval.plan_run_id,
    plan_evidence_digest: approval.plan_evidence_digest,
    ordered_action_set_digest: approval.ordered_action_set_digest,
  }
  const approvalClaimsDigest = repairPlanDigest(claimManifest)
  const canonical = {
    schema: "capacity-repair-apply-command-v1",
    request_identity_digest: requestIdentityDigest,
    plan_run_id: planRunId,
    plan_schema_version: approval.plan_schema_version,
    campaign_id: approval.campaign_id,
    expected_plan_evidence_digest: planEvidenceDigest,
    ordered_action_ids: orderedActionIds,
    ordered_action_set_digest: actionSetDigest,
    requester,
    reason,
    ticket,
    statement_timeout_ms: timeout,
    approval_token_digest: approvalTokenDigest,
    approval_claims_digest: approvalClaimsDigest,
    approval_reference_digest: approvalReferenceDigest,
  }
  return Object.freeze({
    request_identity_digest: requestIdentityDigest,
    command_digest: repairPlanDigest(canonical),
    plan_run_id: planRunId,
    plan_schema_version: approval.plan_schema_version,
    campaign_id: approval.campaign_id,
    expected_plan_evidence_digest: planEvidenceDigest,
    ordered_action_ids: Object.freeze(orderedActionIds),
    ordered_action_set_digest: actionSetDigest,
    requester,
    reason,
    ticket,
    statement_timeout_ms: timeout,
    approval_token_digest: approvalTokenDigest,
    approval_claims_digest: approvalClaimsDigest,
    approval_reference_digest: approvalReferenceDigest,
    approver: approval.approver,
    approval_issuer: approval.issuer,
    approval_audience: approval.audience,
    approval_tenant: approval.tenant,
    approval_jti_digest: approvalJtiDigest,
    approval_permission_version: approval.permission_version,
    approval_issued_at: approval.issued_at,
    approval_not_before: approval.not_before,
    approval_expires_at: approval.expires_at,
    approval_roles: approval.roles,
    approval_purpose: approval.purpose,
  })
}
