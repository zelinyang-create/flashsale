import {
  ALLOCATION_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE,
  ALLOCATION_OUTBOX_SCHEMA_VERSION,
  AllocationEventIdentity,
  AllocationEventWireEnvelope,
  AllocationOutboxEventName,
  hashAllocationEventIdentity,
  normalizeAllocationEventWireEnvelope,
  validateAllocationEventWireEnvelope,
} from "../allocation-outbox-envelope"

function envelope(
  overrides: Partial<AllocationEventWireEnvelope> = {}
): AllocationEventWireEnvelope {
  const identity: AllocationEventIdentity = {
    event_name: AllocationOutboxEventName.QUOTA_HELD,
    schema_version: ALLOCATION_OUTBOX_SCHEMA_VERSION,
    aggregate_type: ALLOCATION_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: "attempt-envelope",
    aggregate_version: 2,
    payload: {
      attempt_id: "attempt-envelope",
      campaign_id: "campaign-envelope",
      rules_version: 1,
      state: "quota_held",
      items: [{ campaign_item_id: "item-envelope", quantity: 1 }],
    },
  }
  return {
    event_id: "event-envelope",
    ...identity,
    event_hash: hashAllocationEventIdentity(identity),
    occurred_at: "2026-09-20T20:00:00.000Z",
    ...overrides,
  }
}

