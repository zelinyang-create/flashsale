import { DAL } from "@medusajs/framework/types"
import { MedusaError, MedusaService } from "@medusajs/framework/utils"
import {
  ClaimAndHoldQuotaCommand,
  ClaimAndHoldQuotaHandler,
  ClaimAttemptCommand,
  ClaimAttemptHandler,
  ClaimAttemptResult,
  HoldQuotaCommand,
  HoldQuotaHandler,
  HoldQuotaResult,
  CancelHeldQuotaHandler,
  CancelHeldQuotaCommand,
  ExpireQuotaCommand,
  SettleQuotaResult,
  SettlementQuotaCommand,
  BeginQuotaSettlementHandler,
  AuthorizeQuotaSettlementHandler,
  ConsumeQuotaSettlementHandler,
  ReleaseQuotaSettlementHandler,
  ProvisionAllocationCommand,
  ProvisionAllocationHandler,
  AllocationControlResult,
  OpenAllocationHandler,
  CloseAllocationHandler,
  TransitionAllocationCommand,
  AllocationCampaignFenceResult,
  FenceAndCloseCampaignAllocationCommand,
  FenceAndCloseCampaignAllocationHandler,
  ExpireDueQuotaCommand,
  ExpireDueQuotaHandler,
  ExpireDueQuotaResult,
  ExpireQuotaHandler,
  ReconcileAllocationCommand,
  ReconcileAllocationHandler,
  ReconcileAllocationResult,
  ActivateAllocationOutboxCommand,
  ActivateAllocationOutboxHandler,
  ActivateAllocationOutboxResult,
  ClaimAllocationOutboxEventsCommand,
  ClaimAllocationOutboxEventsHandler,
  ClaimAllocationOutboxEventsResult,
  MarkAllocationOutboxPublishedCommand,
  MarkAllocationOutboxPublishedHandler,
  FailAllocationOutboxEventCommand,
  FailAllocationOutboxEventHandler,
  RedriveAllocationOutboxEventCommand,
  RedriveAllocationOutboxEventHandler,
  AllocationOutboxMutationResult,
  ActivateAllocationMovementLedgerCommand,
  ActivateAllocationMovementLedgerHandler,
  ActivateAllocationMovementLedgerResult,
  ReconcileMovementLedgerCommand,
  ReconcileMovementLedgerHandler,
  ReconcileMovementLedgerResult,
  DryRunCapacityRepairCommand,
  DryRunCapacityRepairHandler,
  DryRunCapacityRepairResult,
} from "./application"
import {
  AllocationCampaignFence,
  AllocationHold,
  AllocationOutboxControl,
  AllocationOutboxEvent,
  AllocationPolicy,
  Capacity,
  CapacityRepairAction,
  CapacityRepairApplyAction,
  CapacityRepairApplyIdentity,
  CapacityRepairApplyRun,
  CapacityRepairIdentity,
  CapacityRepairRun,
  CapacityMovement,
  CapacityMovementCheckpoint,
  CapacityMovementControl,
  PurchaseAttempt,
  SubjectAllocation,
} from "./models"
import {
  PostgresAllocationAttemptStore,
  PostgresAllocationOutboxStore,
  PostgresAllocationReconciliationStore,
  PostgresCapacityMovementLedgerStore,
  PostgresMovementLedgerReconciliationStore,
  PostgresCapacityRepairPlanStore,
} from "./persistence"

type InjectedDependencies = {
  baseRepository: DAL.RepositoryService
}

const WRITE_COMMAND_REQUIRED =
  "Direct allocation CRUD is disabled; use an allocation command"

