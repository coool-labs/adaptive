/**
 * Operating-mode wrapper tests (GOAL operating modes; ADP-038 observe/control
 * identity is property-tested too).
 */
// covers: ["ADP-029", "ADP-038"]
import { describe, expect, it } from "vitest"
import { forMode } from "../../../src/core/scheduler/index.js"
import type { Decision } from "../../../src/core/scheduler/index.js"

const apply: Decision = {
  kind: "apply",
  model: { providerID: "p", id: "m" },
  tier: "standard",
  reason: "preferred",
  evidence: { skipped: [] },
}

describe("forMode", () => {
  it("returns the identical decision object under control", () => {
    expect(forMode(apply, "active")).toBe(apply)
  })

  it("wraps the identical decision object under observe", () => {
    const wrapped = forMode(apply, "observe")
    expect(wrapped).toEqual({ kind: "observe-only", would: apply })
    expect(wrapped.kind === "observe-only" ? wrapped.would : undefined).toBe(apply)
  })

  it("defers with adaptive-off when off", () => {
    expect(forMode(apply, "off")).toEqual({ kind: "defer", reason: "adaptive-off" })
  })
})
