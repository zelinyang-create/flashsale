import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import type { DAL } from "@medusajs/framework/types"
import {
  CHECKOUT_OUTBOX_AGGREGATE_TYPE,
  CHECKOUT_OUTBOX_SCHEMA_VERSION,
  canonicalJson,
  compareUtf16CodeUnits,
  hashCheckoutEventIdentity,
  normalizeCheckoutEventWireEnvelope,
} from "../../../shared"
import { CheckoutExecutionState } from "../../../types"
import {
  CheckoutOutboxIssueCode,
  CheckoutOutboxReconciliationStore,
  ReconcileCheckoutOutboxResult,
  checkoutOutboxEventNameFor,
  sanitizeCheckoutOutboxErrorCode,
} from "../domain"

type Execution = {
  id: string
  attempt_id: string
  campaign_id: string
  rules_version: number | string
  state: CheckoutExecutionState
  order_id: string | null
  last_error_code: string | null
  business_version: number | string
  outbox_stream_started: boolean
  business_changed_at: Date | string | null
  created_at: Date | string
}
type Event = {
  id: string
  event_name: string
  schema_version: number | string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: number | string
  event_hash: string
  occurred_at: Date | string
  payload: Record<string, unknown> | string
}

const ALLOWED = new Set([
  "prepared>commerce_pending",
  "commerce_pending>commerce_succeeded",
  "commerce_pending>commerce_definitive_failed",
  "commerce_pending>commerce_unknown",
  "commerce_unknown>commerce_pending",
  "commerce_succeeded>completed",
  "commerce_definitive_failed>canceled",
])

