import {
  AllocationCommandErrorCode,
  AllocationQuotaStore,
  BeginQuotaSettlementHandler,
  AuthorizeQuotaSettlementHandler,
  ConsumeQuotaSettlementHandler,
  CancelHeldQuotaHandler,
  ReleaseQuotaSettlementHandler,
} from ".."

describe("quota settlement command boundary", () => {
  const result = {
    attempt: { id: "attempt" },
    holds: [],
    replayed: false,
  } as never
  const store = {
    cancelHeldQuota: jest.fn().mockResolvedValue(result),
    beginQuotaSettlement: jest.fn().mockResolvedValue(result),
    authorizeQuotaSettlement: jest.fn().mockResolvedValue(result),
    consumeQuotaSettlement: jest.fn().mockResolvedValue(result),
    releaseQuotaSettlement: jest.fn().mockResolvedValue(result),
  } as unknown as AllocationQuotaStore

  beforeEach(() => jest.clearAllMocks())

  it("accepts only attempt_id for held cancellation", async () => {
    const handler = new CancelHeldQuotaHandler(store)
    await expect(handler.execute({ attempt_id: "attempt" })).resolves.toBe(
      result
    )
    expect(store.cancelHeldQuota).toHaveBeenCalledWith({
      attempt_id: "attempt",
    })

    await expect(
      handler.execute({ attempt_id: "attempt", raw_key: "secret" } as never)
    ).rejects.toMatchObject({
      code: AllocationCommandErrorCode.INVALID_COMMAND,
    })
    await expect(handler.execute({ attempt_id: "" })).rejects.toMatchObject({
      code: AllocationCommandErrorCode.INVALID_COMMAND,
    })
  })

  it.each([
    ["begin", new BeginQuotaSettlementHandler(store), "beginQuotaSettlement"],
    [
      "consume",
      new ConsumeQuotaSettlementHandler(store),
      "consumeQuotaSettlement",
    ],
    [
      "authorize",
      new AuthorizeQuotaSettlementHandler(store),
      "authorizeQuotaSettlement",
    ],
    [
      "release",
      new ReleaseQuotaSettlementHandler(store),
      "releaseQuotaSettlement",
    ],
  ] as const)(
    "accepts only attempt_id and settlement_id for settlement %s",
    async (_, handler, method) => {
      const command = {
        attempt_id: "attempt",
        settlement_id: "settlement",
      }
      await expect(handler.execute(command)).resolves.toBe(result)
      expect(store[method]).toHaveBeenCalledWith(command)

      await expect(
        handler.execute({ ...command, raw_key: "secret" } as never)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      await expect(
        handler.execute({ ...command, settlement_id: "" })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      await expect(
        handler.execute({ attempt_id: "attempt" } as never)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      await expect(
        handler.execute({ ...command, settlement_id: " " })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      await expect(
        handler.execute({
          ...command,
          settlement_id: "x".repeat(256),
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      await expect(
        handler.execute(Object.assign(Object.create({}), command))
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      const accessor = { ...command }
      Object.defineProperty(accessor, "settlement_id", {
        enumerable: true,
        get: () => "settlement",
      })
      await expect(handler.execute(accessor)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    }
  )
})
