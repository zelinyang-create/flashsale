import { SqlEntityManager } from "@medusajs/framework/mikro-orm/postgresql"
import { DAL } from "@medusajs/framework/types"
import {
  AllocationCommandError,
  AllocationCommandErrorCode,
  AllocationInvariantIssueCode,
  AllocationInvariantSample,
  AllocationReconciliationSkipReason,
  AllocationReconciliationStore,
  ReconcileAllocationCommand,
  ReconcileAllocationResult,
} from "../application"

type AuditRow = {
  issue_count: number | string
  counts: Record<string, number | string> | string | null
  samples: AllocationInvariantSample[] | string | null
}

type SnapshotRow = {
  snapshot_at: Date | string
  isolation_level: string
  read_only: string
  statement_timeout: string
  lock_acquired: boolean
}

export const RECONCILIATION_STATEMENT_TIMEOUT_MS = 30_000

export interface AllocationReconciliationObserver {
  snapshotEstablished?(
    manager: Pick<SqlEntityManager, "execute">
  ): void | Promise<void>
}

const NUMERIC_RAW_MISMATCH = (
  rawColumn: string,
  numericColumn: string
) => `not (case
  when jsonb_typeof(${rawColumn}) = 'object'
   and jsonb_typeof(${rawColumn}->'value') = 'string'
  then case
    when length(${rawColumn}->>'value') <= 100
    then case
      when (${rawColumn}->>'value') ~ '^[0-9]+([.][0-9]+){0,1}$'
      then (${rawColumn}->>'value')::numeric = ${numericColumn}
      else false
    end
    else false
  end
  else false
end)`

