import {
  AllocationPolicyState,
  AllocationHoldState,
  CapacityMovementBucket,
  CapacityMovementCheckpointKind,
  CapacityMovementKind,
  CapacityState,
  PurchaseAttemptState,
} from "../../../types"
import {
  LedgerAttemptEntity,
  LedgerCapacityEntity,
  LedgerCheckpointEntity,
  LedgerDecimalMirror,
  LedgerHoldEntity,
  LedgerIssueClassification,
  LedgerMovementEntity,
  LedgerPolicyEntity,
  LedgerProjectionInput,
  LedgerReconciliationIssue,
  LedgerReconciliationIssueCode,
  LedgerReconciliationResult,
  ProjectedCapacityCounters,
} from "./ledger-reconciliation-contracts"
import { validateCapacityMovement } from "./capacity-movement"

const DECIMAL = /^(0|[1-9][0-9]*)$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/

export class LedgerProjectionError extends Error {
  constructor(
    readonly code: LedgerReconciliationIssueCode,
    message: string,
    readonly capacityId: string | null = null
  ) {
    super(message)
    this.name = "LedgerProjectionError"
  }
}

function fail(
  code: LedgerReconciliationIssueCode,
  message: string,
  capacityId: string | null = null
): never {
  throw new LedgerProjectionError(code, message, capacityId)
}

function decimal(
  value: string,
  field: string,
  options: { positive?: boolean } = {}
): bigint {
  if (
    typeof value !== "string" ||
    !(options.positive ? POSITIVE_DECIMAL : DECIMAL).test(value)
  ) {
    fail(
      LedgerReconciliationIssueCode.INVALID_DECIMAL,
      `${field} must be a canonical ${options.positive ? "positive" : "non-negative"} decimal string`
    )
  }
  return BigInt(value)
}

function mirrorValue(raw: LedgerDecimalMirror): string | null {
  try {
    const parsed =
      typeof raw === "string"
        ? (JSON.parse(raw) as { value?: unknown; precision?: unknown })
        : raw
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.precision !== 20 ||
      typeof parsed.value !== "string" ||
      !DECIMAL.test(parsed.value)
    ) {
      return null
    }
    return BigInt(parsed.value).toString(10)
  } catch {
    return null
  }
}

function assertMirror(
  raw: LedgerDecimalMirror,
  expected: string,
  field: string,
  capacityId: string
): void {
  if (mirrorValue(raw) !== expected) {
    fail(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
      `${field} does not mirror its immutable decimal`,
      capacityId
    )
  }
}

export function isCheckpointKindAllowedForRootSchema(
  schemaVersion: string,
  checkpointKind: string
): boolean {
  if (schemaVersion === "1") {
    return checkpointKind === CapacityMovementCheckpointKind.CUTOVER
  }
  if (schemaVersion === "2") {
    return Object.values(CapacityMovementCheckpointKind).includes(
      checkpointKind as CapacityMovementCheckpointKind
    )
  }
  return false
}

function routeFor(kind: string): readonly [string, string] | undefined {
  switch (kind) {
    case CapacityMovementKind.HOLD:
      return [CapacityMovementBucket.AVAILABLE, CapacityMovementBucket.HELD]
    case CapacityMovementKind.CONSUME:
      return [CapacityMovementBucket.HELD, CapacityMovementBucket.CONSUMED]
    case CapacityMovementKind.RELEASE:
    case CapacityMovementKind.EXPIRE:
      return [CapacityMovementBucket.HELD, CapacityMovementBucket.AVAILABLE]
    default:
      return undefined
  }
}

function assertTransitionVersion(movement: LedgerMovementEntity): void {
  const version = decimal(
    movement.transition_version,
    "movement.transition_version",
    { positive: true }
  ).toString(10)
  const allowed =
    (movement.kind === CapacityMovementKind.HOLD && version === "2") ||
    (movement.kind === CapacityMovementKind.CONSUME && version === "4") ||
    (movement.kind === CapacityMovementKind.RELEASE &&
      (version === "3" || version === "4")) ||
    (movement.kind === CapacityMovementKind.EXPIRE && version === "3")
  if (!allowed) {
    fail(
      LedgerReconciliationIssueCode.UNSUPPORTED_TRANSITION_VERSION,
      `movement ${movement.id} has an unsupported kind/version pair`,
      movement.capacity_id
    )
  }
}

