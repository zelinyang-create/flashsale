import {
  ActivateAllocationMovementLedgerHandler,
  AllocationCommandErrorCode,
  AllocationMovementLedgerStore,
} from "../index"

describe("movement ledger activation command", () => {
  it("passes an exact empty command to the store", async () => {
    const result = {
      activation_id: "activation-1",
      required_after: new Date(0),
      schema_version: 1 as const,
      checkpoint_count: 2,
      replayed: false,
    }
    const store = {
      activateMovementLedger: jest.fn().mockResolvedValue(result),
    } satisfies AllocationMovementLedgerStore
    await expect(
      new ActivateAllocationMovementLedgerHandler(store).execute({})
    ).resolves.toEqual(result)
    expect(store.activateMovementLedger).toHaveBeenCalledWith({})
  })

  it.each([null, [], { extra: true }, Object.create({ inherited: true })])(
    "rejects a non-exact command",
    async (command) => {
      const store = {
        activateMovementLedger: jest.fn(),
      } satisfies AllocationMovementLedgerStore
      await expect(
        new ActivateAllocationMovementLedgerHandler(store).execute(
          command as never
        )
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      expect(store.activateMovementLedger).not.toHaveBeenCalled()
    }
  )
})