describe("Allocation event wire envelope", () => {
  it("accepts the exact immutable schema and recomputed hash", () => {
    expect(() => validateAllocationEventWireEnvelope(envelope())).not.toThrow()
  })

  it("accepts the strict capacity-repair Apply envelope", () => {
    const identity: AllocationEventIdentity = {
      event_name: AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED,
      schema_version: 1,
      aggregate_type: ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE,
      aggregate_id: "fsraprun-envelope",
      aggregate_version: 1,
      payload: {
        apply_run_id: "fsraprun-envelope",
        plan_run_id: "fsreprun-envelope",
        campaign_id: "campaign-envelope",
        result_digest: "a".repeat(64),
        action_ids: ["fsrapact-a", "fsrapact-b"],
        ticket: "INC-3D2",
      },
    }
    expect(
      normalizeAllocationEventWireEnvelope({
        event_id: "fsaevt-repair-envelope",
        ...identity,
        event_hash: hashAllocationEventIdentity(identity),
        occurred_at: "2026-09-21T20:00:00.000Z",
      })
    ).toMatchObject(identity)
  })

  it("requires repair aggregate version 1 while quota remains monotonic", () => {
    const repairIdentity: AllocationEventIdentity = {
      event_name: AllocationOutboxEventName.CAPACITY_REPAIR_APPLIED,
      schema_version: 1,
      aggregate_type: ALLOCATION_REPAIR_OUTBOX_AGGREGATE_TYPE,
      aggregate_id: "fsraprun-version-two",
      aggregate_version: 2,
      payload: {
        apply_run_id: "fsraprun-version-two",
        plan_run_id: "fsreprun-version-two",
        campaign_id: "campaign-envelope",
        result_digest: "b".repeat(64),
        action_ids: ["fsrapact-version-two"],
        ticket: "INC-3D2",
      },
    }
    expect(() =>
      normalizeAllocationEventWireEnvelope({
        event_id: "fsaevt-version-two",
        ...repairIdentity,
        event_hash: hashAllocationEventIdentity(repairIdentity),
        occurred_at: "2026-09-21T20:00:00.000Z",
      })
    ).toThrow("envelope")

    const quotaV3 = envelope({ aggregate_version: 3 })
    const quotaIdentity: AllocationEventIdentity = {
      event_name: quotaV3.event_name,
      schema_version: quotaV3.schema_version,
      aggregate_type: quotaV3.aggregate_type,
      aggregate_id: quotaV3.aggregate_id,
      aggregate_version: quotaV3.aggregate_version,
      payload: quotaV3.payload,
    }
    expect(() =>
      normalizeAllocationEventWireEnvelope({
        ...quotaV3,
        event_hash: hashAllocationEventIdentity(quotaIdentity),
      })
    ).not.toThrow()
  })

  it("rejects state/event drift, sensitive keys, and non-canonical items", () => {
    const base = envelope()
    for (const payload of [
      { ...base.payload, state: "quota_consumed" },
      { ...base.payload, subject_id: "customer-secret" },
      {
        ...base.payload,
        items: [
          { campaign_item_id: "z", quantity: 1 },
          { campaign_item_id: "a", quantity: 1 },
        ],
      },
    ]) {
      const identity = { ...base, payload }
      expect(() =>
        validateAllocationEventWireEnvelope({
          ...identity,
          event_hash: hashAllocationEventIdentity(identity),
        })
      ).toThrow()
    }
  })

  it("requires accessor-free plain records", () => {
    const candidate = envelope() as unknown as Record<string, unknown>
    let reads = 0
    Object.defineProperty(candidate, "event_id", {
      enumerable: true,
      configurable: true,
      get: () => `event-${++reads}`,
    })
    expect(() => validateAllocationEventWireEnvelope(candidate)).toThrow(
      "data properties"
    )
    expect(reads).toBe(0)
  })

  it("rejects symbol, non-enumerable, and inherited properties", () => {
    const withSymbol = envelope() as unknown as Record<PropertyKey, unknown>
    withSymbol[Symbol("hidden")] = "not-json"
    expect(() => normalizeAllocationEventWireEnvelope(withSymbol)).toThrow(
      "symbol"
    )

    const withNonEnumerable = envelope()
    Object.defineProperty(withNonEnumerable.payload, "hidden", {
      enumerable: false,
      value: "not-visible-to-json",
    })
    expect(() =>
      normalizeAllocationEventWireEnvelope(withNonEnumerable)
    ).toThrow("enumerable data properties")

    const withInheritedPayload = envelope()
    const inheritedPayload = Object.create(withInheritedPayload.payload)
    expect(() =>
      normalizeAllocationEventWireEnvelope({
        ...withInheritedPayload,
        payload: inheritedPayload,
      })
    ).toThrow("inherited")
  })

  it("does not invoke getters and rejects Proxy-backed drift", () => {
    const withGetter = envelope()
    let getterReads = 0
    Object.defineProperty(withGetter.payload, "state", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1
        return getterReads === 1 ? "quota_held" : "quota_consumed"
      },
    })
    expect(() => normalizeAllocationEventWireEnvelope(withGetter)).toThrow(
      "data properties"
    )
    expect(getterReads).toBe(0)

    const withProxy = envelope()
    let proxyReads = 0
    const driftingPayload = new Proxy(withProxy.payload, {
      get: (target, property, receiver) => {
        proxyReads += 1
        if (property === "state" && proxyReads > 1) return "quota_consumed"
        return Reflect.get(target, property, receiver)
      },
    })
    expect(() =>
      normalizeAllocationEventWireEnvelope({
        ...withProxy,
        payload: driftingPayload,
      })
    ).toThrow("Proxy")
    expect(proxyReads).toBe(0)
  })

  it("returns a detached, plain, deeply frozen wire snapshot", () => {
    const source = envelope()
    const normalized = normalizeAllocationEventWireEnvelope(source)
    const normalizedItems = normalized.payload.items as readonly Record<
      string,
      unknown
    >[]

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(normalized.payload)).toBe(Object.prototype)
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.payload)).toBe(true)
    expect(Object.isFrozen(normalized.payload.items)).toBe(true)
    expect(Object.isFrozen(normalizedItems[0])).toBe(true)
    expect(normalized.payload).not.toBe(source.payload)

    const sourceItems = source.payload.items as Record<string, unknown>[]
    sourceItems[0].quantity = 7
    expect(normalizedItems[0].quantity).toBe(1)
    expect(Reflect.set(normalized.payload, "state", "quota_consumed")).toBe(
      false
    )
  })

  it("rejects invalid hashes and event-specific optional fields", () => {
    expect(() =>
      validateAllocationEventWireEnvelope({
        ...envelope(),
        event_hash: "0".repeat(64),
      })
    ).toThrow("hash")
    const base = envelope()
    const payload = { ...base.payload, settlement_id: "unexpected" }
    const identity = { ...base, payload }
    expect(() =>
      validateAllocationEventWireEnvelope({
        ...identity,
        event_hash: hashAllocationEventIdentity(identity),
      })
    ).toThrow("fields")
  })
})