export class PostgresCheckoutOutboxReconciliationStore
  implements CheckoutOutboxReconciliationStore {
  constructor(private readonly baseRepository: DAL.RepositoryService) {}

  async reconcileCheckoutOutbox(input: {
    execution_id?: string
    sample_limit: number
  }): Promise<ReconcileCheckoutOutboxResult> {
    return await this.baseRepository.transaction<SqlEntityManager>(async (manager) => {
      await manager.execute("set transaction isolation level repeatable read read only")
      await manager.execute("set local statement_timeout = '5s'")
      const clock = (await manager.execute(
        "select transaction_timestamp() as snapshot_at"
      )) as Array<{ snapshot_at: Date | string }>
      const controls = (await manager.execute(
        `select required_after from flash_sale_checkout_outbox_control
          where id = 'checkout-outbox-required' and deleted_at is null`
      )) as Array<{ required_after: Date | string }>
      const requiredAfter = controls[0] ? new Date(controls[0].required_after) : null
      const executions = (await manager.execute(
        `select id, attempt_id, campaign_id, rules_version, state, order_id,
                last_error_code, business_version, outbox_stream_started,
                business_changed_at, created_at
           from flash_sale_checkout_execution
          where deleted_at is null ${input.execution_id ? "and id = ?" : ""}
          order by id`,
        input.execution_id ? [input.execution_id] : []
      )) as Execution[]
      const counts: Partial<Record<CheckoutOutboxIssueCode, number>> = {}
      const samples: Array<{ code: CheckoutOutboxIssueCode; execution_id: string }> = []
      let issueCount = 0
      const issue = (code: CheckoutOutboxIssueCode, id: string) => {
        counts[code] = (counts[code] ?? 0) + 1
        issueCount += 1
        if (samples.length < input.sample_limit) samples.push({ code, execution_id: id })
      }

      for (const execution of executions) {
        const version = Number(execution.business_version)
        if (!execution.outbox_stream_started) {
          if (version !== 0 || execution.business_changed_at ||
              (requiredAfter && new Date(execution.created_at) >= requiredAfter)) {
            issue("OUTBOX_STREAM_MISSING", execution.id)
          }
          continue
        }
        const items = (await manager.execute(
          `select campaign_item_id, variant_id, quantity
             from flash_sale_checkout_execution_item
            where execution_id = ? and deleted_at is null
            order by campaign_item_id, variant_id`, [execution.id]
        )) as Array<{ campaign_item_id: string; variant_id: string; quantity: number | string }>
        const events = (await manager.execute(
          `select id, event_name, schema_version, aggregate_type, aggregate_id,
                  aggregate_version, event_hash, occurred_at, payload
             from flash_sale_checkout_outbox_event
            where aggregate_id = ? and deleted_at is null
            order by aggregate_version`, [execution.id]
        )) as Event[]
        if (events.some((event) => Number(event.aggregate_version) > version)) {
          issue("OUTBOX_EVENT_AHEAD", execution.id)
        }
        const versions = events.map((event) => Number(event.aggregate_version))
        if (versions.length !== version || versions.some((value, index) => value !== index + 1)) {
          issue("OUTBOX_VERSION_GAP", execution.id)
        }
        let previous: string | null = null
        let historicalDrift = false
        let transitionDrift = false
        for (const event of events) {
          try {
            const normalized = normalizeCheckoutEventWireEnvelope({
              event_id: event.id,
              event_name: event.event_name,
              schema_version: Number(event.schema_version),
              aggregate_type: event.aggregate_type,
              aggregate_id: event.aggregate_id,
              aggregate_version: Number(event.aggregate_version),
              event_hash: event.event_hash,
              occurred_at: new Date(event.occurred_at).toISOString(),
              payload: typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload,
            })
            const state = String(normalized.payload.state)
            if (previous && !ALLOWED.has(`${previous}>${state}`)) transitionDrift = true
            previous = state
          } catch {
            historicalDrift = true
          }
        }
        if (historicalDrift) issue("OUTBOX_EVENT_DRIFT", execution.id)
        if (transitionDrift) issue("OUTBOX_TRANSITION_DRIFT", execution.id)
        const current = events.find((event) => Number(event.aggregate_version) === version)
        if (!current) {
          issue("OUTBOX_CURRENT_EVENT_MISSING", execution.id)
          continue
        }
        const payload = {
          execution_id: execution.id,
          attempt_id: execution.attempt_id,
          campaign_id: execution.campaign_id,
          rules_version: Number(execution.rules_version),
          state: execution.state,
          items: items.map((item) => ({
            campaign_item_id: item.campaign_item_id,
            variant_id: item.variant_id,
            quantity: Number(item.quantity),
          })).sort((left, right) => {
            const byCampaign = compareUtf16CodeUnits(left.campaign_item_id, right.campaign_item_id)
            return byCampaign || compareUtf16CodeUnits(left.variant_id, right.variant_id)
          }),
          ...(execution.state === CheckoutExecutionState.COMMERCE_SUCCEEDED ||
          execution.state === CheckoutExecutionState.COMPLETED
            ? { order_id: execution.order_id! } : {}),
          ...(execution.state === CheckoutExecutionState.COMMERCE_DEFINITIVE_FAILED ||
          execution.state === CheckoutExecutionState.COMMERCE_UNKNOWN ||
          execution.state === CheckoutExecutionState.CANCELED
            ? { error_code: sanitizeCheckoutOutboxErrorCode(
                execution.last_error_code ?? "CHECKOUT_ERROR_UNCLASSIFIED") } : {}),
        }
        const identity = {
          event_name: checkoutOutboxEventNameFor(execution.state),
          schema_version: CHECKOUT_OUTBOX_SCHEMA_VERSION,
          aggregate_type: CHECKOUT_OUTBOX_AGGREGATE_TYPE,
          aggregate_id: execution.id,
          aggregate_version: version,
          payload,
        } as const
        const currentPayload = typeof current.payload === "string"
          ? JSON.parse(current.payload) : current.payload
        if (current.event_name !== identity.event_name ||
            current.event_hash !== hashCheckoutEventIdentity(identity) ||
            canonicalJson(currentPayload) !== canonicalJson(payload) ||
            previous !== execution.state) {
          issue("OUTBOX_EVENT_DRIFT", execution.id)
        }
      }
      return {
        snapshot_at: new Date(clock[0].snapshot_at),
        healthy: issueCount === 0,
        issue_count: issueCount,
        counts,
        samples,
      }
    })
  }
}
