import { DAL } from "@medusajs/framework/types"
import { MedusaError, MedusaService } from "@medusajs/framework/utils"
import {
  AuthorizeCartCompletionCommand,
  AuthorizeCartCompletionHandler,
  AuthorizeCartCompletionResult,
  CancelExecutionCommand,
  CancelExecutionHandler,
  ClaimCommerceLeaseCommand,
  ClaimCommerceLeaseHandler,
  ClaimCommerceLeaseResult,
  CompleteExecutionCommand,
  CompleteExecutionHandler,
  CheckoutExecutionSnapshot,
  FindExecutionForCartCommand,
  FindExecutionForCartHandler,
  PrepareExecutionCommand,
  PrepareExecutionHandler,
  PrepareExecutionResult,
  ReadCartCompletionAuthorizationCommand,
  ReadCartCompletionAuthorizationHandler,
  ReadExecutionReplayCommand,
  ReadExecutionReplayHandler,
  RecordCommerceDefinitiveFailureCommand,
  RecordCommerceDefinitiveFailureHandler,
  RecordCommerceSucceededCommand,
  RecordCommerceSucceededHandler,
  RecordCommerceUnknownCommand,
  RecordCommerceUnknownHandler,
  TransitionExecutionResult,
  ActivateCheckoutOutboxCommand,
  ActivateCheckoutOutboxHandler,
  ClaimCheckoutOutboxEventsCommand,
  ClaimCheckoutOutboxEventsHandler,
  ClaimCheckoutOutboxEventsResult,
  MarkCheckoutOutboxPublishedCommand,
  MarkCheckoutOutboxPublishedHandler,
  FailCheckoutOutboxEventCommand,
  FailCheckoutOutboxEventHandler,
  RedriveCheckoutOutboxEventCommand,
  RedriveCheckoutOutboxEventHandler,
  CheckoutOutboxMutationResult,
  ReconcileCheckoutOutboxCommand,
  ReconcileCheckoutOutboxHandler,
  ReconcileCheckoutOutboxResult,
} from "./application"
import {
  CheckoutExecution,
  CheckoutExecutionItem,
  CheckoutOutboxControl,
  CheckoutOutboxEvent,
} from "./models"
import {
  PostgresCheckoutExecutionStore,
  PostgresCheckoutOutboxStore,
  PostgresCheckoutOutboxReconciliationStore,
} from "./persistence"

type InjectedDependencies = {
  baseRepository: DAL.RepositoryService
}

const WRITE_COMMAND_REQUIRED =
  "Direct checkout CRUD is disabled; use a checkout command"

