import { PurchaseAttemptState } from "../../../../types"
import {
  AllocationCommandErrorCode,
  AllocationQuotaStore,
  HoldQuotaPersistenceInput,
  HoldQuotaResult,
} from "../contracts"
import { HoldQuotaHandler } from "../hold-quota"
import { calculateAllocationRetryDelayMs } from "../../persistence"

const result: HoldQuotaResult = {
  status: "rejected",
  replayed: false,
  error_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
  attempt: {
    id: "attempt",
    allocation_policy_id: "policy",
    campaign_id: "campaign",
    subject_id: "subject",
    cart_id: null,
    idempotency_key_hash: "a".repeat(64),
    request_hash: "b".repeat(64),
    state: PurchaseAttemptState.QUOTA_REJECTED,
    rules_version: 1,
    expires_at: new Date(),
    version: 2,
    last_error_code: AllocationCommandErrorCode.CAPACITY_EXHAUSTED,
    terminal_at: new Date(),
    settlement_id: null,
    settlement_started_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  },
}

function store(
  holdQuota: AllocationQuotaStore["holdQuota"]
): AllocationQuotaStore {
  return {
    claimAttempt: jest.fn(),
    claimAndHoldQuota: jest.fn(),
    cancelHeldQuota: jest.fn(),
    beginQuotaSettlement: jest.fn(),
    authorizeQuotaSettlement: jest.fn(),
    consumeQuotaSettlement: jest.fn(),
    releaseQuotaSettlement: jest.fn(),
    expireQuota: jest.fn(),
    expireDueQuota: jest.fn(),
    holdQuota,
  }
}

describe("HoldQuotaHandler", () => {
  it("computes the canonical hash and sorted items on the server", async () => {
    const holdQuota = jest.fn<
      Promise<HoldQuotaResult>,
      [HoldQuotaPersistenceInput]
    >(() => Promise.resolve(result))
    await new HoldQuotaHandler(store(holdQuota)).execute({
      attempt_id: "attempt",
      campaign_id: "campaign",
      subject_id: "subject",
      cart_id: null,
      expected_rules_version: 1,
      items: [
        { campaign_item_id: "B", quantity: 2 },
        { campaign_item_id: "A", quantity: 1 },
      ],
    })
    expect(holdQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt_id: "attempt",
        request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        items: [
          { campaign_item_id: "A", quantity: 1 },
          { campaign_item_id: "B", quantity: 2 },
        ],
      })
    )
  })

  it.each(["request_hash", "idempotency_key", "unexpected"])(
    "rejects unsupported top-level field %s",
    async (field) => {
      const holdQuota = jest.fn()
      await expect(
        new HoldQuotaHandler(store(holdQuota)).execute({
          attempt_id: "attempt",
          campaign_id: "campaign",
          subject_id: "subject",
          cart_id: null,
          expected_rules_version: 1,
          items: [{ campaign_item_id: "A", quantity: 1 }],
          [field]: "forbidden",
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      expect(holdQuota).not.toHaveBeenCalled()
    }
  )

  it("uses bounded exponential jitter delays", () => {
    expect(calculateAllocationRetryDelayMs(1, 0)).toBe(5)
    expect(calculateAllocationRetryDelayMs(2, 0.99)).toBe(14)
    expect(calculateAllocationRetryDelayMs(99, 0.99)).toBe(50)
  })
})
