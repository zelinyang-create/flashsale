import {
  AllocationHoldState,
  CapacityMovementBucket,
  CapacityMovementCheckpointKind,
  CapacityMovementKind,
  CapacityState,
  PurchaseAttemptState,
} from "../../../../types"
import {
  LedgerAttemptEntity,
  LedgerCapacityEntity,
  LedgerCheckpointEntity,
  LedgerHoldEntity,
  LedgerMovementEntity,
  LedgerProjectionInput,
  LedgerReconciliationIssueCode,
  isCheckpointKindAllowedForRootSchema,
  reconcileCapacityLedgerProjection,
} from ".."

const ACTIVATION = "activation-1"
const raw = (value: string) => ({ value, precision: 20 })

function capacity(
  id: string,
  item: string,
  granted: string,
  held: string,
  consumed: string
): LedgerCapacityEntity {
  return {
    id,
    campaign_item_id: item,
    shard_no: "0",
    state: CapacityState.CLOSED,
    granted_quantity: granted,
    held_quantity: held,
    consumed_quantity: consumed,
    raw_granted_quantity: raw(granted),
    raw_held_quantity: raw(held),
    raw_consumed_quantity: raw(consumed),
    deleted_at: null,
  }
}

function checkpoint(
  capacityId: string,
  item: string,
  granted: string,
  available: string,
  held: string,
  consumed: string,
  kind: CapacityMovementCheckpointKind =
    CapacityMovementCheckpointKind.PROVISION
): LedgerCheckpointEntity {
  return {
    id: `cp-${capacityId}`,
    activation_id: ACTIVATION,
    capacity_id: capacityId,
    campaign_item_id: item,
    checkpoint_kind: kind,
    shard_no: "0",
    opening_granted_quantity: granted,
    opening_available_quantity: available,
    opening_held_quantity: held,
    opening_consumed_quantity: consumed,
    raw_opening_granted_quantity: raw(granted),
    raw_opening_available_quantity: raw(available),
    raw_opening_held_quantity: raw(held),
    raw_opening_consumed_quantity: raw(consumed),
    deleted_at: null,
  }
}

function attempt(
  id: string,
  state: PurchaseAttemptState,
  terminal: boolean,
  holdBinding: string | null = ACTIVATION
): LedgerAttemptEntity {
  const settlement =
    state === PurchaseAttemptState.QUOTA_CONSUMED ||
    state === PurchaseAttemptState.QUOTA_COMMITTING
  return {
    id,
    campaign_id: "campaign-1",
    subject_id: `subject-${id}`,
    state,
    version:
      state === PurchaseAttemptState.QUOTA_CONSUMED
        ? "4"
        : terminal
          ? "3"
          : "2",
    settlement_id: settlement ? `settlement-${id}` : null,
    hold_movement_activation_id: holdBinding,
    terminal_movement_activation_id: terminal ? ACTIVATION : null,
    deleted_at: null,
  }
}

function hold(
  attemptId: string,
  capacityId: string,
  item: string,
  quantity: string,
  state: AllocationHoldState
): LedgerHoldEntity {
  return {
    id: `hold-${attemptId}`,
    attempt_id: attemptId,
    capacity_id: capacityId,
    campaign_item_id: item,
    quantity,
    raw_quantity: raw(quantity),
    state,
    deleted_at: null,
  }
}

