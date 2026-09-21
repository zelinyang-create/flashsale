import {
  AllocationOutboxEventName,
  buildAllocationOutboxEnvelope,
  canonicalJson,
  compareUtf16CodeUnits,
  validateAllocationOutboxPayload,
} from "../allocation-outbox"
import { AllocationHoldState, PurchaseAttemptState } from "../../../../types"
import {
  ClaimedAllocationHold,
  ClaimedPurchaseAttempt,
} from "../../application"

const now = new Date("2026-09-20T20:00:00.000Z")

function attempt(
  state: PurchaseAttemptState,
  overrides: Partial<ClaimedPurchaseAttempt> = {}
): ClaimedPurchaseAttempt {
  return {
    id: "fsatt_test",
    allocation_policy_id: "policy_test",
    campaign_id: "campaign_test",
    subject_id: "customer-secret",
    cart_id: "cart_test",
    idempotency_key_hash: "a".repeat(64),
    request_hash: "b".repeat(64),
    state,
    rules_version: 3,
    expires_at: now,
    version: 2,
    last_error_code: null,
    terminal_at: null,
    settlement_id: null,
    settlement_started_at: null,
    hold_movement_activation_id: null,
    terminal_movement_activation_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  }
}

function hold(item: string, quantity: number): ClaimedAllocationHold {
  return {
    id: `hold-${item}`,
    attempt_id: "fsatt_test",
    capacity_id: `capacity-${item}`,
    campaign_item_id: item,
    quantity,
    state: AllocationHoldState.HELD,
    expires_at: now,
    version: 1,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
}

describe("allocation outbox envelope", () => {
  it("canonicalizes object keys and sorts business items before hashing", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}'
    )
    const first = buildAllocationOutboxEnvelope(
      attempt(PurchaseAttemptState.QUOTA_HELD),
      [hold("item-b", 2), hold("item-a", 1)]
    )
    const second = buildAllocationOutboxEnvelope(
      attempt(PurchaseAttemptState.QUOTA_HELD),
      [hold("item-a", 1), hold("item-b", 2)]
    )
    expect(first).toEqual(second)
    expect(first.event_name).toBe(AllocationOutboxEventName.QUOTA_HELD)
    expect(first.payload.items.map((item) => item.campaign_item_id)).toEqual([
      "item-a",
      "item-b",
    ])
    expect(canonicalJson(first.payload)).not.toContain("customer-secret")
    expect(canonicalJson(first.payload)).not.toContain("a".repeat(64))
  })

  it("sorts punctuation, case, and non-ASCII IDs by UTF-16 code units", () => {
    const ids = ["中", "é", "a", "A", "😀", "_", "-", "0", "Ω"]
    const localeCompare = jest
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("localeCompare must not participate in event identity")
      })
    try {
      const first = buildAllocationOutboxEnvelope(
        attempt(PurchaseAttemptState.QUOTA_HELD),
        ids.map((id) => hold(id, 1))
      )
      const second = buildAllocationOutboxEnvelope(
        attempt(PurchaseAttemptState.QUOTA_HELD),
        [...ids].reverse().map((id) => hold(id, 1))
      )
      expect(first.payload.items.map((item) => item.campaign_item_id)).toEqual([
        "-",
        "0",
        "A",
        "_",
        "a",
        "é",
        "Ω",
        "中",
        "😀",
      ])
      expect(first.event_hash).toBe(second.event_hash)
      expect(["😀", "é", "A"].sort(compareUtf16CodeUnits)).toEqual([
        "A",
        "é",
        "😀",
      ])
    } finally {
      localeCompare.mockRestore()
    }
  })

  it("distinguishes cancellation and settlement release without leaking command data", () => {
    const canceled = buildAllocationOutboxEnvelope(
      attempt(PurchaseAttemptState.QUOTA_RELEASED, { version: 3 }),
      [hold("item-a", 1)]
    )
    const released = buildAllocationOutboxEnvelope(
      attempt(PurchaseAttemptState.QUOTA_RELEASED, {
        version: 4,
        settlement_id: "checkout-execution-1",
        settlement_started_at: now,
      }),
      [hold("item-a", 1)]
    )
    expect(canceled.payload.release_kind).toBe("held_cancel")
    expect(released.payload.release_kind).toBe("settlement_release")
    expect(released.event_hash).not.toBe(canceled.event_hash)
  })

  it.each([
    [PurchaseAttemptState.QUOTA_HELD, AllocationOutboxEventName.QUOTA_HELD, {}],
    [
      PurchaseAttemptState.QUOTA_REJECTED,
      AllocationOutboxEventName.QUOTA_REJECTED,
      { last_error_code: "CAPACITY_EXHAUSTED" },
    ],
    [
      PurchaseAttemptState.QUOTA_COMMITTING,
      AllocationOutboxEventName.QUOTA_COMMITTING,
      { settlement_id: "execution-1", settlement_started_at: now },
    ],
    [
      PurchaseAttemptState.QUOTA_CONSUMED,
      AllocationOutboxEventName.QUOTA_CONSUMED,
      { settlement_id: "execution-1", settlement_started_at: now },
    ],
    [
      PurchaseAttemptState.QUOTA_RELEASED,
      AllocationOutboxEventName.QUOTA_RELEASED,
      {},
    ],
    [
      PurchaseAttemptState.QUOTA_EXPIRED,
      AllocationOutboxEventName.QUOTA_EXPIRED,
      {},
    ],
  ])("maps %s to its versioned catalog name", (state, eventName, overrides) => {
    expect(
      buildAllocationOutboxEnvelope(
        attempt(state, overrides as Partial<ClaimedPurchaseAttempt>),
        []
      ).event_name
    ).toBe(eventName)
  })

  it("rejects sensitive or oversized payloads", () => {
    expect(() =>
      validateAllocationOutboxPayload({
        attempt_id: "a",
        campaign_id: "c",
        rules_version: 1,
        state: PurchaseAttemptState.QUOTA_HELD,
        items: [],
        subject_id: "secret",
      } as never)
    ).toThrow("Sensitive allocation outbox field")
    expect(() =>
      validateAllocationOutboxPayload({
        attempt_id: "x".repeat(66_000),
        campaign_id: "c",
        rules_version: 1,
        state: PurchaseAttemptState.QUOTA_HELD,
        items: [],
      })
    ).toThrow("exceeds 65536 bytes")
  })

  it("rejects the non-business PENDING state", () => {
    expect(() =>
      buildAllocationOutboxEnvelope(attempt(PurchaseAttemptState.PENDING), [])
    ).toThrow("Pending attempts")
  })
})
