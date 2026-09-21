import {
  AllocationCommandError,
  CapacityRepairPlanStore,
  DryRunCapacityRepairHandler,
  PreparedDryRunCapacityRepairCommand,
  prepareDryRunCapacityRepairCommand,
  repairPlanDigest,
} from ".."
import { isRepairIdentityUniqueViolation } from "../../persistence"

describe("DryRunCapacityRepairHandler", () => {
  it("hashes sensitive identity and delegates a canonical bounded command", async () => {
    let received: PreparedDryRunCapacityRepairCommand | undefined
    const store: CapacityRepairPlanStore = {
      dryRunCapacityRepair: async (input) => {
        received = input
        return {
          disposition: "fresh",
          run_id: "run-1",
          status: "no_changes",
          classification: null,
          evidence_digest: "a".repeat(64),
          snapshot_at: new Date("2026-09-21T00:00:00Z"),
          actions: [],
        }
      },
    }
    await new DryRunCapacityRepairHandler(store).execute({
      idempotency_key: "secret-key",
      campaign_id: "campaign-1",
      actor: "operator-1",
      reason: "verify drift",
      ticket: "INC-1",
    })
    expect(received).toMatchObject({
      campaign_id: "campaign-1",
      actor: "operator-1",
      reason: "verify drift",
      ticket: "INC-1",
      statement_timeout_ms: 5_000,
      batch_size: 500,
    })
    expect(received?.request_identity_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(received)).not.toContain("secret-key")
  })

  it("produces frozen golden canonical digests", () => {
    const prepared = prepareDryRunCapacityRepairCommand({
      request_id: "request-1",
      actor: "operator-1",
      reason: "reason-1",
      ticket: "ticket-1",
      statement_timeout_ms: 1_000,
      batch_size: 25,
    })
    expect(prepared.request_identity_digest).toBe(
      "77ae1b3fa80420f4def3383f397e9db48f291eff727b5a3bf06e2a572cf59b38"
    )
    expect(prepared.command_digest).toBe(
      "fd6e3326bb8eeef39b69e832a9640a6709ac8cf8fa14e0f82cfc80b67a720081"
    )
    expect(repairPlanDigest({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    )
    expect(repairPlanDigest({ z: [{ b: 2, a: 1 }], a: { é: 1, e: 2 } })).toBe(
      "53fc0c872cdf188b94691bdb6e2e15fb375ae2cf20a0487bca493b89b1afda6b"
    )
    expect(repairPlanDigest({ ordered: [2, 1] })).not.toBe(
      repairPlanDigest({ ordered: [1, 2] })
    )
    expect(() => repairPlanDigest({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "safe integers"
    )
  })

  it("retries only the exact identity unique violation", () => {
    expect(
      isRepairIdentityUniqueViolation({
        code: "23505",
        constraint: "IDX_flash_sale_capacity_repair_identity_digest_unique",
      })
    ).toBe(true)
    expect(
      isRepairIdentityUniqueViolation({
        code: "23505",
        constraint: "some_other_unique_index",
      })
    ).toBe(false)
    expect(
      isRepairIdentityUniqueViolation({
        code: "40001",
        constraint: "IDX_flash_sale_capacity_repair_identity_digest_unique",
      })
    ).toBe(false)
  })

  it.each([
    {},
    { request_id: "a", idempotency_key: "b", actor: "x", reason: "y", ticket: "z" },
    { request_id: "a", actor: "", reason: "y", ticket: "z" },
    { request_id: "a", actor: "x", reason: " y", ticket: "z" },
    { request_id: "a", actor: "x", reason: "y", ticket: "z", unknown: true },
    { request_id: "a", actor: "x", reason: "y", ticket: "z", batch_size: 0 },
  ])("rejects unsafe command %#", (command) => {
    expect(() =>
      prepareDryRunCapacityRepairCommand(command as never)
    ).toThrow(AllocationCommandError)
  })
})
