import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  ApplyCapacityRepairCommand,
  capacityRepairActionSetDigest,
  prepareApplyCapacityRepairCommand,
  RepairApprovalVerifier,
  VerifiedRepairApproval,
} from ".."

const NOW = new Date("2026-09-21T12:00:00.000Z")
const PLAN_DIGEST = "a".repeat(64)

function command(
  overrides: Partial<ApplyCapacityRepairCommand> = {}
): ApplyCapacityRepairCommand {
  return {
    request_id: "apply-request-1",
    plan_run_id: "fsreprun_1",
    expected_plan_evidence_digest: PLAN_DIGEST,
    action_ids: ["fsrepact_b", "fsrepact_a"],
    requester: "operator-requester",
    reason: "approved counter mirror repair",
    ticket: "INC-3D-1",
    approval_credential: "opaque-signed-credential",
    approval_reference: "approval-reference-1",
    statement_timeout_ms: 1_000,
    ...overrides,
  }
}

function approval(
  overrides: Partial<VerifiedRepairApproval> = {}
): VerifiedRepairApproval {
  const actionSet = capacityRepairActionSetDigest("fsreprun_1", [
    "fsrepact_a",
    "fsrepact_b",
  ])
  return {
    approver: "operator-approver",
    issuer: "approval.example.internal",
    audience: "flash-sale-repair",
    tenant: "tenant-1",
    jti: "approval-jti-1",
    issued_at: new Date("2026-09-21T11:55:00.000Z"),
    not_before: new Date("2026-09-21T11:55:00.000Z"),
    expires_at: new Date("2026-09-21T12:05:00.000Z"),
    roles: ["repair-approver", "incident-commander"],
    purpose: "capacity_repair_apply",
    permission_version: "repair-rbac-v1",
    approval_reference: "approval-reference-1",
    plan_schema_version: 2,
    campaign_id: "campaign-1",
    plan_run_id: "fsreprun_1",
    plan_evidence_digest: PLAN_DIGEST,
    ordered_action_set_digest: actionSet,
    ...overrides,
  }
}

function verifier(
  result: VerifiedRepairApproval,
  observe?: (value: unknown) => void
): RepairApprovalVerifier {
  return {
    verify: async (input) => {
      observe?.(input)
      return result
    },
  }
}

