import {
  AllocationAttemptStore,
  ClaimAttemptCommand,
  ClaimAttemptResult,
} from "./contracts"
import { prepareClaimCommand } from "./allocation-command"

export class ClaimAttemptHandler {
  constructor(private readonly store: AllocationAttemptStore) {}

  async execute(command: ClaimAttemptCommand): Promise<ClaimAttemptResult> {
    return await this.store.claimAttempt(prepareClaimCommand(command))
  }
}
