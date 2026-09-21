import { CapacityMovementBucket, CapacityMovementKind } from "../../../../types"
import {
  AllocationDomainErrorCode,
  CapacityMovementFingerprintInput,
  createCapacityMovementFingerprint,
  normalizeCapacityMovementFingerprint,
  validateCapacityMovement,
} from "../index"

const movement = (
  overrides: Partial<CapacityMovementFingerprintInput> = {}
): CapacityMovementFingerprintInput => ({
  schema_version: 1,
  capacity_id: "capacity-1",
  attempt_id: "attempt-1",
  campaign_id: "campaign-1",
  subject_id: "subject-1",
  campaign_item_id: "item-1",
  transition_version: 2,
  kind: CapacityMovementKind.HOLD,
  from_bucket: CapacityMovementBucket.AVAILABLE,
  to_bucket: CapacityMovementBucket.HELD,
  quantity: "0002",
  ...overrides,
})

describe("capacity movement domain", () => {
  it("normalizes lossless quantity and produces a stable SHA-256 fingerprint", () => {
    const normalized = normalizeCapacityMovementFingerprint(movement())
    expect(normalized.quantity).toBe("2")
    expect(createCapacityMovementFingerprint(movement())).toMatch(
      /^[0-9a-f]{64}$/
    )
    expect(createCapacityMovementFingerprint(movement())).toBe(
      createCapacityMovementFingerprint(movement({ quantity: "2" }))
    )
  })

  it.each([
    {
      kind: CapacityMovementKind.HOLD,
      from_bucket: CapacityMovementBucket.HELD,
      to_bucket: CapacityMovementBucket.AVAILABLE,
    },
    { quantity: "0" },
    { quantity: "1.5" },
    { transition_version: 0 },
    { campaign_id: " campaign " },
  ])(
    "rejects malformed identities, quantities, versions, and routes",
    (bad) => {
      expect(() => normalizeCapacityMovementFingerprint(movement(bad))).toThrow(
        expect.objectContaining({
          code: AllocationDomainErrorCode.INVALID_CAPACITY_MOVEMENT,
        })
      )
    }
  )

  it("requires the persisted token to bind the complete immutable tuple", () => {
    const token = createCapacityMovementFingerprint(movement())
    expect(
      validateCapacityMovement({ ...movement(), fence_token: token })
    ).toMatchObject({ quantity: "2", fence_token: token })
    expect(() =>
      validateCapacityMovement({ ...movement(), fence_token: "A".repeat(64) })
    ).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.INVALID_CAPACITY_MOVEMENT,
      })
    )
    expect(() =>
      validateCapacityMovement({
        ...movement(),
        fence_token: createCapacityMovementFingerprint(
          movement({ transition_version: 3 })
        ),
      })
    ).toThrow(
      expect.objectContaining({
        code: AllocationDomainErrorCode.INVALID_CAPACITY_MOVEMENT,
      })
    )
  })
})
