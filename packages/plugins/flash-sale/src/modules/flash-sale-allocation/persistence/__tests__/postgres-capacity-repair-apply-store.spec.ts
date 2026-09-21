import { AllocationCommandErrorCode } from "../../application"
import {
  rethrowCapacityRepairApplyPersistenceError,
  shouldRetryCapacityRepairApplyTransaction,
} from "../postgres-capacity-repair-apply-store"

describe("capacity repair Apply persistence error mapping", () => {
  it("opens a fresh transaction only for serialization/deadlock or exact Plan/JTI conflicts", () => {
    expect(
      shouldRetryCapacityRepairApplyTransaction({
        originalError: {
          driverError: {
            code: "23505",
            constraint:
              "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique",
          },
        },
      })
    ).toBe(true)
    expect(
      shouldRetryCapacityRepairApplyTransaction({ cause: { code: "40001" } })
    ).toBe(true)
    expect(
      shouldRetryCapacityRepairApplyTransaction({
        code: "23505",
        constraint: "flash_sale_capacity_repair_apply_action_pkey",
      })
    ).toBe(false)
  })

  it.each([
    "IDX_flash_sale_capacity_repair_apply_run_plan_unique",
    "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique",
  ])("maps only the %s conflict after rollback", (constraint) => {
    try {
      rethrowCapacityRepairApplyPersistenceError({ code: "23505", constraint })
    } catch (error) {
      expect(error).toMatchObject({
        code: AllocationCommandErrorCode.REPAIR_APPLY_CONFLICT,
      })
      return
    }
    throw new Error("expected the exact Apply uniqueness conflict to throw")
  })

  it("recognizes a nested driver error without broadening the constraint allowlist", () => {
    try {
      rethrowCapacityRepairApplyPersistenceError({
        originalError: {
          driverError: {
            code: "23505",
            constraint:
              "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique",
          },
        },
      })
    } catch (error) {
      expect(error).toMatchObject({
        code: AllocationCommandErrorCode.REPAIR_APPLY_CONFLICT,
      })
      return
    }
    throw new Error("expected the nested Apply uniqueness conflict to throw")
  })

  it("does not reinterpret an unrelated unique violation as replay", () => {
    const error = {
      code: "23505",
      constraint: "flash_sale_capacity_repair_apply_action_pkey",
    }
    try {
      rethrowCapacityRepairApplyPersistenceError(error)
    } catch (caught) {
      expect(caught).toBe(error)
      return
    }
    throw new Error("expected the unrelated database error to be preserved")
  })

  it.each(["40001", "40P01"])(
    "maps an exhausted nested %s retry to a safe retryable error",
    (code) => {
      try {
        rethrowCapacityRepairApplyPersistenceError(
          { cause: { driverError: { code } } },
          true
        )
      } catch (error) {
        expect(error).toMatchObject({
          code: AllocationCommandErrorCode.LOCK_TIMEOUT_RETRYABLE,
          message: "capacity repair Apply transaction must be retried",
        })
        return
      }
      throw new Error("expected exhausted transaction retry to throw")
    }
  )
})