function movement(
  id: string,
  attemptRow: LedgerAttemptEntity,
  holdRow: LedgerHoldEntity,
  kind: CapacityMovementKind,
  transitionVersion: string
): LedgerMovementEntity {
  const route = {
    [CapacityMovementKind.HOLD]: [
      CapacityMovementBucket.AVAILABLE,
      CapacityMovementBucket.HELD,
    ],
    [CapacityMovementKind.CONSUME]: [
      CapacityMovementBucket.HELD,
      CapacityMovementBucket.CONSUMED,
    ],
    [CapacityMovementKind.RELEASE]: [
      CapacityMovementBucket.HELD,
      CapacityMovementBucket.AVAILABLE,
    ],
    [CapacityMovementKind.EXPIRE]: [
      CapacityMovementBucket.HELD,
      CapacityMovementBucket.AVAILABLE,
    ],
  }[kind]
  return {
    id,
    schema_version: "1",
    capacity_id: holdRow.capacity_id,
    attempt_id: attemptRow.id,
    campaign_id: attemptRow.campaign_id,
    subject_id: attemptRow.subject_id,
    campaign_item_id: holdRow.campaign_item_id,
    transition_version: transitionVersion,
    kind,
    from_bucket: route[0],
    to_bucket: route[1],
    quantity: holdRow.quantity,
    raw_quantity: raw(holdRow.quantity),
    deleted_at: null,
  }
}

function baseInput(): LedgerProjectionInput {
  const item = "item-1"
  const rows = [
    {
      attempt: attempt("held", PurchaseAttemptState.QUOTA_HELD, false),
      hold: hold("held", "capacity-1", item, "2", AllocationHoldState.HELD),
      terminal: null,
    },
    {
      attempt: attempt(
        "consumed",
        PurchaseAttemptState.QUOTA_CONSUMED,
        true
      ),
      hold: hold(
        "consumed",
        "capacity-1",
        item,
        "3",
        AllocationHoldState.CONSUMED
      ),
      terminal: CapacityMovementKind.CONSUME,
    },
    {
      attempt: attempt(
        "released",
        PurchaseAttemptState.QUOTA_RELEASED,
        true
      ),
      hold: hold(
        "released",
        "capacity-1",
        item,
        "1",
        AllocationHoldState.RELEASED
      ),
      terminal: CapacityMovementKind.RELEASE,
    },
    {
      attempt: attempt(
        "expired",
        PurchaseAttemptState.QUOTA_EXPIRED,
        true
      ),
      hold: hold(
        "expired",
        "capacity-1",
        item,
        "1",
        AllocationHoldState.EXPIRED
      ),
      terminal: CapacityMovementKind.EXPIRE,
    },
  ] as const
  const movements = rows.flatMap((row) => [
    movement(
      `movement-${row.attempt.id}-hold`,
      row.attempt,
      row.hold,
      CapacityMovementKind.HOLD,
      "2"
    ),
    ...(row.terminal
      ? [
          movement(
            `movement-${row.attempt.id}-terminal`,
            row.attempt,
            row.hold,
            row.terminal,
            row.terminal === CapacityMovementKind.CONSUME ? "4" : "3"
          ),
        ]
      : []),
  ])
  return {
    control: {
      id: "allocation-movement-ledger",
      activation_id: ACTIVATION,
      schema_version: "2",
      checkpoint_digest: "a".repeat(64),
      deleted_at: null,
    },
    checkpoints: [checkpoint("capacity-1", item, "10", "10", "0", "0")],
    movements,
    capacities: [capacity("capacity-1", item, "10", "2", "3")],
    attempts: rows.map((row) => row.attempt),
    holds: rows.map((row) => row.hold),
    verification: {
      checkpoint_root_verified: true,
      physical_row_set_verified: true,
      attempt_bindings_complete: true,
      hold_facts_complete: true,
    },
    repair_scope: "non_open",
  }
}

