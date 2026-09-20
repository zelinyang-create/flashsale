import { readFileSync } from "fs"
import path from "path"

describe("allocation reconciliation PostgreSQL compatibility", () => {
  it("keeps raw numeric validation on PostgreSQL 15-compatible primitives", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../postgres-allocation-reconciliation-store.ts"),
      "utf8"
    )

    expect(source).not.toContain("pg_input_is_valid")
    expect(source).toContain("length(${rawColumn}->>'value') <= 100")
    expect(source).toContain("~ '^[0-9]+([.][0-9]+){0,1}$'")
    expect(source).toContain("then (${rawColumn}->>'value')::numeric")
  })
})
