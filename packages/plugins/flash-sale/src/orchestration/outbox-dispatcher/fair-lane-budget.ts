export type FlashSaleOutboxLane = "allocation" | "checkout"

export class FairLaneBudgetConfigError extends Error {
  constructor() {
    super("Fair lane budget configuration is invalid")
    this.name = "FairLaneBudgetConfigError"
  }
}

export class FairLaneBudgetAllocator {
  private cursor = 0
  constructor(
    private readonly concurrency: number,
    private readonly lanes: readonly FlashSaleOutboxLane[]
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || lanes.length < 1) {
      throw new FairLaneBudgetConfigError()
    }
  }

  next(): Readonly<Record<FlashSaleOutboxLane, number>> {
    const result: Record<FlashSaleOutboxLane, number> = {
      allocation: 0,
      checkout: 0,
    }
    if (this.concurrency >= this.lanes.length) {
      for (const lane of this.lanes) result[lane] = 1
      let remaining = this.concurrency - this.lanes.length
      let offset = this.cursor
      while (remaining > 0) {
        result[this.lanes[offset % this.lanes.length]] += 1
        offset += 1
        remaining -= 1
      }
    } else {
      for (let index = 0; index < this.concurrency; index += 1) {
        result[this.lanes[(this.cursor + index) % this.lanes.length]] += 1
      }
    }
    this.cursor = (this.cursor + 1) % this.lanes.length
    return Object.freeze(result)
  }
}
