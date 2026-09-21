import {
  CHECKOUT_OUTBOX_AGGREGATE_TYPE,
  CHECKOUT_OUTBOX_SCHEMA_VERSION,
  CheckoutOutboxEventName,
  hashCheckoutEventIdentity,
  normalizeCheckoutEventWireEnvelope,
} from "../checkout-outbox-envelope"

function envelope() {
  const identity = {
    event_name: CheckoutOutboxEventName.PREPARED,
    schema_version: CHECKOUT_OUTBOX_SCHEMA_VERSION,
    aggregate_type: CHECKOUT_OUTBOX_AGGREGATE_TYPE,
    aggregate_id: "execution-1",
    aggregate_version: 1,
    payload: {
      execution_id: "execution-1",
      attempt_id: "attempt-1",
      campaign_id: "campaign-1",
      rules_version: 1,
      state: "prepared",
      items: [
        { campaign_item_id: "Item-A", variant_id: "variant-a", quantity: 1 },
        { campaign_item_id: "item-b", variant_id: "variant-b", quantity: 2 },
      ],
    },
  } as const
  return {
    event_id: "event-1",
    ...identity,
    event_hash: hashCheckoutEventIdentity(identity),
    occurred_at: "2026-09-20T20:00:00.000Z",
  }
}

describe("checkout outbox wire envelope", () => {
  it("returns a detached deeply frozen exact snapshot", () => {
    const input = envelope()
    const normalized = normalizeCheckoutEventWireEnvelope(input)
    expect(normalized).not.toBe(input)
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.payload)).toBe(true)
    expect(Object.isFrozen(normalized.payload.items)).toBe(true)
  })

  it.each([
    () => Object.assign(Object.create({ inherited: true }), envelope()),
    () => Object.defineProperty(envelope(), "hidden", { value: true }),
    () => Object.assign(envelope(), { [Symbol("hidden")]: true }),
    () => new Proxy(envelope(), {}),
    () => Object.defineProperty(envelope(), "event_id", {
      enumerable: true,
      get: () => "event-1",
    }),
  ])("rejects accessor, inherited, hidden, symbol, and Proxy inputs", (build) => {
    expect(() => normalizeCheckoutEventWireEnvelope(build())).toThrow()
  })

  it("never calls localeCompare and hashes punctuation/case/non-ASCII deterministically", () => {
    const spy = jest.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare must not be used")
    })
    expect(() => normalizeCheckoutEventWireEnvelope(envelope())).not.toThrow()
    spy.mockRestore()
  })

  it("rejects sensitive or state-inconsistent payload drift", () => {
    const input: any = envelope()
    input.payload.subject_id = "customer-1"
    input.event_hash = hashCheckoutEventIdentity(input)
    expect(() => normalizeCheckoutEventWireEnvelope(input)).toThrow()
  })
})
