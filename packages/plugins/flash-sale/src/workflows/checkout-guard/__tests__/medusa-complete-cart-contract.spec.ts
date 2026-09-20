import fs from "fs"
import path from "path"

const corePath = path.resolve(
  __dirname,
  "../../../../../../core/core-flows/src/cart"
)
const workflowSdkPath = path.resolve(
  __dirname,
  "../../../../../../core/workflows-sdk/src"
)
const lockingStepsPath = path.resolve(
  __dirname,
  "../../../../../../core/core-flows/src/locking/steps"
)
const transactionOrchestratorPath = path.resolve(
  __dirname,
  "../../../../../../core/orchestration/src/transaction/transaction-orchestrator.ts"
)

describe("Medusa complete-cart source contract", () => {
  it("keeps the public validate hook before Pending Order, reserve, and payment", () => {
    const source = fs.readFileSync(
      path.join(corePath, "workflows/complete-cart.ts"),
      "utf8"
    )
    const validate = source.indexOf('createHook("validate"')
    const pendingOrder = source.indexOf("createOrdersStep([cartToOrder])")
    const physicalReserve = source.indexOf(
      "reserveInventoryStep(formatedInventoryItems)"
    )
    const payment = source.indexOf("authorizePaymentSessionStep({")
    expect([validate, pendingOrder, physicalReserve, payment]).not.toContain(-1)
    expect(validate).toBeLessThan(pendingOrder)
    expect(pendingOrder).toBeLessThan(physicalReserve)
    expect(physicalReserve).toBeLessThan(payment)
  })

  it("records that the current core step does not sort multi-item lock keys", () => {
    const source = fs.readFileSync(
      path.join(corePath, "steps/reserve-inventory.ts"),
      "utf8"
    )
    const lockKeys = "Array.from(new Set(inventoryItemIds))"
    expect(source).toContain(lockKeys)
    const first = source.indexOf(lockKeys)
    const execute = source.indexOf("locking.execute(lockingKeys", first)
    expect(execute).toBeGreaterThan(first)
    expect(source.slice(first, execute)).not.toContain(".sort(")

    const canonicalizeLikeCurrentCore = (ids: string[]) => [...new Set(ids)]
    expect(canonicalizeLikeCurrentCore(["inventory-b", "inventory-a"])).toEqual(
      ["inventory-b", "inventory-a"]
    )
    expect(canonicalizeLikeCurrentCore(["inventory-a", "inventory-b"])).toEqual(
      ["inventory-a", "inventory-b"]
    )
  })

  it("keeps the public inventory-stage identity and clean REVERTED semantics", () => {
    const reserve = fs.readFileSync(
      path.join(corePath, "steps/reserve-inventory.ts"),
      "utf8"
    )
    const orchestrator = fs.readFileSync(transactionOrchestratorPath, "utf8")

    expect(reserve).toContain(
      'export const reserveInventoryStepId = "reserve-inventory-step"'
    )
    expect(orchestrator).toMatch(
      /if \(result\.hasFailed\) \{\s+flow\.state = TransactionState\.FAILED\s+\} else \{\s+flow\.state = result\.hasReverted\s+\? TransactionState\.REVERTED\s+: TransactionState\.DONE/
    )
  })

  it("exposes the actual workflow transaction id to public hook handlers", () => {
    const stepHandler = fs.readFileSync(
      path.join(
        workflowSdkPath,
        "utils/composer/helpers/create-step-handler.ts"
      ),
      "utf8"
    )
    const workflowExport = fs.readFileSync(
      path.join(workflowSdkPath, "helper/workflow-export.ts"),
      "utf8"
    )
    expect(stepHandler).toContain(
      "transactionId: stepArguments.context!.transactionId"
    )
    expect(workflowExport).toContain(
      'context.transactionId ??= "auto-" + uniqId'
    )
  })

  it.each(["acquire-lock.ts", "release-lock.ts"])(
    "skips the upstream %s step inside a parent-owned sub-workflow",
    (fileName) => {
      const source = fs.readFileSync(
        path.join(lockingStepsPath, fileName),
        "utf8"
      )

      expect(source).toContain("parentStepIdempotencyKey")
      expect(source).toMatch(
        /const isSubWorkflow = !!parentStepIdempotencyKey\s+if \(isSubWorkflow && !data\.executeOnSubWorkflow\) \{\s+return StepResponse\.skip\(\)/
      )
    }
  )
})