class FlashSaleCheckoutModuleService extends MedusaService({
  CheckoutExecution,
  CheckoutExecutionItem,
  CheckoutOutboxControl,
  CheckoutOutboxEvent,
}) {
  private readonly prepareExecutionHandler_: PrepareExecutionHandler
  private readonly claimCommerceLeaseHandler_: ClaimCommerceLeaseHandler
  private readonly authorizeCartCompletionHandler_: AuthorizeCartCompletionHandler
  private readonly readCartCompletionAuthorizationHandler_: ReadCartCompletionAuthorizationHandler
  private readonly findExecutionForCartHandler_: FindExecutionForCartHandler
  private readonly recordCommerceSucceededHandler_: RecordCommerceSucceededHandler
  private readonly recordCommerceDefinitiveFailureHandler_: RecordCommerceDefinitiveFailureHandler
  private readonly recordCommerceUnknownHandler_: RecordCommerceUnknownHandler
  private readonly completeExecutionHandler_: CompleteExecutionHandler
  private readonly cancelExecutionHandler_: CancelExecutionHandler
  private readonly readExecutionReplayHandler_: ReadExecutionReplayHandler
  private readonly activateCheckoutOutboxHandler_: ActivateCheckoutOutboxHandler
  private readonly claimCheckoutOutboxEventsHandler_: ClaimCheckoutOutboxEventsHandler
  private readonly markCheckoutOutboxPublishedHandler_: MarkCheckoutOutboxPublishedHandler
  private readonly failCheckoutOutboxEventHandler_: FailCheckoutOutboxEventHandler
  private readonly redriveCheckoutOutboxEventHandler_: RedriveCheckoutOutboxEventHandler
  private readonly reconcileCheckoutOutboxHandler_: ReconcileCheckoutOutboxHandler

  constructor({ baseRepository }: InjectedDependencies) {
    super(...arguments)
    const store = new PostgresCheckoutExecutionStore(baseRepository)
    const outboxStore = new PostgresCheckoutOutboxStore(baseRepository)
    const reconciliationStore = new PostgresCheckoutOutboxReconciliationStore(baseRepository)
    this.prepareExecutionHandler_ = new PrepareExecutionHandler(store)
    this.claimCommerceLeaseHandler_ = new ClaimCommerceLeaseHandler(store)
    this.authorizeCartCompletionHandler_ = new AuthorizeCartCompletionHandler(
      store
    )
    this.readCartCompletionAuthorizationHandler_ =
      new ReadCartCompletionAuthorizationHandler(store)
    this.findExecutionForCartHandler_ = new FindExecutionForCartHandler(store)
    this.recordCommerceSucceededHandler_ = new RecordCommerceSucceededHandler(
      store
    )
    this.recordCommerceDefinitiveFailureHandler_ =
      new RecordCommerceDefinitiveFailureHandler(store)
    this.recordCommerceUnknownHandler_ = new RecordCommerceUnknownHandler(store)
    this.completeExecutionHandler_ = new CompleteExecutionHandler(store)
    this.cancelExecutionHandler_ = new CancelExecutionHandler(store)
    this.readExecutionReplayHandler_ = new ReadExecutionReplayHandler(store)
    this.activateCheckoutOutboxHandler_ = new ActivateCheckoutOutboxHandler(outboxStore)
    this.claimCheckoutOutboxEventsHandler_ = new ClaimCheckoutOutboxEventsHandler(outboxStore)
    this.markCheckoutOutboxPublishedHandler_ = new MarkCheckoutOutboxPublishedHandler(outboxStore)
    this.failCheckoutOutboxEventHandler_ = new FailCheckoutOutboxEventHandler(outboxStore)
    this.redriveCheckoutOutboxEventHandler_ = new RedriveCheckoutOutboxEventHandler(outboxStore)
    this.reconcileCheckoutOutboxHandler_ = new ReconcileCheckoutOutboxHandler(reconciliationStore)
  }

  async prepareExecution(
    command: PrepareExecutionCommand
  ): Promise<PrepareExecutionResult> {
    return await this.prepareExecutionHandler_.execute(command)
  }

  async claimCommerceLease(
    command: ClaimCommerceLeaseCommand
  ): Promise<ClaimCommerceLeaseResult> {
    return await this.claimCommerceLeaseHandler_.execute(command)
  }

  async authorizeCartCompletion(
    command: AuthorizeCartCompletionCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.authorizeCartCompletionHandler_.execute(command)
  }

  async readCartCompletionAuthorization(
    command: ReadCartCompletionAuthorizationCommand
  ): Promise<AuthorizeCartCompletionResult> {
    return await this.readCartCompletionAuthorizationHandler_.execute(command)
  }

  async findExecutionForCart(
    command: FindExecutionForCartCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.findExecutionForCartHandler_.execute(command)
  }

  async recordCommerceSucceeded(
    command: RecordCommerceSucceededCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceSucceededHandler_.execute(command)
  }

  async recordCommerceDefinitiveFailure(
    command: RecordCommerceDefinitiveFailureCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceDefinitiveFailureHandler_.execute(command)
  }

  async recordCommerceUnknown(
    command: RecordCommerceUnknownCommand
  ): Promise<TransitionExecutionResult> {
    return await this.recordCommerceUnknownHandler_.execute(command)
  }

  async completeExecution(
    command: CompleteExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.completeExecutionHandler_.execute(command)
  }

  async cancelExecution(
    command: CancelExecutionCommand
  ): Promise<TransitionExecutionResult> {
    return await this.cancelExecutionHandler_.execute(command)
  }

  async readExecutionReplay(
    command: ReadExecutionReplayCommand
  ): Promise<CheckoutExecutionSnapshot | null> {
    return await this.readExecutionReplayHandler_.execute(command)
  }

  async activateCheckoutOutbox(command: ActivateCheckoutOutboxCommand) {
    return await this.activateCheckoutOutboxHandler_.execute(command)
  }

  async claimCheckoutOutboxEvents(
    command: ClaimCheckoutOutboxEventsCommand
  ): Promise<ClaimCheckoutOutboxEventsResult> {
    return await this.claimCheckoutOutboxEventsHandler_.execute(command)
  }

  async markCheckoutOutboxPublished(
    command: MarkCheckoutOutboxPublishedCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.markCheckoutOutboxPublishedHandler_.execute(command)
  }

  async failCheckoutOutboxEvent(
    command: FailCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.failCheckoutOutboxEventHandler_.execute(command)
  }

  async redriveCheckoutOutboxEvent(
    command: RedriveCheckoutOutboxEventCommand
  ): Promise<CheckoutOutboxMutationResult> {
    return await this.redriveCheckoutOutboxEventHandler_.execute(command)
  }

  async reconcileCheckoutOutbox(
    command: ReconcileCheckoutOutboxCommand
  ): Promise<ReconcileCheckoutOutboxResult> {
    return await this.reconcileCheckoutOutboxHandler_.execute(command)
  }

  private rejectDirectWrite(): never {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      WRITE_COMMAND_REQUIRED
    )
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async createCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async updateCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async deleteCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async softDeleteCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async restoreCheckoutExecutions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async createCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async updateCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async deleteCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async softDeleteCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async restoreCheckoutExecutionItems(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated write method is intentionally disabled.
  async createCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async updateCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }
  async upsertCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async deleteCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async softDeleteCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async restoreCheckoutOutboxEvents(): Promise<never> { return this.rejectDirectWrite() }

  // @ts-expect-error Generated write method is intentionally disabled.
  async createCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async updateCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
  async upsertCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async deleteCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async softDeleteCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
  // @ts-expect-error Generated write method is intentionally disabled.
  async restoreCheckoutOutboxControls(): Promise<never> { return this.rejectDirectWrite() }
}

export { WRITE_COMMAND_REQUIRED }
export default FlashSaleCheckoutModuleService