const RECONCILIATION_SQL = `
with audit_input as materialized (
  select ?::text as campaign_id, ?::int as sample_limit
),
policies as materialized (
  select p.*
  from flash_sale_allocation_policy p, audit_input i
  where i.campaign_id is null or p.campaign_id = i.campaign_id
),
capacities as materialized (
  select c.*, p.campaign_id as scope_campaign_id,
         p.deleted_at as policy_deleted_at, p.state as policy_state,
         p.rules_version as policy_rules_version
  from flash_sale_capacity c
  left join flash_sale_allocation_policy p on p.id = c.allocation_policy_id
  cross join audit_input i
  where i.campaign_id is null or p.campaign_id = i.campaign_id
),
attempts as materialized (
  select a.*, p.campaign_id as policy_campaign_id,
         p.rules_version as policy_rules_version,
         p.deleted_at as policy_deleted_at
  from flash_sale_purchase_attempt a
  left join flash_sale_allocation_policy p on p.id = a.allocation_policy_id
  cross join audit_input i
  where i.campaign_id is null or a.campaign_id = i.campaign_id
),
holds as materialized (
  select h.*, a.campaign_id as attempt_campaign_id,
         a.allocation_policy_id as attempt_policy_id,
         a.expires_at as attempt_expires_at,
         a.deleted_at as attempt_deleted_at,
         c.allocation_policy_id as capacity_policy_id,
         c.campaign_item_id as capacity_campaign_item_id,
         c.deleted_at as capacity_deleted_at,
         coalesce(a.campaign_id, cp.campaign_id) as scope_campaign_id
  from flash_sale_allocation_hold h
  left join flash_sale_purchase_attempt a on a.id = h.attempt_id
  left join flash_sale_capacity c on c.id = h.capacity_id
  left join flash_sale_allocation_policy cp on cp.id = c.allocation_policy_id
  cross join audit_input i
  where i.campaign_id is null
     or coalesce(a.campaign_id, cp.campaign_id) = i.campaign_id
),
subjects as materialized (
  select s.*
  from flash_sale_subject_allocation s, audit_input i
  where i.campaign_id is null or s.campaign_id = i.campaign_id
),
fences as materialized (
  select f.*
  from flash_sale_allocation_campaign_fence f, audit_input i
  where i.campaign_id is null or f.campaign_id = i.campaign_id
),
capacity_hold_totals as materialized (
  select h.capacity_id,
         coalesce(sum(h.quantity) filter (where h.state = 'held'), 0) as held,
         coalesce(sum(h.quantity) filter (where h.state = 'consumed'), 0) as consumed
  from holds h
  where h.deleted_at is null
  group by h.capacity_id
),
subject_hold_totals as materialized (
  select a.campaign_id, a.subject_id,
         coalesce(sum(h.quantity) filter (where h.state = 'held'), 0) as held,
         coalesce(sum(h.quantity) filter (where h.state = 'consumed'), 0) as consumed
  from attempts a
  join holds h on h.attempt_id = a.id
  where a.deleted_at is null and h.deleted_at is null
  group by a.campaign_id, a.subject_id
),
attempt_hold_totals as materialized (
  select h.attempt_id, count(*)::int as hold_count,
         count(*) filter (where h.state = 'held')::int as held_count,
         count(*) filter (where h.state = 'consumed')::int as consumed_count,
         count(*) filter (where h.state = 'released')::int as released_count,
         count(*) filter (where h.state = 'expired')::int as expired_count
  from holds h
  where h.deleted_at is null
  group by h.attempt_id
),
issues as materialized (
  select '${
    AllocationInvariantIssueCode.CAPACITY_HELD_MISMATCH
  }'::text as issue_code,
         'capacity'::text as entity_type, c.id as entity_id
  from capacities c left join capacity_hold_totals t on t.capacity_id = c.id
  where c.deleted_at is null and c.held_quantity <> coalesce(t.held, 0)
  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_CONSUMED_MISMATCH
  }', 'capacity', c.id
  from capacities c left join capacity_hold_totals t on t.capacity_id = c.id
  where c.deleted_at is null and c.consumed_quantity <> coalesce(t.consumed, 0)
  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_BALANCE_EXCEEDED
  }', 'capacity', c.id
  from capacities c
  where c.deleted_at is null and
        (c.held_quantity < 0 or c.consumed_quantity < 0 or
         c.held_quantity + c.consumed_quantity > c.granted_quantity)
  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_RAW_GRANTED_MISMATCH
  }', 'capacity', c.id
  from capacities c where c.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("c.raw_granted_quantity", "c.granted_quantity")}
  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_RAW_HELD_MISMATCH
  }', 'capacity', c.id
  from capacities c where c.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("c.raw_held_quantity", "c.held_quantity")}
  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_RAW_CONSUMED_MISMATCH
  }', 'capacity', c.id
  from capacities c where c.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("c.raw_consumed_quantity", "c.consumed_quantity")}

  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_HELD_MISMATCH
  }', 'subject', s.id
  from subjects s left join subject_hold_totals t
    on t.campaign_id = s.campaign_id and t.subject_id = s.subject_id
  where s.deleted_at is null and s.held_quantity <> coalesce(t.held, 0)
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_CONSUMED_MISMATCH
  }', 'subject', s.id
  from subjects s left join subject_hold_totals t
    on t.campaign_id = s.campaign_id and t.subject_id = s.subject_id
  where s.deleted_at is null and s.consumed_quantity <> coalesce(t.consumed, 0)
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_BALANCE_EXCEEDED
  }', 'subject', s.id
  from subjects s where s.deleted_at is null and
    (s.held_quantity < 0 or s.consumed_quantity < 0 or
     s.held_quantity + s.consumed_quantity > s.limit_quantity)
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_RAW_LIMIT_MISMATCH
  }', 'subject', s.id
  from subjects s where s.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("s.raw_limit_quantity", "s.limit_quantity")}
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_RAW_HELD_MISMATCH
  }', 'subject', s.id
  from subjects s where s.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("s.raw_held_quantity", "s.held_quantity")}
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_RAW_CONSUMED_MISMATCH
  }', 'subject', s.id
  from subjects s where s.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("s.raw_consumed_quantity", "s.consumed_quantity")}
  union all
  select '${
    AllocationInvariantIssueCode.SUBJECT_ALLOCATION_MISSING
  }', 'attempt', a.id
  from attempts a join attempt_hold_totals t on t.attempt_id = a.id
  where a.deleted_at is null and t.hold_count > 0 and not exists (
    select 1 from subjects s
    where s.campaign_id = a.campaign_id and s.subject_id = a.subject_id
      and s.deleted_at is null
  )

  union all
  select '${AllocationInvariantIssueCode.ATTEMPT_HOLD_MISSING}', 'attempt', a.id
  from attempts a left join attempt_hold_totals t on t.attempt_id = a.id
  where a.deleted_at is null and
        a.state in ('quota_held', 'quota_committing', 'quota_consumed', 'quota_released', 'quota_expired') and
        coalesce(t.hold_count, 0) = 0
  union all
  select '${
    AllocationInvariantIssueCode.ATTEMPT_UNEXPECTED_HOLD
  }', 'attempt', a.id
  from attempts a join attempt_hold_totals t on t.attempt_id = a.id
  where a.deleted_at is null and a.state in ('pending', 'quota_rejected') and t.hold_count > 0
  union all
  select '${
    AllocationInvariantIssueCode.ATTEMPT_HOLD_STATE_MISMATCH
  }', 'attempt', a.id
  from attempts a join attempt_hold_totals t on t.attempt_id = a.id
  where a.deleted_at is null and t.hold_count > 0 and (
    (a.state in ('quota_held', 'quota_committing') and t.held_count <> t.hold_count) or
    (a.state = 'quota_consumed' and t.consumed_count <> t.hold_count) or
    (a.state = 'quota_released' and t.released_count <> t.hold_count) or
    (a.state = 'quota_expired' and t.expired_count <> t.hold_count)
  )
  union all
  select '${
    AllocationInvariantIssueCode.ATTEMPT_POLICY_IDENTITY_MISMATCH
  }', 'attempt', a.id
  from attempts a
  where a.deleted_at is null and
    (a.policy_campaign_id is null or a.policy_deleted_at is not null or
     a.campaign_id <> a.policy_campaign_id or
     a.rules_version <> a.policy_rules_version)

  union all
  select '${
    AllocationInvariantIssueCode.HOLD_ATTEMPT_ORPHAN_OR_DELETED
  }', 'hold', h.id
  from holds h
  where h.deleted_at is null and
        (h.attempt_campaign_id is null or h.attempt_deleted_at is not null)
  union all
  select '${
    AllocationInvariantIssueCode.HOLD_CAPACITY_ORPHAN_OR_DELETED
  }', 'hold', h.id
  from holds h
  where h.deleted_at is null and
        (h.capacity_policy_id is null or h.capacity_deleted_at is not null)
  union all
  select '${
    AllocationInvariantIssueCode.HOLD_CAPACITY_IDENTITY_MISMATCH
  }', 'hold', h.id
  from holds h
  where h.deleted_at is null and h.attempt_deleted_at is null and
        h.capacity_deleted_at is null and
        (h.attempt_policy_id <> h.capacity_policy_id or
         h.campaign_item_id <> h.capacity_campaign_item_id)
  union all
  select '${AllocationInvariantIssueCode.HOLD_EXPIRY_MISMATCH}', 'hold', h.id
  from holds h
  where h.deleted_at is null and h.attempt_deleted_at is null and
        h.expires_at <> h.attempt_expires_at
  union all
  select '${
    AllocationInvariantIssueCode.HOLD_RAW_QUANTITY_MISMATCH
  }', 'hold', h.id
  from holds h where h.deleted_at is null and
    ${NUMERIC_RAW_MISMATCH("h.raw_quantity", "h.quantity")}

  union all
  select '${
    AllocationInvariantIssueCode.CAPACITY_POLICY_ORPHAN_OR_DELETED
  }', 'capacity', c.id
  from capacities c
  where c.deleted_at is null and
        (c.scope_campaign_id is null or c.policy_deleted_at is not null)
  union all
  select '${
    AllocationInvariantIssueCode.POLICY_CAPACITY_MISSING
  }', 'policy', p.id
  from policies p
  where p.deleted_at is null and not exists (
    select 1 from capacities c
    where c.allocation_policy_id = p.id and c.deleted_at is null
  )
  union all
  select '${
    AllocationInvariantIssueCode.POLICY_CAPACITY_STATE_MISMATCH
  }', 'capacity', c.id
  from capacities c
  where c.deleted_at is null and c.policy_deleted_at is null and
        c.state <> c.policy_state
  union all
  select '${
    AllocationInvariantIssueCode.POLICY_CAPACITY_RULES_VERSION_MISMATCH
  }', 'capacity', c.id
  from capacities c
  where c.deleted_at is null and c.policy_deleted_at is null and
        c.rules_version <> c.policy_rules_version
  union all
  select '${AllocationInvariantIssueCode.FENCED_POLICY_ACTIVE}', 'policy', p.id
  from policies p join fences f on f.campaign_id = p.campaign_id
  where p.deleted_at is null and f.deleted_at is null and p.state in ('prepared', 'open')
  union all
  select '${
    AllocationInvariantIssueCode.FENCED_CAPACITY_ACTIVE
  }', 'capacity', c.id
  from capacities c join fences f on f.campaign_id = c.scope_campaign_id
  where c.deleted_at is null and f.deleted_at is null and c.state in ('prepared', 'open')
),
counts as (
  select issue_code, count(*)::int as issue_count
  from issues group by issue_code
),
sample_rows as (
  select issue_code as code, entity_type, entity_id
  from issues, audit_input
  order by issue_code, entity_type, entity_id
  limit (select sample_limit from audit_input)
)
select coalesce((select sum(issue_count)::int from counts), 0) as issue_count,
       coalesce((select jsonb_object_agg(issue_code, issue_count order by issue_code)
                 from counts), '{}'::jsonb) as counts,
       coalesce((select jsonb_agg(to_jsonb(sample_rows) order by code, entity_type, entity_id)
                 from sample_rows), '[]'::jsonb) as samples
`

