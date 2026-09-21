import { FairLaneBudgetAllocator } from "../fair-lane-budget"

describe("multi-module outbox fairness", () => {
  it("alternates enabled lanes deterministically when C=1", () => {
    const allocator = new FairLaneBudgetAllocator(1, ["allocation", "checkout"])
    expect([allocator.next(), allocator.next(), allocator.next(), allocator.next()]).toEqual([
      { allocation: 1, checkout: 0 },
      { allocation: 0, checkout: 1 },
      { allocation: 1, checkout: 0 },
      { allocation: 0, checkout: 1 },
    ])
  })

  it("gives every enabled lane one slot and rotates leftovers", () => {
    const allocator = new FairLaneBudgetAllocator(3, ["allocation", "checkout"])
    expect(allocator.next()).toEqual({ allocation: 2, checkout: 1 })
    expect(allocator.next()).toEqual({ allocation: 1, checkout: 2 })
  })

  it("never exceeds the global concurrency", () => {
    const allocator = new FairLaneBudgetAllocator(32, ["allocation", "checkout"])
    for (let index = 0; index < 100; index += 1) {
      const budget = allocator.next()
      expect(budget.allocation + budget.checkout).toBe(32)
      expect(Math.min(budget.allocation, budget.checkout)).toBeGreaterThanOrEqual(1)
    }
  })
})
