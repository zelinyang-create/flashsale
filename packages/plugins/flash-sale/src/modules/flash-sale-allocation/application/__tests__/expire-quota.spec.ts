import {
  AllocationCommandErrorCode,
  AllocationQuotaStore,
  ExpireDueQuotaHandler,
  ExpireQuotaHandler,
  MAX_EXPIRY_BATCH_SIZE,
} from ".."

describe("expiry command boundaries", () => {
  const settlement = {
    attempt: { id: "attempt" },
    holds: [],
    replayed: false,
  } as never
  const batch = {
    scanned: 1,
    expired: 1,
    conflicted: 0,
    failed: 0,
    failures: [],
    attempt_ids: ["attempt"],
  }
  const store = {
    expireQuota: jest.fn().mockResolvedValue(settlement),
    expireDueQuota: jest.fn().mockResolvedValue(batch),
  } as unknown as AllocationQuotaStore

  beforeEach(() => jest.clearAllMocks())

  it("accepts exactly one non-empty attempt_id", async () => {
    const handler = new ExpireQuotaHandler(store)
    await expect(handler.execute({ attempt_id: "attempt" })).resolves.toBe(
      settlement
    )
    expect(store.expireQuota).toHaveBeenCalledWith({ attempt_id: "attempt" })
    await expect(
      handler.execute({ attempt_id: "attempt", extra: true } as never)
    ).rejects.toMatchObject({
      code: AllocationCommandErrorCode.INVALID_COMMAND,
    })
  })

  it("requires an exact, bounded positive int32-sized batch", async () => {
    const handler = new ExpireDueQuotaHandler(store)
    await expect(handler.execute({ limit: 25 })).resolves.toBe(batch)
    expect(store.expireDueQuota).toHaveBeenCalledWith({ limit: 25 })
    for (const command of [
      null,
      {},
      { limit: 0 },
      { limit: 1.5 },
      { limit: MAX_EXPIRY_BATCH_SIZE + 1 },
      { limit: 1, extra: true },
    ]) {
      await expect(handler.execute(command as never)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    }
  })
})
