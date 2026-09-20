import {
  AllocationCommandErrorCode,
  AllocationReconciliationStore,
  DEFAULT_RECONCILIATION_SAMPLE_LIMIT,
  ReconcileAllocationHandler,
} from ".."

describe("ReconcileAllocationHandler", () => {
  const result = {
    snapshot_at: new Date("2030-01-01T00:00:00.000Z"),
    healthy: true,
    skipped: false,
    skip_reason: null,
    issue_count: 0,
    counts: {},
    samples: [],
  }

  it("applies the default bound and forwards the optional campaign", async () => {
    const reconcileAllocation = jest.fn().mockResolvedValue(result)
    const handler = new ReconcileAllocationHandler({
      reconcileAllocation,
    } as AllocationReconciliationStore)

    await expect(
      handler.execute({ campaign_id: "campaign-1" })
    ).resolves.toEqual(result)
    expect(reconcileAllocation).toHaveBeenCalledWith({
      campaign_id: "campaign-1",
      sample_limit: DEFAULT_RECONCILIATION_SAMPLE_LIMIT,
    })
  })

  it("accepts empty plain and null-prototype data objects", async () => {
    const reconcileAllocation = jest.fn().mockResolvedValue(result)
    const handler = new ReconcileAllocationHandler({
      reconcileAllocation,
    } as AllocationReconciliationStore)
    const nullPrototype = Object.assign(Object.create(null), {
      campaign_id: "campaign-null-prototype",
      sample_limit: 3,
    })

    await handler.execute({})
    await handler.execute(nullPrototype)
    expect(reconcileAllocation).toHaveBeenNthCalledWith(1, {
      campaign_id: undefined,
      sample_limit: DEFAULT_RECONCILIATION_SAMPLE_LIMIT,
    })
    expect(reconcileAllocation).toHaveBeenNthCalledWith(2, {
      campaign_id: "campaign-null-prototype",
      sample_limit: 3,
    })
  })

  it("rejects malformed and non-exact commands before persistence", async () => {
    const reconcileAllocation = jest.fn()
    const handler = new ReconcileAllocationHandler({
      reconcileAllocation,
    } as AllocationReconciliationStore)
    const symbolCommand = Object.assign({}, { [Symbol("hidden")]: true })
    const nonEnumerableCommand = Object.defineProperty({}, "hidden", {
      value: true,
      enumerable: false,
    })
    const nonEnumerableAllowed = Object.defineProperty({}, "campaign_id", {
      value: "campaign-hidden",
      enumerable: false,
    })
    let getterReads = 0
    const accessorCommand = Object.defineProperty({}, "campaign_id", {
      get: () => {
        getterReads++
        return "campaign-accessor"
      },
      enumerable: true,
    })
    class CustomCommand {
      campaign_id = "campaign-class"
    }
    const inheritedCommand = Object.create({ campaign_id: "campaign-parent" })
    const candidates = [
      null,
      [],
      { unknown: true },
      { campaign_id: "" },
      { campaign_id: "   " },
      { sample_limit: 0 },
      { sample_limit: 101 },
      { sample_limit: 1.5 },
      symbolCommand,
      nonEnumerableCommand,
      nonEnumerableAllowed,
      accessorCommand,
      new CustomCommand(),
      inheritedCommand,
    ]

    for (const candidate of candidates) {
      await expect(handler.execute(candidate as never)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    }
    expect(getterReads).toBe(0)
    expect(reconcileAllocation).not.toHaveBeenCalled()
  })
})
