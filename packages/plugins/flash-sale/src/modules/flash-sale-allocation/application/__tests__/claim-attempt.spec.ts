import {
  AllocationAttemptStore,
  AllocationCommandErrorCode,
  ClaimAttemptCommand,
  ClaimAttemptPersistenceInput,
  ClaimAttemptResult,
} from "../contracts"
import { ClaimAttemptHandler } from "../claim-attempt"
import { PurchaseAttemptState } from "../../../../types"

const IDEMPOTENCY_HASH = "a".repeat(64)

const persistedResult: ClaimAttemptResult = {
  replayed: false,
  attempt: {
    id: "fsatt_1",
    allocation_policy_id: "fsapol_1",
    campaign_id: "campaign-1",
    subject_id: "subject-1",
    cart_id: "cart-1",
    idempotency_key_hash: IDEMPOTENCY_HASH,
    request_hash: "b".repeat(64),
    state: PurchaseAttemptState.PENDING,
    rules_version: 4,
    expires_at: new Date("2030-01-01T00:05:00.000Z"),
    version: 1,
    last_error_code: null,
    terminal_at: null,
    settlement_id: null,
    settlement_started_at: null,
    created_at: new Date("2030-01-01T00:00:00.000Z"),
    updated_at: new Date("2030-01-01T00:00:00.000Z"),
    deleted_at: null,
  },
}

describe("ClaimAttemptHandler", () => {
  it("normalizes items and computes the request hash inside the server boundary", async () => {
    const claimAttempt = jest.fn<
      Promise<ClaimAttemptResult>,
      [ClaimAttemptPersistenceInput]
    >(() => Promise.resolve(persistedResult))
    const handler = new ClaimAttemptHandler({
      claimAttempt,
    } satisfies AllocationAttemptStore)

    await handler.execute({
      campaign_id: "campaign-1",
      subject_id: "subject-1",
      cart_id: "cart-1",
      idempotency_key_hash: IDEMPOTENCY_HASH,
      expected_rules_version: 4,
      items: [
        { campaign_item_id: "item-b", quantity: 2 },
        { campaign_item_id: "item-a", quantity: 1 },
      ],
    })

    expect(claimAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        request_hash:
          "c591a0d2269d7ce7b745b8dc5339fc310ca6ab05f08e845a9e93378d5acd03bf",
        items: [
          { campaign_item_id: "item-a", quantity: 1 },
          { campaign_item_id: "item-b", quantity: 2 },
        ],
      })
    )
  })

  it.each(["raw-key", "A".repeat(64), "a".repeat(63), "g".repeat(64)])(
    "rejects a non-lowercase-SHA256 idempotency digest",
    async (hash) => {
      const store: AllocationAttemptStore = {
        claimAttempt: jest.fn(),
      }
      const handler = new ClaimAttemptHandler(store)

      await expect(
        handler.execute({
          campaign_id: "campaign-1",
          subject_id: "subject-1",
          cart_id: null,
          idempotency_key_hash: hash,
          expected_rules_version: 1,
          items: [{ campaign_item_id: "item-1", quantity: 1 }],
        })
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_IDEMPOTENCY_KEY_HASH,
      })
      expect(store.claimAttempt).not.toHaveBeenCalled()
    }
  )

  it.each([null, 42, true, [], {}, { toString: () => "a".repeat(64) }])(
    "rejects a non-string idempotency digest at runtime",
    async (hash) => {
      const store: AllocationAttemptStore = {
        claimAttempt: jest.fn(),
      }
      const handler = new ClaimAttemptHandler(store)
      const command = {
        campaign_id: "campaign-1",
        subject_id: "subject-1",
        cart_id: null,
        idempotency_key_hash: hash,
        expected_rules_version: 1,
        items: [{ campaign_item_id: "item-1", quantity: 1 }],
      }

      await expect(
        handler.execute(command as unknown as ClaimAttemptCommand)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_IDEMPOTENCY_KEY_HASH,
      })
      expect(store.claimAttempt).not.toHaveBeenCalled()
    }
  )

  it.each(["idempotency_key", "request_hash"])(
    "rejects unsupported fields before they reach persistence",
    async (field) => {
      const store: AllocationAttemptStore = {
        claimAttempt: jest.fn(),
      }
      const handler = new ClaimAttemptHandler(store)
      const command = {
        campaign_id: "campaign-1",
        subject_id: "subject-1",
        cart_id: null,
        idempotency_key_hash: IDEMPOTENCY_HASH,
        expected_rules_version: 1,
        items: [{ campaign_item_id: "item-1", quantity: 1 }],
        [field]: "must-not-cross-the-boundary",
      }

      await expect(handler.execute(command)).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      expect(store.claimAttempt).not.toHaveBeenCalled()
    }
  )

  it.each(["idempotency_key", "request_hash", "unexpected"])(
    "rejects unsupported nested item fields before persistence",
    async (field) => {
      const store: AllocationAttemptStore = {
        claimAttempt: jest.fn(),
      }
      const handler = new ClaimAttemptHandler(store)
      const command = {
        campaign_id: "campaign-1",
        subject_id: "subject-1",
        cart_id: null,
        idempotency_key_hash: IDEMPOTENCY_HASH,
        expected_rules_version: 1,
        items: [
          {
            campaign_item_id: "item-1",
            quantity: 1,
            [field]: "must-not-cross-the-boundary",
          },
        ],
      }

      await expect(
        handler.execute(command as unknown as ClaimAttemptCommand)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      expect(store.claimAttempt).not.toHaveBeenCalled()
    }
  )

  it.each([null, 1, "item-1", []])(
    "rejects a non-object allocation item shape before persistence",
    async (item) => {
      const store: AllocationAttemptStore = {
        claimAttempt: jest.fn(),
      }
      const handler = new ClaimAttemptHandler(store)
      const command = {
        campaign_id: "campaign-1",
        subject_id: "subject-1",
        cart_id: null,
        idempotency_key_hash: IDEMPOTENCY_HASH,
        expected_rules_version: 1,
        items: [item],
      }

      await expect(
        handler.execute(command as unknown as ClaimAttemptCommand)
      ).rejects.toMatchObject({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
      expect(store.claimAttempt).not.toHaveBeenCalled()
    }
  )
})