class FlashSaleAllocationModuleService extends MedusaService({
  AllocationCampaignFence,
  AllocationOutboxControl,
  AllocationOutboxEvent,
  AllocationPolicy,
  Capacity,
  CapacityRepairAction,
  CapacityRepairApplyAction,
  CapacityRepairApplyIdentity,
  CapacityRepairApplyRun,
  CapacityRepairIdentity,
  CapacityRepairRun,
  CapacityMovement,
  CapacityMovementCheckpoint,
  CapacityMovementControl,
  PurchaseAttempt,
  AllocationHold,
  SubjectAllocation,
}) {
  private readonly claimAttemptHandler_: ClaimAttemptHandler
  private readonly holdQuotaHandler_: HoldQuotaHandler
  private readonly claimAndHoldQuotaHandler_: ClaimAndHoldQuotaHandler
  private readonly cancelHeldQuotaHandler_: CancelHeldQuotaHandler
  private readonly beginQuotaSettlementHandler_: BeginQuotaSettlementHandler
  private readonly authorizeQuotaSettlementHandler_: AuthorizeQuotaSettlementHandler
  private readonly consumeQuotaSettlementHandler_: ConsumeQuotaSettlementHandler
  private readonly releaseQuotaSettlementHandler_: ReleaseQuotaSettlementHandler
  private readonly expireQuotaHandler_: ExpireQuotaHandler
  private readonly expireDueQuotaHandler_: ExpireDueQuotaHandler
  private readonly provisionAllocationHandler_: ProvisionAllocationHandler
  private readonly openAllocationHandler_: OpenAllocationHandler
  private readonly closeAllocationHandler_: CloseAllocationHandler
  private readonly fenceAndCloseCampaignAllocationHandler_: FenceAndCloseCampaignAllocationHandler
  private readonly reconcileAllocationHandler_: ReconcileAllocationHandler
  private readonly activateAllocationOutboxHandler_: ActivateAllocationOutboxHandler
  private readonly claimAllocationOutboxEventsHandler_: ClaimAllocationOutboxEventsHandler
  private readonly markAllocationOutboxPublishedHandler_: MarkAllocationOutboxPublishedHandler
  private readonly failAllocationOutboxEventHandler_: FailAllocationOutboxEventHandler
  private readonly redriveAllocationOutboxEventHandler_: RedriveAllocationOutboxEventHandler
  private readonly activateAllocationMovementLedgerHandler_: ActivateAllocationMovementLedgerHandler
  private readonly reconcileMovementLedgerHandler_: ReconcileMovementLedgerHandler
  private readonly dryRunCapacityRepairHandler_: DryRunCapacityRepairHandler

  constructor({ baseRepository }: InjectedDependencies) {
    super(...arguments)
    const store = new PostgresAllocationAttemptStore(baseRepository)
    this.claimAttemptHandler_ = new ClaimAttemptHandler(store)
    this.holdQuotaHandler_ = new HoldQuotaHandler(store)
    this.claimAndHoldQuotaHandler_ = new ClaimAndHoldQuotaHandler(store)
    this.cancelHeldQuotaHandler_ = new CancelHeldQuotaHandler(store)
    this.beginQuotaSettlementHandler_ = new BeginQuotaSettlementHandler(store)
    this.authorizeQuotaSettlementHandler_ = new AuthorizeQuotaSettlementHandler(
      store
    )
    this.consumeQuotaSettlementHandler_ = new ConsumeQuotaSettlementHandler(
      store
    )
    this.releaseQuotaSettlementHandler_ = new ReleaseQuotaSettlementHandler(
      store
    )
    this.expireQuotaHandler_ = new ExpireQuotaHandler(store)
    this.expireDueQuotaHandler_ = new ExpireDueQuotaHandler(store)
    this.provisionAllocationHandler_ = new ProvisionAllocationHandler(store)
    this.openAllocationHandler_ = new OpenAllocationHandler(store)
    this.closeAllocationHandler_ = new CloseAllocationHandler(store)
    this.fenceAndCloseCampaignAllocationHandler_ =
      new FenceAndCloseCampaignAllocationHandler(store)
    this.reconcileAllocationHandler_ = new ReconcileAllocationHandler(
      new PostgresAllocationReconciliationStore(baseRepository)
    )
    const outboxStore = new PostgresAllocationOutboxStore(baseRepository)
    this.activateAllocationOutboxHandler_ = new ActivateAllocationOutboxHandler(
      outboxStore
    )
    this.claimAllocationOutboxEventsHandler_ =
      new ClaimAllocationOutboxEventsHandler(outboxStore)
    this.markAllocationOutboxPublishedHandler_ =
      new MarkAllocationOutboxPublishedHandler(outboxStore)
    this.failAllocationOutboxEventHandler_ =
      new FailAllocationOutboxEventHandler(outboxStore)
    this.redriveAllocationOutboxEventHandler_ =
      new RedriveAllocationOutboxEventHandler(outboxStore)
    this.activateAllocationMovementLedgerHandler_ =
      new ActivateAllocationMovementLedgerHandler(
        new PostgresCapacityMovementLedgerStore(baseRepository)
      )
    this.reconcileMovementLedgerHandler_ = new ReconcileMovementLedgerHandler(
      new PostgresMovementLedgerReconciliationStore(baseRepository)
    )
    this.dryRunCapacityRepairHandler_ = new DryRunCapacityRepairHandler(
      new PostgresCapacityRepairPlanStore(baseRepository)
    )
  }

  async claimAttempt(
    command: ClaimAttemptCommand
  ): Promise<ClaimAttemptResult> {
    return await this.claimAttemptHandler_.execute(command)
  }

  async holdQuota(command: HoldQuotaCommand): Promise<HoldQuotaResult> {
    return await this.holdQuotaHandler_.execute(command)
  }

  async claimAndHoldQuota(
    command: ClaimAndHoldQuotaCommand
  ): Promise<HoldQuotaResult> {
    return await this.claimAndHoldQuotaHandler_.execute(command)
  }

  async cancelHeldQuota(
    command: CancelHeldQuotaCommand
  ): Promise<SettleQuotaResult> {
    return await this.cancelHeldQuotaHandler_.execute(command)
  }

  async beginQuotaSettlement(
    command: SettlementQuotaCommand
  ): Promise<SettleQuotaResult> {
    return await this.beginQuotaSettlementHandler_.execute(command)
  }

  async consumeQuotaSettlement(
    command: SettlementQuotaCommand
  ): Promise<SettleQuotaResult> {
    return await this.consumeQuotaSettlementHandler_.execute(command)
  }

  async authorizeQuotaSettlement(
    command: SettlementQuotaCommand
  ): Promise<SettleQuotaResult> {
    return await this.authorizeQuotaSettlementHandler_.execute(command)
  }

  async releaseQuotaSettlement(
    command: SettlementQuotaCommand
  ): Promise<SettleQuotaResult> {
    return await this.releaseQuotaSettlementHandler_.execute(command)
  }

  async expireQuota(command: ExpireQuotaCommand): Promise<SettleQuotaResult> {
    return await this.expireQuotaHandler_.execute(command)
  }

  async expireDueQuota(
    command: ExpireDueQuotaCommand
  ): Promise<ExpireDueQuotaResult> {
    return await this.expireDueQuotaHandler_.execute(command)
  }

  async provisionAllocation(
    command: ProvisionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.provisionAllocationHandler_.execute(command)
  }

  async openAllocation(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.openAllocationHandler_.execute(command)
  }

  async closeAllocation(
    command: TransitionAllocationCommand
  ): Promise<AllocationControlResult> {
    return await this.closeAllocationHandler_.execute(command)
  }

  async fenceAndCloseCampaignAllocation(
    command: FenceAndCloseCampaignAllocationCommand
  ): Promise<AllocationCampaignFenceResult> {
    return await this.fenceAndCloseCampaignAllocationHandler_.execute(command)
  }

  async reconcileAllocation(
    command: ReconcileAllocationCommand
  ): Promise<ReconcileAllocationResult> {
    return await this.reconcileAllocationHandler_.execute(command)
  }

  async reconcileMovementLedger(
    command: ReconcileMovementLedgerCommand
  ): Promise<ReconcileMovementLedgerResult> {
    return await this.reconcileMovementLedgerHandler_.execute(command)
  }

  async dryRunCapacityRepair(
    command: DryRunCapacityRepairCommand
  ): Promise<DryRunCapacityRepairResult> {
    return await this.dryRunCapacityRepairHandler_.execute(command)
  }

  async activateAllocationOutbox(
    command: ActivateAllocationOutboxCommand
  ): Promise<ActivateAllocationOutboxResult> {
    return await this.activateAllocationOutboxHandler_.execute(command)
  }

  async claimAllocationOutboxEvents(
    command: ClaimAllocationOutboxEventsCommand
  ): Promise<ClaimAllocationOutboxEventsResult> {
    return await this.claimAllocationOutboxEventsHandler_.execute(command)
  }

  async markAllocationOutboxPublished(
    command: MarkAllocationOutboxPublishedCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.markAllocationOutboxPublishedHandler_.execute(command)
  }

  async failAllocationOutboxEvent(
    command: FailAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.failAllocationOutboxEventHandler_.execute(command)
  }

  async redriveAllocationOutboxEvent(
    command: RedriveAllocationOutboxEventCommand
  ): Promise<AllocationOutboxMutationResult> {
    return await this.redriveAllocationOutboxEventHandler_.execute(command)
  }

  async activateAllocationMovementLedger(
    command: ActivateAllocationMovementLedgerCommand
  ): Promise<ActivateAllocationMovementLedgerResult> {
    return await this.activateAllocationMovementLedgerHandler_.execute(command)
  }

  private rejectDirectWrite(): never {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      WRITE_COMMAND_REQUIRED
    )
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreAllocationPolicies(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreCapacities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createPurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updatePurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertPurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deletePurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeletePurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restorePurchaseAttempts(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreAllocationHolds(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreSubjectAllocations(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreAllocationCampaignFences(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreAllocationOutboxEvents(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreAllocationOutboxControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreCapacityMovements(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreCapacityMovementCheckpoints(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async createCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async updateCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async deleteCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async softDeleteCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error The generated Medusa write method is intentionally disabled.
  async restoreCapacityMovementControls(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async createCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async updateCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async deleteCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async softDeleteCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async restoreCapacityRepairRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async createCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async updateCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async deleteCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async softDeleteCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async restoreCapacityRepairActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async createCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async updateCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async deleteCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async softDeleteCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated audit writes are intentionally disabled.
  async restoreCapacityRepairIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async createCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async updateCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async deleteCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async softDeleteCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async restoreCapacityRepairApplyRuns(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async createCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async updateCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async deleteCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async softDeleteCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async restoreCapacityRepairApplyActions(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async createCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async updateCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  async upsertCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async deleteCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async softDeleteCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }

  // @ts-expect-error Generated append-only audit writes are intentionally disabled.
  async restoreCapacityRepairApplyIdentities(): Promise<never> {
    return this.rejectDirectWrite()
  }
}

export { WRITE_COMMAND_REQUIRED }
export default FlashSaleAllocationModuleService
