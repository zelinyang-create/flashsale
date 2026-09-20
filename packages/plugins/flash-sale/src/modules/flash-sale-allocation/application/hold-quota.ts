import {
  AllocationQuotaStore,
  ClaimAndHoldQuotaCommand,
  HoldQuotaCommand,
  HoldQuotaResult,
} from "./contracts"
import { prepareClaimCommand, prepareHoldCommand } from "./allocation-command"

export class HoldQuotaHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: HoldQuotaCommand): Promise<HoldQuotaResult> {
    return await this.store.holdQuota(prepareHoldCommand(command))
  }
}

export class ClaimAndHoldQuotaHandler {
  constructor(private readonly store: AllocationQuotaStore) {}

  async execute(command: ClaimAndHoldQuotaCommand): Promise<HoldQuotaResult> {
    return await this.store.claimAndHoldQuota(prepareClaimCommand(command))
  }
}