describe("prepareApplyCapacityRepairCommand", () => {
  it("binds a trusted approval and removes raw identities and credentials", async () => {
    let verificationInput: unknown
    const prepared = await prepareApplyCapacityRepairCommand(
      command(),
      verifier(approval(), (value) => (verificationInput = value)),
      NOW
    )
    expect(verificationInput).toEqual({
      credential: "opaque-signed-credential",
      reference: "approval-reference-1",
    })
    expect(prepared.ordered_action_ids).toEqual([
      "fsrepact_a",
      "fsrepact_b",
    ])
    expect(prepared).toMatchObject({
      plan_run_id: "fsreprun_1",
      plan_schema_version: 2,
      campaign_id: "campaign-1",
      expected_plan_evidence_digest: PLAN_DIGEST,
      requester: "operator-requester",
      approver: "operator-approver",
      approval_issuer: "approval.example.internal",
      approval_permission_version: "repair-rbac-v1",
      approval_purpose: "capacity_repair_apply",
    })
    expect(prepared.request_identity_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.approval_token_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.approval_claims_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.approval_token_digest).not.toBe(
      prepared.approval_claims_digest
    )
    const serialized = JSON.stringify(prepared)
    expect(serialized).not.toContain("apply-request-1")
    expect(serialized).not.toContain("opaque-signed-credential")
    expect(serialized).not.toContain("approval-reference-1")
    expect(serialized).not.toContain("approval-jti-1")
  })

  it("uses frozen codepoint ordering and canonical golden digests", async () => {
    const prepared = await prepareApplyCapacityRepairCommand(
      command(),
      verifier(approval()),
      NOW
    )
    expect(prepared.ordered_action_set_digest).toBe(
      "924294406fe3cd0737902115c18652e91dc3bf3aad45c11ea6cbb9d4e4eddf04"
    )
    expect(prepared.approval_claims_digest).toBe(
      "17d1c1d34262e86025d3ff54275bce21a3b345c829dac504641e3e9b9e0d9665"
    )
    expect(prepared.command_digest).toBe(
      "376d60e5c9a54fc1c9c93802ce96e587443596ffc8b29040d4d8f37f3d4770fc"
    )
    const reordered = await prepareApplyCapacityRepairCommand(
      command({ action_ids: ["fsrepact_a", "fsrepact_b"] }),
      verifier(approval({ roles: ["incident-commander", "repair-approver"] })),
      NOW
    )
    expect(reordered).toEqual(prepared)
  })

  it("deeply snapshots verifier-owned mutable roles and dates", async () => {
    const roles = ["repair-approver", "incident-commander"]
    const issuedAt = new Date("2026-09-21T11:55:00.000Z")
    const notBefore = new Date("2026-09-21T11:55:00.000Z")
    const expiresAt = new Date("2026-09-21T12:05:00.000Z")
    const verified = approval({
      roles,
      issued_at: issuedAt,
      not_before: notBefore,
      expires_at: expiresAt,
    })
    const prepared = await prepareApplyCapacityRepairCommand(
      command(),
      verifier(verified),
      NOW
    )
    const canonicalBefore = JSON.stringify(prepared)
    const claimsDigestBefore = prepared.approval_claims_digest
    const commandDigestBefore = prepared.command_digest

    roles.push("mutated-after-verification")
    issuedAt.setUTCFullYear(2030)
    notBefore.setUTCFullYear(2030)
    expiresAt.setUTCFullYear(2030)

    expect(Object.isFrozen(prepared.approval_roles)).toBe(true)
    expect(() =>
      (prepared.approval_roles as string[]).push("prepared-mutation")
    ).toThrow()
    expect(JSON.stringify(prepared)).toBe(canonicalBefore)
    expect(prepared.approval_claims_digest).toBe(claimsDigestBefore)
    expect(prepared.command_digest).toBe(commandDigestBefore)
    expect(prepared.approval_issued_at).toBe("2026-09-21T11:55:00.000Z")
    expect(prepared.approval_expires_at).toBe("2026-09-21T12:05:00.000Z")
  })

  it.each([
    [
      "plan",
      approval({ plan_run_id: "fsreprun_other" }),
    ],
    [
      "evidence",
      approval({ plan_evidence_digest: "b".repeat(64) }),
    ],
    [
      "action set",
      approval({ ordered_action_set_digest: "c".repeat(64) }),
    ],
    [
      "reference",
      approval({ approval_reference: "different-reference" }),
    ],
  ])("rejects trusted approval %s binding drift", async (_label, verified) => {
    await expect(
      prepareApplyCapacityRepairCommand(command(), verifier(verified), NOW)
    ).rejects.toMatchObject({
      code: AllocationCommandErrorCode.REPAIR_APPROVAL_INVALID,
    })
  })

  it("rejects expired approvals and duplicate action ids", async () => {
    await expect(
      prepareApplyCapacityRepairCommand(
        command(),
        verifier(approval({ expires_at: NOW })),
        NOW
      )
    ).rejects.toBeInstanceOf(AllocationCommandError)
    await expect(
      prepareApplyCapacityRepairCommand(
        command({ action_ids: ["fsrepact_a", "fsrepact_a"] }),
        verifier(approval()),
        NOW
      )
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
  })

  it("rejects non-allowlisted caller-owned repair facts", async () => {
    const value = {
      ...command(),
      expected_held_quantity: "0",
    } as ApplyCapacityRepairCommand
    await expect(
      prepareApplyCapacityRepairCommand(value, verifier(approval()), NOW)
    ).rejects.toMatchObject({ code: AllocationCommandErrorCode.INVALID_COMMAND })
  })
})
