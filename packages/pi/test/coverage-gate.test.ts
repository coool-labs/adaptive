// covers: ["ADP-037"]
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The coverage gate is part of the contract: every first-party source file
 * must stay at 100% across all four metrics with no exclusion gaming. This
 * test pins the configuration itself, so weakening the gate fails a test
 * instead of only failing a CI run someone might override.
 */
describe("coverage gate", () => {
  const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8")

  it("requires every metric at 100% and measures only first-party sources", () => {
    expect(config).toContain('include: ["src/**"]')
    expect(config).toContain(
      "thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }",
    )
  })
})
