import {
  MovementLedgerReconciliationStore,
  ReconcileMovementLedgerHandler,
  prepareReconcileMovementLedgerCommand,
} from ".."

describe("ReconcileMovementLedgerHandler", () => {
  it("normalizes bounded defaults and delegates to the ledger-only store", async () => {
    const result = {
      domain: "movement_ledger" as const,
      snapshot_at: new Date("2026-09-21T00:00:00.000Z"),
      scope: { campaign_id: null },
      status: "not_activated" as const,
      classification: null,
      issue_count: 0,
      issues: [],
      expected_capacities: [],
      subject_counter_derivation: "not_ledger_derived" as const,
    }
    const reconcileMovementLedger = jest.fn().mockResolvedValue(result)
    const handler = new ReconcileMovementLedgerHandler({
      reconcileMovementLedger,
    } as MovementLedgerReconciliationStore)

    await expect(handler.execute({})).resolves.toBe(result)
    expect(reconcileMovementLedger).toHaveBeenCalledWith({
      campaign_id: undefined,
      sample_limit: 20,
      statement_timeout_ms: 5_000,
      batch_size: 500,
    })
  })

  it("preserves an explicit scope and bounded query controls", () => {
    expect(
      prepareReconcileMovementLedgerCommand({
        campaign_id: "campaign-1",
        sample_limit: 7,
        statement_timeout_ms: 1_500,
        batch_size: 9,
      })
    ).toEqual({
      campaign_id: "campaign-1",
      sample_limit: 7,
      statement_timeout_ms: 1_500,
      batch_size: 9,
    })
  })

  it.each([
    [{ unknown: true }],
    [{ campaign_id: " " }],
    [{ sample_limit: 0 }],
    [{ sample_limit: 101 }],
    [{ statement_timeout_ms: 99 }],
    [{ statement_timeout_ms: 30_001 }],
    [{ batch_size: 0 }],
    [{ batch_size: 5_001 }],
  ])("rejects an unsafe command %p", (command) => {
    expect(() =>
      prepareReconcileMovementLedgerCommand(command as never)
    ).toThrow()
  })
})