function parseJson<T>(value: T | string | null, fallback: T): T {
  if (value === null) {
    return fallback
  }
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

export class PostgresAllocationReconciliationStore
  implements AllocationReconciliationStore
{
  constructor(
    private readonly baseRepository: DAL.RepositoryService,
    private readonly observer?: AllocationReconciliationObserver
  ) {}

  async reconcileAllocation(
    input: Required<Pick<ReconcileAllocationCommand, "sample_limit">> &
      Pick<ReconcileAllocationCommand, "campaign_id">
  ): Promise<ReconcileAllocationResult> {
    return await this.baseRepository.transaction<SqlEntityManager>(
      async (manager) => {
        await manager.execute(
          "set transaction isolation level repeatable read read only"
        )
        await manager.execute(
          `set local statement_timeout = '${RECONCILIATION_STATEMENT_TIMEOUT_MS}ms'`
        )
        const snapshots = (await manager.execute(
          `select transaction_timestamp() as snapshot_at,
                  current_setting('transaction_isolation') as isolation_level,
                  current_setting('transaction_read_only') as read_only,
                  current_setting('statement_timeout') as statement_timeout,
                  pg_try_advisory_xact_lock(hashtextextended(
                    'medusa.flash-sale.allocation.reconciliation:' ||
                    coalesce(?::text, '*'), 0)) as lock_acquired`,
          [input.campaign_id ?? null]
        )) as SnapshotRow[]
        const snapshot = snapshots[0]
        if (
          !snapshot ||
          snapshot.isolation_level !== "repeatable read" ||
          snapshot.read_only !== "on" ||
          snapshot.statement_timeout !==
            `${RECONCILIATION_STATEMENT_TIMEOUT_MS / 1000}s`
        ) {
          throw new AllocationCommandError(
            AllocationCommandErrorCode.ALLOCATION_INVARIANT_VIOLATION,
            "Allocation reconciliation requires a read-only repeatable-read snapshot"
          )
        }
        if (!snapshot.lock_acquired) {
          return {
            snapshot_at: new Date(snapshot.snapshot_at),
            healthy: false,
            skipped: true,
            skip_reason: AllocationReconciliationSkipReason.ALREADY_RUNNING,
            issue_count: 0,
            counts: {},
            samples: [],
          }
        }
        await this.observer?.snapshotEstablished?.(manager)
        const rows = (await manager.execute(RECONCILIATION_SQL, [
          input.campaign_id ?? null,
          input.sample_limit,
        ])) as AuditRow[]
        const row = rows[0]
        const rawCounts = parseJson(row?.counts, {})
        const counts = Object.fromEntries(
          Object.entries(rawCounts).map(([code, count]) => [
            code,
            Number(count),
          ])
        ) as Partial<Record<AllocationInvariantIssueCode, number>>
        const samples = parseJson(row?.samples, [])
        const issueCount = Number(row?.issue_count ?? 0)
        return {
          snapshot_at: new Date(snapshot.snapshot_at),
          healthy: issueCount === 0,
          skipped: false,
          skip_reason: null,
          issue_count: issueCount,
          counts,
          samples,
        }
      }
    )
  }
}
