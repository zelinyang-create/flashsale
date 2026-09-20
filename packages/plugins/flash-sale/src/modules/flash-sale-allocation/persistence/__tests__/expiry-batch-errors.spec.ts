import type { DAL } from "@medusajs/framework/types"
import { PostgresAllocationAttemptStore } from ".."

describe("expiry batch infrastructure errors", () => {
  it("propagates a database failure before an attempt can be selected", async () => {
    const infrastructureError = new Error("database connection unavailable")
    const repository = {
      transaction: jest.fn().mockRejectedValue(infrastructureError),
    } as unknown as DAL.RepositoryService
    const store = new PostgresAllocationAttemptStore(repository)

    await expect(store.expireDueQuota({ limit: 1 })).rejects.toBe(
      infrastructureError
    )
  })
})