function assertLive(entity: { deleted_at: string | null }, name: string): void {
  if (entity.deleted_at !== null) {
    fail(
      LedgerReconciliationIssueCode.SOFT_DELETED_EVIDENCE,
      `${name} contains a soft-deleted physical row`
    )
  }
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    fail(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
      `${field} must be a bounded non-empty identifier`
    )
  }
}

function movementIdentity(movement: LedgerMovementEntity): string {
  return `${movement.attempt_id}\u0000${movement.campaign_item_id}\u0000${movement.transition_version}`
}

type AttemptHistoryExpectation = Readonly<{
  version: string
  holdState: AllocationHoldState | null
  terminalKind: CapacityMovementKind | null
  requiresHolds: boolean
}>

function attemptHistoryExpectation(
  attempt: LedgerAttemptEntity
): AttemptHistoryExpectation {
  switch (attempt.state) {
    case PurchaseAttemptState.PENDING:
      return { version: "1", holdState: null, terminalKind: null, requiresHolds: false }
    case PurchaseAttemptState.QUOTA_REJECTED:
      return { version: "2", holdState: null, terminalKind: null, requiresHolds: false }
    case PurchaseAttemptState.QUOTA_HELD:
      if (attempt.settlement_id !== null) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `held Attempt ${attempt.id} cannot have settlement evidence`
        )
      }
      return {
        version: "2",
        holdState: AllocationHoldState.HELD,
        terminalKind: null,
        requiresHolds: true,
      }
    case PurchaseAttemptState.QUOTA_COMMITTING:
      if (attempt.settlement_id === null) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `committing Attempt ${attempt.id} requires settlement evidence`
        )
      }
      return {
        version: "3",
        holdState: AllocationHoldState.HELD,
        terminalKind: null,
        requiresHolds: true,
      }
    case PurchaseAttemptState.QUOTA_CONSUMED:
      if (attempt.settlement_id === null) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `consumed Attempt ${attempt.id} requires settlement evidence`
        )
      }
      return {
        version: "4",
        holdState: AllocationHoldState.CONSUMED,
        terminalKind: CapacityMovementKind.CONSUME,
        requiresHolds: true,
      }
    case PurchaseAttemptState.QUOTA_EXPIRED:
      if (attempt.settlement_id !== null) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `expired Attempt ${attempt.id} cannot have settlement evidence`
        )
      }
      return {
        version: "3",
        holdState: AllocationHoldState.EXPIRED,
        terminalKind: CapacityMovementKind.EXPIRE,
        requiresHolds: true,
      }
    case PurchaseAttemptState.QUOTA_RELEASED:
      return {
        version: attempt.settlement_id === null ? "3" : "4",
        holdState: AllocationHoldState.RELEASED,
        terminalKind: CapacityMovementKind.RELEASE,
        requiresHolds: true,
      }
    default:
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Attempt ${attempt.id} has an unsupported state`
      )
  }
}

function validateFacts(
  activationId: string,
  movements: readonly LedgerMovementEntity[],
  attempts: readonly LedgerAttemptEntity[],
  holds: readonly LedgerHoldEntity[],
  capacityById: ReadonlyMap<string, LedgerCapacityEntity>,
  policyById: ReadonlyMap<string, LedgerPolicyEntity>
): void {
  const attemptById = new Map<string, LedgerAttemptEntity>()
  for (const attempt of attempts) {
    assertLive(attempt, "attempt evidence")
    assertIdentity(attempt.id, "attempt.id")
    assertIdentity(attempt.allocation_policy_id, "attempt.allocation_policy_id")
    assertIdentity(attempt.campaign_id, "attempt.campaign_id")
    assertIdentity(attempt.subject_id, "attempt.subject_id")
    if (attemptById.has(attempt.id)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `duplicate attempt fact ${attempt.id}`
      )
    }
    const policy = policyById.get(attempt.allocation_policy_id)
    if (!policy || policy.campaign_id !== attempt.campaign_id) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Attempt ${attempt.id} does not identify a live Policy/Campaign`
      )
    }
    attemptById.set(attempt.id, attempt)
  }
  const holdByAttemptItem = new Map<string, LedgerHoldEntity>()
  const holdsByAttempt = new Map<string, LedgerHoldEntity[]>()
  for (const hold of holds) {
    assertLive(hold, "hold evidence")
    if (!attemptById.has(hold.attempt_id)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `hold ${hold.id} has no loaded Attempt fact`,
        hold.capacity_id
      )
    }
    const key = `${hold.attempt_id}\u0000${hold.campaign_item_id}`
    if (holdByAttemptItem.has(key)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `duplicate hold fact ${key}`,
        hold.capacity_id
      )
    }
    const quantity = decimal(hold.quantity, "hold.quantity", {
      positive: true,
    }).toString(10)
    assertMirror(hold.raw_quantity, quantity, "hold.raw_quantity", hold.capacity_id)
    const capacity = capacityById.get(hold.capacity_id)
    const attempt = attemptById.get(hold.attempt_id)
    if (
      !capacity ||
      !attempt ||
      capacity.campaign_item_id !== hold.campaign_item_id ||
      capacity.allocation_policy_id !== attempt.allocation_policy_id
    ) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `hold ${hold.id} does not identify one Attempt Policy/Capacity`,
        hold.capacity_id
      )
    }
    holdByAttemptItem.set(key, hold)
    const grouped = holdsByAttempt.get(hold.attempt_id) ?? []
    grouped.push(hold)
    holdsByAttempt.set(hold.attempt_id, grouped)
  }

  const movementByFact = new Map<string, LedgerMovementEntity>()
  const movementsByAttempt = new Map<string, LedgerMovementEntity[]>()
  for (const movement of movements) {
    const factKey = `${movement.attempt_id}\u0000${movement.campaign_item_id}\u0000${movement.kind}`
    if (movementByFact.has(factKey)) {
      fail(
        LedgerReconciliationIssueCode.DUPLICATE_MOVEMENT_IDENTITY,
        `duplicate Movement fact ${factKey}`,
        movement.capacity_id
      )
    }
    movementByFact.set(factKey, movement)
    const attempt = attemptById.get(movement.attempt_id)
    const capacity = capacityById.get(movement.capacity_id)
    const policy = capacity
      ? policyById.get(capacity.allocation_policy_id)
      : undefined
    const hold = holdByAttemptItem.get(
      `${movement.attempt_id}\u0000${movement.campaign_item_id}`
    )
    if (
      !attempt ||
      !hold ||
      hold.capacity_id !== movement.capacity_id ||
      capacity?.allocation_policy_id !== attempt.allocation_policy_id ||
      policy?.campaign_id !== movement.campaign_id ||
      attempt.campaign_id !== movement.campaign_id ||
      attempt.subject_id !== movement.subject_id ||
      hold.quantity !== movement.quantity
    ) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `movement ${movement.id} does not match Attempt/Hold facts`,
        movement.capacity_id
      )
    }
    const binding =
      movement.kind === CapacityMovementKind.HOLD
        ? attempt.hold_movement_activation_id
        : attempt.terminal_movement_activation_id
    if (binding !== activationId) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `movement ${movement.id} is not bound to the active ledger`,
        movement.capacity_id
      )
    }
    const grouped = movementsByAttempt.get(movement.attempt_id) ?? []
    grouped.push(movement)
    movementsByAttempt.set(movement.attempt_id, grouped)
  }

  for (const attempt of attempts) {
    const expectation = attemptHistoryExpectation(attempt)
    const version = decimal(attempt.version, "attempt.version", {
      positive: true,
    }).toString(10)
    if (version !== expectation.version) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Attempt ${attempt.id} state/version history is invalid`
      )
    }
    const attemptHolds = holdsByAttempt.get(attempt.id) ?? []
    const attemptMovements = movementsByAttempt.get(attempt.id) ?? []
    if (!expectation.requiresHolds) {
      if (
        attemptHolds.length > 0 ||
        attemptMovements.length > 0 ||
        attempt.hold_movement_activation_id !== null ||
        attempt.terminal_movement_activation_id !== null ||
        attempt.settlement_id !== null
      ) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `Attempt ${attempt.id} must have empty history and null bindings`
        )
      }
      continue
    }
    if (attemptHolds.length === 0) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `Attempt ${attempt.id} has state/bindings but no complete Hold set`
      )
    }
    if (
      attempt.hold_movement_activation_id !== null &&
      attempt.hold_movement_activation_id !== activationId
    ) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `Attempt ${attempt.id} has a foreign Hold binding`
      )
    }
    if (
      attempt.terminal_movement_activation_id !== null &&
      attempt.terminal_movement_activation_id !== activationId
    ) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `Attempt ${attempt.id} has a foreign terminal binding`
      )
    }
    if (
      expectation.terminalKind === null &&
      attempt.terminal_movement_activation_id !== null
    ) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `non-terminal Attempt ${attempt.id} has a terminal binding`
      )
    }
    if (
      expectation.terminalKind !== null &&
      attempt.hold_movement_activation_id !== null &&
      attempt.terminal_movement_activation_id === null
    ) {
      fail(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        `terminal Attempt ${attempt.id} cannot lose its terminal binding after a bound Hold`
      )
    }

    for (const hold of attemptHolds) {
      if (hold.state !== expectation.holdState) {
        fail(
          LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
          `hold ${hold.id} state disagrees with Attempt ${attempt.id}`,
          hold.capacity_id
        )
      }
      const prefix = `${hold.attempt_id}\u0000${hold.campaign_item_id}\u0000`
      const holdMovement = movementByFact.get(prefix + CapacityMovementKind.HOLD)
      if (attempt.hold_movement_activation_id === activationId) {
        if (!holdMovement || holdMovement.transition_version !== "2") {
          fail(
            LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
            `hold ${hold.id} is bound but its v2 Hold Movement is incomplete`,
            hold.capacity_id
          )
        }
      } else if (holdMovement) {
        fail(
          LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
          `legacy hold ${hold.id} has an unexpected Hold Movement`,
          hold.capacity_id
        )
      }

      const terminalMovements = [
        CapacityMovementKind.CONSUME,
        CapacityMovementKind.RELEASE,
        CapacityMovementKind.EXPIRE,
      ].flatMap((kind) => {
        const movement = movementByFact.get(prefix + kind)
        return movement ? [movement] : []
      })
      if (attempt.terminal_movement_activation_id === activationId) {
        if (
          !expectation.terminalKind ||
          terminalMovements.length !== 1 ||
          terminalMovements[0].kind !== expectation.terminalKind ||
          terminalMovements[0].transition_version !== expectation.version
        ) {
          fail(
            LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
            `hold ${hold.id} terminal Movement is incomplete for Attempt state/version`,
            hold.capacity_id
          )
        }
      } else if (terminalMovements.length > 0) {
        fail(
          LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
          `legacy terminal hold ${hold.id} has an unexpected terminal Movement`,
          hold.capacity_id
        )
      }
    }
  }
}

function validateCheckpoint(
  checkpoint: LedgerCheckpointEntity,
  capacity: LedgerCapacityEntity,
  activationId: string,
  rootSchema: string
): readonly [bigint, bigint, bigint, bigint] {
  assertLive(checkpoint, "checkpoint evidence")
  if (
    checkpoint.activation_id !== activationId ||
    checkpoint.capacity_id !== capacity.id ||
    checkpoint.campaign_item_id !== capacity.campaign_item_id ||
    checkpoint.shard_no !== capacity.shard_no
  ) {
    fail(
      LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
      `checkpoint ${checkpoint.id} does not identify Capacity ${capacity.id}`,
      capacity.id
    )
  }
  if (!isCheckpointKindAllowedForRootSchema(rootSchema, checkpoint.checkpoint_kind)) {
    fail(
      LedgerReconciliationIssueCode.UNSUPPORTED_CHECKPOINT_KIND,
      `checkpoint ${checkpoint.id} kind is not valid for root schema ${rootSchema}`,
      capacity.id
    )
  }
  const granted = decimal(
    checkpoint.opening_granted_quantity,
    "checkpoint.opening_granted_quantity",
    { positive: true }
  )
  const available = decimal(
    checkpoint.opening_available_quantity,
    "checkpoint.opening_available_quantity"
  )
  const held = decimal(
    checkpoint.opening_held_quantity,
    "checkpoint.opening_held_quantity"
  )
  const consumed = decimal(
    checkpoint.opening_consumed_quantity,
    "checkpoint.opening_consumed_quantity"
  )
  assertMirror(
    checkpoint.raw_opening_granted_quantity,
    granted.toString(10),
    "checkpoint.raw_opening_granted_quantity",
    capacity.id
  )
  assertMirror(
    checkpoint.raw_opening_available_quantity,
    available.toString(10),
    "checkpoint.raw_opening_available_quantity",
    capacity.id
  )
  assertMirror(
    checkpoint.raw_opening_held_quantity,
    held.toString(10),
    "checkpoint.raw_opening_held_quantity",
    capacity.id
  )
  assertMirror(
    checkpoint.raw_opening_consumed_quantity,
    consumed.toString(10),
    "checkpoint.raw_opening_consumed_quantity",
    capacity.id
  )
  if (available + held + consumed !== granted) {
    fail(
      LedgerReconciliationIssueCode.CHECKPOINT_CONSERVATION_VIOLATION,
      `checkpoint ${checkpoint.id} does not conserve granted quantity`,
      capacity.id
    )
  }
  if (
    checkpoint.checkpoint_kind === CapacityMovementCheckpointKind.PROVISION &&
    (available !== granted || held !== 0n || consumed !== 0n)
  ) {
    fail(
      LedgerReconciliationIssueCode.CHECKPOINT_CONSERVATION_VIOLATION,
      `provision checkpoint ${checkpoint.id} is not an unused Capacity`,
      capacity.id
    )
  }
  return [granted, available, held, consumed]
}

function buildFactMaps(input: LedgerProjectionInput): Readonly<{
  policyById: ReadonlyMap<string, LedgerPolicyEntity>
  capacityById: ReadonlyMap<string, LedgerCapacityEntity>
}> {
  const policyById = new Map<string, LedgerPolicyEntity>()
  const validPolicyStates = new Set<string>(Object.values(AllocationPolicyState))
  const validCapacityStates = new Set<string>(Object.values(CapacityState))
  for (const policy of input.policies) {
    assertLive(policy, "policy evidence")
    assertIdentity(policy.id, "policy.id")
    assertIdentity(policy.campaign_id, "policy.campaign_id")
    if (!validPolicyStates.has(policy.state)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Policy ${policy.id} has an unsupported state`
      )
    }
    if (policyById.has(policy.id)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `duplicate Policy ${policy.id}`
      )
    }
    policyById.set(policy.id, policy)
  }
  const capacityById = new Map<string, LedgerCapacityEntity>()
  const policyCapacityCounts = new Map<string, number>()
  for (const capacity of input.capacities) {
    assertLive(capacity, "capacity evidence")
    assertIdentity(capacity.id, "capacity.id")
    assertIdentity(capacity.allocation_policy_id, "capacity.allocation_policy_id")
    assertIdentity(capacity.campaign_item_id, "capacity.campaign_item_id")
    if (!validCapacityStates.has(capacity.state)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Capacity ${capacity.id} has an unsupported state`,
        capacity.id
      )
    }
    const policy = policyById.get(capacity.allocation_policy_id)
    if (!policy) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Capacity ${capacity.id} has no live Policy`,
        capacity.id
      )
    }
    if (capacity.state !== policy.state) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Capacity ${capacity.id} state disagrees with Policy ${policy.id}`,
        capacity.id
      )
    }
    if (capacityById.has(capacity.id)) {
      fail(
        LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
        `duplicate Capacity ${capacity.id}`,
        capacity.id
      )
    }
    capacityById.set(capacity.id, capacity)
    policyCapacityCounts.set(
      policy.id,
      (policyCapacityCounts.get(policy.id) ?? 0) + 1
    )
  }
  for (const policy of policyById.values()) {
    if (!policyCapacityCounts.has(policy.id)) {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `Policy ${policy.id} has no physical Capacity`
      )
    }
  }
  return { policyById, capacityById }
}

export function projectVerifiedCapacityLedger(
  input: LedgerProjectionInput
): readonly ProjectedCapacityCounters[] {
  const control = input.control
  if (!control) {
    fail(
      LedgerReconciliationIssueCode.CONTROL_MISSING_WITH_LEDGER_ROWS,
      "an activated Control is required for ledger projection"
    )
  }
  assertLive(control, "control evidence")
  if (control.schema_version !== "1" && control.schema_version !== "2") {
    fail(
      LedgerReconciliationIssueCode.UNKNOWN_CONTROL_SCHEMA,
      `unsupported Control root schema ${control.schema_version}`
    )
  }
  const { policyById, capacityById } = buildFactMaps(input)
  if (
    input.repair_scope !== "open" &&
    (input.policies.some((row) => row.state === AllocationPolicyState.OPEN) ||
      input.capacities.some((row) => row.state === CapacityState.OPEN))
  ) {
    fail(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
      "repair scope cannot be non-OPEN while Policy or Capacity is OPEN"
    )
  }
  const checkpointByCapacity = new Map<string, LedgerCheckpointEntity>()
  for (const checkpoint of input.checkpoints) {
    if (checkpointByCapacity.has(checkpoint.capacity_id)) {
      fail(
        LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
        `multiple checkpoints cover Capacity ${checkpoint.capacity_id}`,
        checkpoint.capacity_id
      )
    }
    checkpointByCapacity.set(checkpoint.capacity_id, checkpoint)
  }
  if (checkpointByCapacity.size !== capacityById.size) {
    fail(
      LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
      "checkpoint set is not a bijection over Capacity"
    )
  }

  const movementIds = new Set<string>()
  const movementIdentities = new Set<string>()
  for (const movement of input.movements) {
    assertLive(movement, "movement evidence")
    const identity = movementIdentity(movement)
    if (movementIds.has(movement.id) || movementIdentities.has(identity)) {
      fail(
        LedgerReconciliationIssueCode.DUPLICATE_MOVEMENT_IDENTITY,
        `duplicate Movement identity ${identity}`,
        movement.capacity_id
      )
    }
    movementIds.add(movement.id)
    movementIdentities.add(identity)
    if (movement.schema_version !== "1") {
      fail(
        LedgerReconciliationIssueCode.UNSUPPORTED_MOVEMENT_SCHEMA,
        `movement ${movement.id} uses unsupported tuple schema`,
        movement.capacity_id
      )
    }
    const route = routeFor(movement.kind)
    if (
      !route ||
      route[0] !== movement.from_bucket ||
      route[1] !== movement.to_bucket
    ) {
      fail(
        LedgerReconciliationIssueCode.UNSUPPORTED_MOVEMENT_ROUTE,
        `movement ${movement.id} has an unsupported route`,
        movement.capacity_id
      )
    }
    if (
      movement.campaign_item_id !==
      capacityById.get(movement.capacity_id)?.campaign_item_id
    ) {
      fail(
        LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
        `movement ${movement.id} does not identify its Capacity`,
        movement.capacity_id
      )
    }
    assertTransitionVersion(movement)
    const quantity = decimal(movement.quantity, "movement.quantity", {
      positive: true,
    }).toString(10)
    assertMirror(
      movement.raw_quantity,
      quantity,
      "movement.raw_quantity",
      movement.capacity_id
    )
    try {
      validateCapacityMovement({
        schema_version: 1,
        capacity_id: movement.capacity_id,
        attempt_id: movement.attempt_id,
        campaign_id: movement.campaign_id,
        subject_id: movement.subject_id,
        campaign_item_id: movement.campaign_item_id,
        transition_version: Number(BigInt(movement.transition_version)),
        kind: movement.kind as CapacityMovementKind,
        from_bucket: movement.from_bucket as CapacityMovementBucket,
        to_bucket: movement.to_bucket as CapacityMovementBucket,
        quantity,
        fence_token: movement.fence_token,
      })
    } catch {
      fail(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        `movement ${movement.id} fingerprint does not match its immutable tuple`,
        movement.capacity_id
      )
    }
  }
  validateFacts(
    control.activation_id,
    input.movements,
    input.attempts,
    input.holds,
    capacityById,
    policyById
  )

  return [...capacityById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((capacity) => {
      const checkpoint = checkpointByCapacity.get(capacity.id)
      if (!checkpoint) {
        fail(
          LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
          `Capacity ${capacity.id} has no checkpoint`,
          capacity.id
        )
      }
      const [granted, openingAvailable, openingHeld, openingConsumed] =
        validateCheckpoint(
          checkpoint,
          capacity,
          control.activation_id,
          control.schema_version
        )
      let holds = 0n
      let consumes = 0n
      let returns = 0n
      for (const movement of input.movements) {
        if (movement.capacity_id !== capacity.id) continue
        const quantity = BigInt(movement.quantity)
        if (movement.kind === CapacityMovementKind.HOLD) holds += quantity
        else if (movement.kind === CapacityMovementKind.CONSUME) consumes += quantity
        else returns += quantity
      }
      const available = openingAvailable - holds + returns
      const held = openingHeld + holds - consumes - returns
      const consumed = openingConsumed + consumes
      if (
        available < 0n ||
        held < 0n ||
        consumed < 0n ||
        available + held + consumed !== granted
      ) {
        fail(
          LedgerReconciliationIssueCode.PROJECTED_CONSERVATION_VIOLATION,
          `projected counters do not conserve Capacity ${capacity.id}`,
          capacity.id
        )
      }
      return Object.freeze({
        capacity_id: capacity.id,
        campaign_item_id: capacity.campaign_item_id,
        granted_quantity: granted.toString(10),
        available_quantity: available.toString(10),
        held_quantity: held.toString(10),
        consumed_quantity: consumed.toString(10),
      })
    })
}

function issue(
  code: LedgerReconciliationIssueCode,
  classification: LedgerIssueClassification,
  detail: string,
  capacityId: string | null = null
): LedgerReconciliationIssue {
  return Object.freeze({ code, classification, detail, capacity_id: capacityId })
}

function manualResult(
  issues: readonly LedgerReconciliationIssue[]
): LedgerReconciliationResult {
  return Object.freeze({
    status: "manual_required",
    classification: "manual_required",
    expected_capacities: [],
    issues,
    subject_counter_derivation: "not_ledger_derived",
  })
}

export function reconcileCapacityLedgerProjection(
  input: LedgerProjectionInput
): LedgerReconciliationResult {
  if (!input.control) {
    if (input.checkpoints.length > 0 || input.movements.length > 0) {
      return manualResult([
        issue(
          LedgerReconciliationIssueCode.CONTROL_MISSING_WITH_LEDGER_ROWS,
          "manual_required",
          "physical ledger rows exist without an activation Control"
        ),
      ])
    }
    try {
      const { policyById, capacityById } = buildFactMaps(input)
      validateFacts(
        "",
        [],
        input.attempts,
        input.holds,
        capacityById,
        policyById
      )
    } catch (error) {
      if (error instanceof LedgerProjectionError) {
        return manualResult([
          issue(
            error.code,
            "manual_required",
            error.message,
            error.capacityId
          ),
        ])
      }
      throw error
    }
    return Object.freeze({
      status: "not_activated",
      classification: null,
      expected_capacities: [],
      issues: [],
      subject_counter_derivation: "not_ledger_derived",
    })
  }

  const preflight: LedgerReconciliationIssue[] = []
  if (!input.verification.checkpoint_root_verified) {
    preflight.push(
      issue(
        LedgerReconciliationIssueCode.CHECKPOINT_ROOT_UNVERIFIED,
        "manual_required",
        "Control digest/root verification did not succeed"
      )
    )
  }
  if (!input.verification.physical_row_set_verified) {
    preflight.push(
      issue(
        LedgerReconciliationIssueCode.PHYSICAL_ROW_SET_UNVERIFIED,
        "manual_required",
        "physical Capacity/Checkpoint/Movement coverage is not closed"
      )
    )
  }
  if (!input.verification.attempt_bindings_complete) {
    preflight.push(
      issue(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
        "manual_required",
        "Attempt binding verification did not succeed"
      )
    )
  }
  if (!input.verification.hold_facts_complete) {
    preflight.push(
      issue(
        LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
        "manual_required",
        "Hold fact verification did not succeed"
      )
    )
  }
  if (preflight.length > 0) return manualResult(preflight)

  let expected: readonly ProjectedCapacityCounters[]
  try {
    expected = projectVerifiedCapacityLedger(input)
  } catch (error) {
    if (error instanceof LedgerProjectionError) {
      return manualResult([
        issue(
          error.code,
          "manual_required",
          error.message,
          error.capacityId
        ),
      ])
    }
    throw error
  }

  const actualById = new Map(input.capacities.map((row) => [row.id, row] as const))
  const issues: LedgerReconciliationIssue[] = []
  const safeEligible = input.repair_scope !== "open"
  const driftClassification: LedgerIssueClassification = safeEligible
    ? "safe_repair"
    : "manual_required"
  try {
    for (const projected of expected) {
      const actual = actualById.get(projected.capacity_id)
      if (!actual) continue
      const granted = decimal(
        actual.granted_quantity,
        "capacity.granted_quantity",
        { positive: true }
      ).toString(10)
      const held = decimal(
        actual.held_quantity,
        "capacity.held_quantity"
      ).toString(10)
      const consumed = decimal(
        actual.consumed_quantity,
        "capacity.consumed_quantity"
      ).toString(10)
      if (granted !== projected.granted_quantity) {
        issues.push(
          issue(
            LedgerReconciliationIssueCode.GRANTED_QUANTITY_DRIFT,
            "manual_required",
            "materialized granted quantity differs from checkpoint authority",
            actual.id
          )
        )
      }
      if (held !== projected.held_quantity) {
        issues.push(
          issue(
            LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
            driftClassification,
            "materialized held quantity differs from ledger projection",
            actual.id
          )
        )
      }
      if (consumed !== projected.consumed_quantity) {
        issues.push(
          issue(
            LedgerReconciliationIssueCode.CONSUMED_QUANTITY_DRIFT,
            driftClassification,
            "materialized consumed quantity differs from ledger projection",
            actual.id
          )
        )
      }
      if (mirrorValue(actual.raw_granted_quantity) !== granted) {
        issues.push(
          issue(
            LedgerReconciliationIssueCode.RAW_GRANTED_MIRROR_DRIFT,
            "manual_required",
            "materialized raw granted mirror differs from granted quantity",
            actual.id
          )
        )
      }
      if (
        mirrorValue(actual.raw_held_quantity) !== held ||
        mirrorValue(actual.raw_consumed_quantity) !== consumed
      ) {
        issues.push(
          issue(
            LedgerReconciliationIssueCode.RAW_MIRROR_DRIFT,
            driftClassification,
            "materialized raw decimal mirror differs from its numeric counter",
            actual.id
          )
        )
      }
    }
  } catch (error) {
    if (error instanceof LedgerProjectionError) {
      return manualResult([
        issue(
          error.code,
          "manual_required",
          error.message,
          error.capacityId
        ),
      ])
    }
    throw error
  }
  if (issues.length === 0) {
    return Object.freeze({
      status: "healthy",
      classification: null,
      expected_capacities: expected,
      issues: [],
      subject_counter_derivation: "not_ledger_derived",
    })
  }
  const hasManual = issues.some(
    (entry) => entry.classification === "manual_required"
  )
  return Object.freeze({
    status: hasManual ? "manual_required" : "drift",
    classification: hasManual ? "manual_required" : "safe_repair",
    expected_capacities: expected,
    issues,
    subject_counter_derivation: "not_ledger_derived",
  })
}
