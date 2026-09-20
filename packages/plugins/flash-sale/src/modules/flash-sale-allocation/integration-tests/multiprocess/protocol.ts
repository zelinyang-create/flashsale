import {
  ClaimAndHoldQuotaCommand,
  ExpireDueQuotaCommand,
  ExpireQuotaCommand,
  SettlementQuotaCommand,
} from "../../application"

export type MultiprocessOperation =
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
      kind: "fatal"
      id?: number
      message: string
    }>

export const MULTIPROCESS_PROTOCOL_PREFIX = "FLASH_SALE_MP "
