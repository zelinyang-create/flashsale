import {
  ActivateAllocationMovementLedgerCommand,
  ClaimAndHoldQuotaCommand,
  ClaimAllocationOutboxEventsCommand,
  ExpireDueQuotaCommand,
  ExpireQuotaCommand,
  FailAllocationOutboxEventCommand,
  MarkAllocationOutboxPublishedCommand,
  ProvisionAllocationCommand,
  SettlementQuotaCommand,
} from "../../application"
import { AllocationFaultPoint } from "../../persistence"

export type MultiprocessOperation =
  | Readonly<{
      kind: "activate_movement_ledger"
      command: ActivateAllocationMovementLedgerCommand
    }>
  | Readonly<{
      kind: "provision_allocation"
      command: ProvisionAllocationCommand
    }>
  | Readonly<{
      kind: "claim_and_hold"
      command: ClaimAndHoldQuotaCommand
    }>
  | Readonly<{
      kind: "consume_settlement"
      command: SettlementQuotaCommand
    }>
  | Readonly<{
      kind: "release_settlement"
      command: SettlementQuotaCommand
    }>
  | Readonly<{
      kind: "expire"
      command: ExpireQuotaCommand
    }>
  | Readonly<{
      kind: "expire_due"
      command: ExpireDueQuotaCommand
    }>
  | Readonly<{
      kind: "claim_outbox"
      command: ClaimAllocationOutboxEventsCommand
    }>
  | Readonly<{
      kind: "mark_outbox_published"
      command: MarkAllocationOutboxPublishedCommand
    }>
  | Readonly<{
      kind: "fail_outbox"
      command: FailAllocationOutboxEventCommand
    }>

export type MultiprocessSuccess = Readonly<{
  outcome: "fulfilled"
  attempt_id: string
  attempt_state: string
  hold_states: readonly string[]
  status?: "held" | "rejected"
  error_code?: string
  replayed: boolean
  scanned?: number
  expired?: number
  conflicted?: number
  failed?: number
  failures?: readonly Readonly<{
    attempt_id: string
    error_code: string
  }>[]
  attempt_ids?: readonly string[]
  event_ids?: readonly string[]
  outbox_events?: readonly Readonly<{
    id: string
    lease_epoch: number
    lease_owner: string | null
  }>[]
  disposition?:
    | "published"
    | "retried"
    | "dead_lettered"
    | "redriven"
    | "fenced"
  activation_id?: string
  checkpoint_count?: number
  schema_version?: number
  policy_id?: string
  capacity_ids?: readonly string[]
}>

export type MultiprocessFailure = Readonly<{
  outcome: "rejected"
  error_code?: string
  message: string
}>

export type MultiprocessResult = MultiprocessSuccess | MultiprocessFailure

export type WorkerRequest =
  | Readonly<{
      id: number
      kind: "execute"
      operations: readonly MultiprocessOperation[]
    }>
  | Readonly<{
      id: number
      kind: "execute_until_failpoint"
      operation: MultiprocessOperation
      failpoint: AllocationFaultPoint
    }>
  | Readonly<{
      id: number
      kind: "shutdown"
    }>

export type WorkerResponse =
  | Readonly<{ kind: "ready" }>
  | Readonly<{
      kind: "result"
      id: number
      results: readonly MultiprocessResult[]
    }>
  | Readonly<{
      kind: "failpoint_reached"
      id: number
      failpoint: AllocationFaultPoint
      attempt_id: string
    }>
  | Readonly<{
      kind: "fatal"
      id?: number
      message: string
    }>

export const MULTIPROCESS_PROTOCOL_PREFIX = "FLASH_SALE_MP "
