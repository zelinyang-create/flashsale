import {
  AuthorizeCartCompletionCommand,
  AuthorizeCartCompletionResult,
  CancelExecutionCommand,
  CheckoutExecutionStore,
  CheckoutExecutionSnapshot,
  ClaimCommerceLeaseCommand,
  ClaimCommerceLeaseResult,
  CompleteExecutionCommand,
  PrepareExecutionCommand,
  PrepareExecutionResult,
  FindExecutionForCartCommand,
  ReadCartCompletionAuthorizationCommand,
  ReadExecutionReplayCommand,
  RecordCommerceDefinitiveFailureCommand,
  RecordCommerceSucceededCommand,
  RecordCommerceUnknownCommand,
  TransitionExecutionResult,
  prepareAuthorizeCommand,
  prepareCancelExecutionCommand,
  prepareClaimLeaseCommand,
  prepareCompleteExecutionCommand,
  prepareExecutionCommand,
  prepareFindExecutionForCartCommand,
  prepareReadAuthorizationCommand,
  prepareReadExecutionReplayCommand,
  prepareRecordCommerceDefinitiveFailureCommand,
  prepareRecordCommerceSucceededCommand,
  prepareRecordCommerceUnknownCommand,
} from "../domain"

export class PrepareExecutionHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: PrepareExecutionCommand
  ): Promise<PrepareExecutionResult> {
    return await this.store.prepareExecution(prepareExecutionCommand(command))
  }
}

export class FindExecutionForCartHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: FindExecutionForCartCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.store.findExecutionForCart(
      prepareFindExecutionForCartCommand(command)
    )
  }
}

export class ClaimCommerceLeaseHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: ClaimCommerceLeaseCommand
  ): Promise<ClaimCommerceLeaseResult> {
    return await this.store.claimCommerceLease(
      prepareClaimLeaseCommand(command)
    )
  }
}

export class AuthorizeCartCompletionHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: AuthorizeCartCompletionCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.store.authorizeCartCompletion(
      prepareAuthorizeCommand(command)
    )
  }
}

export class ReadCartCompletionAuthorizationHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: ReadCartCompletionAuthorizationCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.store.readCartCompletionAuthorization(
      prepareReadAuthorizationCommand(command)
    )
  }
}

export class RecordCommerceSucceededHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: RecordCommerceSucceededCommand
  ): Promise<TransitionExecutionResult> {
    return await this.store.recordCommerceSucceeded(
      prepareRecordCommerceSucceededCommand(command)
    )
  }
}

export class RecordCommerceDefinitiveFailureHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: RecordCommerceDefinitiveFailureCommand
  ): Promise<TransitionExecutionResult> {
    return await this.store.recordCommerceDefinitiveFailure(
      prepareRecordCommerceDefinitiveFailureCommand(command)
    )
  }
}

export class RecordCommerceUnknownHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: RecordCommerceUnknownCommand
  ): Promise<TransitionExecutionResult> {
    return await this.store.recordCommerceUnknown(
      prepareRecordCommerceUnknownCommand(command)
    )
  }
}

export class CompleteExecutionHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: CompleteExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.store.completeExecution(
      prepareCompleteExecutionCommand(command)
    )
  }
}

export class CancelExecutionHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: CancelExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.store.cancelExecution(
      prepareCancelExecutionCommand(command)
    )
  }
}

export class ReadExecutionReplayHandler {
  constructor(private readonly store: CheckoutExecutionStore) {}

  async execute(
    command: ReadExecutionReplayCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.store.readExecutionReplay(
      prepareReadExecutionReplayCommand(command)
    )
  }
}