describe("capacity ledger projector", () => {
  it("projects all four routes with decimal strings and never derives subject counters", () => {
    const result = reconcileCapacityLedgerProjection(baseInput())
    expect(result).toMatchObject({
      status: "healthy",
      classification: null,
      subject_counter_derivation: "not_ledger_derived",
      expected_capacities: [
        {
          capacity_id: "capacity-1",
          granted_quantity: "10",
          available_quantity: "5",
          held_quantity: "2",
          consumed_quantity: "3",
        },
      ],
    })
  })

  it("preserves quantities far above Number.MAX_SAFE_INTEGER", () => {
    const huge = "900719925474099300000"
    const held = "900719925474099299999"
    const rowAttempt = attempt("huge", PurchaseAttemptState.QUOTA_HELD, false)
    const rowHold = hold(
      "huge",
      "capacity-huge",
      "item-huge",
      held,
      AllocationHoldState.HELD
    )
    const input: LedgerProjectionInput = {
      ...baseInput(),
      checkpoints: [
        checkpoint("capacity-huge", "item-huge", huge, huge, "0", "0"),
      ],
      capacities: [capacity("capacity-huge", "item-huge", huge, held, "0")],
      attempts: [rowAttempt],
      holds: [rowHold],
      movements: [
        movement(
          "movement-huge",
          rowAttempt,
          rowHold,
          CapacityMovementKind.HOLD,
          "2"
        ),
      ],
    }
    expect(
      reconcileCapacityLedgerProjection(input).expected_capacities[0]
    ).toMatchObject({
      granted_quantity: huge,
      available_quantity: "1",
      held_quantity: held,
      consumed_quantity: "0",
    })
  })

  it("keeps legacy opening held in a v1 cutover projection", () => {
    const legacyAttempt = attempt(
      "legacy",
      PurchaseAttemptState.QUOTA_HELD,
      false,
      null
    )
    const legacyHold = hold(
      "legacy",
      "capacity-legacy",
      "item-legacy",
      "3",
      AllocationHoldState.HELD
    )
    const input: LedgerProjectionInput = {
      ...baseInput(),
      control: { ...baseInput().control!, schema_version: "1" },
      checkpoints: [
        checkpoint(
          "capacity-legacy",
          "item-legacy",
          "10",
          "7",
          "3",
          "0",
          CapacityMovementCheckpointKind.CUTOVER
        ),
      ],
      capacities: [
        capacity("capacity-legacy", "item-legacy", "10", "3", "0"),
      ],
      attempts: [legacyAttempt],
      holds: [legacyHold],
      movements: [],
    }
    expect(
      reconcileCapacityLedgerProjection(input).expected_capacities[0]
    ).toMatchObject({ available_quantity: "7", held_quantity: "3" })
  })

  it("allows a legacy Hold with a post-cutover terminal binding", () => {
    const rowAttempt: LedgerAttemptEntity = {
      ...attempt("legacy-consume", PurchaseAttemptState.QUOTA_CONSUMED, true),
      hold_movement_activation_id: null,
    }
    const rowHold = hold(
      rowAttempt.id,
      "capacity-legacy-terminal",
      "item-legacy-terminal",
      "3",
      AllocationHoldState.CONSUMED
    )
    const input: LedgerProjectionInput = {
      ...baseInput(),
      checkpoints: [
        checkpoint(
          rowHold.capacity_id,
          rowHold.campaign_item_id,
          "10",
          "7",
          "3",
          "0",
          CapacityMovementCheckpointKind.CUTOVER
        ),
      ],
      capacities: [
        capacity(
          rowHold.capacity_id,
          rowHold.campaign_item_id,
          "10",
          "0",
          "3"
        ),
      ],
      attempts: [rowAttempt],
      holds: [rowHold],
      movements: [
        movement(
          "movement-legacy-consume",
          rowAttempt,
          rowHold,
          CapacityMovementKind.CONSUME,
          "4"
        ),
      ],
    }
    expect(reconcileCapacityLedgerProjection(input)).toMatchObject({
      status: "healthy",
      expected_capacities: [
        { available_quantity: "7", held_quantity: "0", consumed_quantity: "3" },
      ],
    })
  })

  it("aggregates independently across multiple items and capacities", () => {
    const input = baseInput()
    const secondAttempt = attempt(
      "second",
      PurchaseAttemptState.QUOTA_HELD,
      false
    )
    const secondHold = hold(
      "second",
      "capacity-2",
      "item-2",
      "4",
      AllocationHoldState.HELD
    )
    const result = reconcileCapacityLedgerProjection({
      ...input,
      checkpoints: [
        ...input.checkpoints,
        checkpoint("capacity-2", "item-2", "20", "20", "0", "0"),
      ],
      capacities: [
        ...input.capacities,
        capacity("capacity-2", "item-2", "20", "4", "0"),
      ],
      attempts: [...input.attempts, secondAttempt],
      holds: [...input.holds, secondHold],
      movements: [
        ...input.movements,
        movement(
          "movement-second-hold",
          secondAttempt,
          secondHold,
          CapacityMovementKind.HOLD,
          "2"
        ),
      ],
    })
    expect(result.expected_capacities).toHaveLength(2)
    expect(result.expected_capacities[1]).toMatchObject({
      capacity_id: "capacity-2",
      available_quantity: "16",
      held_quantity: "4",
    })
  })

  it("keeps root schema v1/v2 distinct from Movement tuple schema v1", () => {
    expect(isCheckpointKindAllowedForRootSchema("1", "cutover")).toBe(true)
    expect(isCheckpointKindAllowedForRootSchema("1", "provision")).toBe(false)
    expect(isCheckpointKindAllowedForRootSchema("2", "cutover")).toBe(true)
    expect(isCheckpointKindAllowedForRootSchema("2", "provision")).toBe(true)
    expect(isCheckpointKindAllowedForRootSchema("3", "cutover")).toBe(false)

    const input = baseInput()
    const result = reconcileCapacityLedgerProjection({
      ...input,
      movements: [
        { ...input.movements[0], schema_version: "2" },
        ...input.movements.slice(1),
      ],
    })
    expect(result).toMatchObject({
      status: "manual_required",
      classification: "manual_required",
      issues: [
        { code: LedgerReconciliationIssueCode.UNSUPPORTED_MOVEMENT_SCHEMA },
      ],
    })
  })

  it("reports a clean pre-activation state without inventing ledger authority", () => {
    const result = reconcileCapacityLedgerProjection({
      ...baseInput(),
      control: null,
      checkpoints: [],
      movements: [],
      attempts: [],
      holds: [],
    })
    expect(result).toEqual({
      status: "not_activated",
      classification: null,
      expected_capacities: [],
      issues: [],
      subject_counter_derivation: "not_ledger_derived",
    })
  })

  it("classifies held/consumed/raw-only drift as safe only outside OPEN", () => {
    const input = baseInput()
    const drifted: LedgerCapacityEntity = {
      ...input.capacities[0],
      held_quantity: "1",
      consumed_quantity: "2",
      raw_held_quantity: raw("99"),
    }
    const safe = reconcileCapacityLedgerProjection({
      ...input,
      capacities: [drifted],
      repair_scope: "paused",
    })
    expect(safe.status).toBe("drift")
    expect(safe.classification).toBe("safe_repair")
    expect(safe.issues.map((entry) => entry.code)).toEqual([
      LedgerReconciliationIssueCode.HELD_QUANTITY_DRIFT,
      LedgerReconciliationIssueCode.CONSUMED_QUANTITY_DRIFT,
      LedgerReconciliationIssueCode.RAW_MIRROR_DRIFT,
    ])

    const open = reconcileCapacityLedgerProjection({
      ...input,
      capacities: [drifted],
      repair_scope: "open",
    })
    expect(open.status).toBe("manual_required")
    expect(open.classification).toBe("manual_required")
  })

  it("always classifies granted drift as manual-required", () => {
    const input = baseInput()
    const result = reconcileCapacityLedgerProjection({
      ...input,
      capacities: [
        {
          ...input.capacities[0],
          granted_quantity: "11",
          raw_granted_quantity: raw("11"),
        },
      ],
    })
    expect(result).toMatchObject({
      status: "manual_required",
      classification: "manual_required",
    })
    expect(result.issues.map((entry) => entry.code)).toContain(
      LedgerReconciliationIssueCode.GRANTED_QUANTITY_DRIFT
    )
  })

  it("classifies raw granted mirror drift as manual-required", () => {
    const input = baseInput()
    const result = reconcileCapacityLedgerProjection({
      ...input,
      capacities: [
        { ...input.capacities[0], raw_granted_quantity: raw("9") },
      ],
    })
    expect(result).toMatchObject({
      status: "manual_required",
      classification: "manual_required",
      issues: [
        { code: LedgerReconciliationIssueCode.RAW_GRANTED_MIRROR_DRIFT },
      ],
    })
  })

  it.each([
    [PurchaseAttemptState.PENDING, "1"],
    [PurchaseAttemptState.QUOTA_REJECTED, "2"],
  ])("rejects %s Attempts that retain illegal Holds", (state, version) => {
    const input = baseInput()
    const illegalAttempt: LedgerAttemptEntity = {
      ...input.attempts[0],
      state,
      version,
      settlement_id: null,
      hold_movement_activation_id: null,
      terminal_movement_activation_id: null,
    }
    const result = reconcileCapacityLedgerProjection({
      ...input,
      attempts: [illegalAttempt],
      holds: [input.holds[0]],
      movements: [],
      capacities: [capacity("capacity-1", "item-1", "10", "0", "0")],
    })
    expect(result.status).toBe("manual_required")
    expect(result.issues[0].code).toBe(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH
    )
  })

  it("rejects an orphan non-null binding without a Hold set", () => {
    const input = baseInput()
    const result = reconcileCapacityLedgerProjection({
      ...input,
      attempts: [attempt("orphan", PurchaseAttemptState.QUOTA_HELD, false)],
      holds: [],
      movements: [],
      capacities: [capacity("capacity-1", "item-1", "10", "0", "0")],
    })
    expect(result.status).toBe("manual_required")
    expect(result.issues[0].code).toBe(
      LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH
    )
  })

  it.each([
    [
      "PENDING Attempt with a HELD fact",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        attempts: [
          {
            ...input.attempts[0],
            state: PurchaseAttemptState.PENDING,
            version: "1",
            settlement_id: null,
            hold_movement_activation_id: null,
            terminal_movement_activation_id: null,
          },
        ],
        holds: [input.holds[0]],
        movements: [],
      }),
    ],
    [
      "CONSUMED Attempt with a HELD fact",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        holds: [
          input.holds[0],
          { ...input.holds[1], state: AllocationHoldState.HELD },
          ...input.holds.slice(2),
        ],
      }),
    ],
  ])("rejects %s", (_, mutate) => {
    const result = reconcileCapacityLedgerProjection(mutate(baseInput()))
    expect(result.status).toBe("manual_required")
    expect(result.issues[0].code).toBe(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH
    )
  })

  it.each([
    ["settlement release with v3 Movement", "settlement-release", "4", "3"],
    ["direct release with v4 Movement", null, "3", "4"],
  ])(
    "rejects %s",
    (_, settlementId, attemptVersion, movementVersion) => {
      const input = baseInput()
      const releasedIndex = input.attempts.findIndex(
        (row) => row.id === "released"
      )
      const movementIndex = input.movements.findIndex(
        (row) =>
          row.attempt_id === "released" &&
          row.kind === CapacityMovementKind.RELEASE
      )
      const attempts = [...input.attempts]
      attempts[releasedIndex] = {
        ...attempts[releasedIndex],
        settlement_id: settlementId,
        version: attemptVersion,
      }
      const movements = [...input.movements]
      movements[movementIndex] = {
        ...movements[movementIndex],
        transition_version: movementVersion,
      }
      const result = reconcileCapacityLedgerProjection({
        ...input,
        attempts,
        movements,
      })
      expect(result.status).toBe("manual_required")
      expect(result.issues[0].code).toBe(
        LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH
      )
    }
  )

  it.each([
    ["wrong Capacity", { capacity_id: "missing-capacity" }],
    ["wrong item", { campaign_item_id: "wrong-item" }],
  ])("rejects a legacy Hold with %s", (_, holdPatch) => {
    const input = baseInput()
    const legacyAttempt: LedgerAttemptEntity = {
      ...input.attempts[0],
      hold_movement_activation_id: null,
    }
    const result = reconcileCapacityLedgerProjection({
      ...input,
      attempts: [legacyAttempt],
      holds: [{ ...input.holds[0], ...holdPatch }],
      movements: [],
      capacities: [capacity("capacity-1", "item-1", "10", "0", "0")],
    })
    expect(result.status).toBe("manual_required")
    expect(result.issues[0].code).toBe(
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH
    )
  })

  it.each([
    [
      "unverified root",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        verification: {
          ...input.verification,
          checkpoint_root_verified: false,
        },
      }),
      LedgerReconciliationIssueCode.CHECKPOINT_ROOT_UNVERIFIED,
    ],
    [
      "soft-deleted evidence",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          { ...input.movements[0], deleted_at: "2026-09-21T00:00:00Z" },
          ...input.movements.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.SOFT_DELETED_EVIDENCE,
    ],
    [
      "wrong Attempt binding",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        attempts: [
          { ...input.attempts[0], hold_movement_activation_id: "wrong" },
          ...input.attempts.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.ATTEMPT_BINDING_MISMATCH,
    ],
    [
      "ledger/fact mismatch",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        holds: [
          { ...input.holds[0], quantity: "9", raw_quantity: raw("9") },
          ...input.holds.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.LEDGER_FACT_MISMATCH,
    ],
  ])("fails %s closed as manual-required", (_, mutate, expectedCode) => {
    const result = reconcileCapacityLedgerProjection(mutate(baseInput()))
    expect(result.status).toBe("manual_required")
    expect(result.classification).toBe("manual_required")
    expect(result.issues[0].code).toBe(expectedCode)
  })

  it.each([
    [
      "negative decimal",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          { ...input.movements[0], quantity: "-1", raw_quantity: raw("-1") },
          ...input.movements.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.INVALID_DECIMAL,
    ],
    [
      "unsupported route",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          {
            ...input.movements[0],
            from_bucket: CapacityMovementBucket.HELD,
          },
          ...input.movements.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.UNSUPPORTED_MOVEMENT_ROUTE,
    ],
    [
      "unsupported version",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          { ...input.movements[0], transition_version: "9" },
          ...input.movements.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.UNSUPPORTED_TRANSITION_VERSION,
    ],
    [
      "duplicate identity",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          ...input.movements,
          { ...input.movements[0], id: "duplicate-id" },
        ],
      }),
      LedgerReconciliationIssueCode.DUPLICATE_MOVEMENT_IDENTITY,
    ],
    [
      "checkpoint non-conservation",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        checkpoints: [
          {
            ...input.checkpoints[0],
            opening_available_quantity: "9",
            raw_opening_available_quantity: raw("9"),
          },
        ],
      }),
      LedgerReconciliationIssueCode.CHECKPOINT_CONSERVATION_VIOLATION,
    ],
    [
      "Movement Capacity identity mismatch",
      (input: LedgerProjectionInput): LedgerProjectionInput => ({
        ...input,
        movements: [
          { ...input.movements[0], campaign_item_id: "wrong-item" },
          ...input.movements.slice(1),
        ],
      }),
      LedgerReconciliationIssueCode.CHECKPOINT_IDENTITY_MISMATCH,
    ],
  ])("rejects %s without partial projection", (_, mutate, expectedCode) => {
    const result = reconcileCapacityLedgerProjection(mutate(baseInput()))
    expect(result).toMatchObject({
      status: "manual_required",
      classification: "manual_required",
      expected_capacities: [],
    })
    expect(result.issues[0].code).toBe(expectedCode)
  })
})
