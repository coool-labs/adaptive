/**
 * Safe-boundary gate for recovered preferred resources (ADP-016/ADP-018):
 * a unit's model is only ever changed at a safe boundary — never mid-work,
 * never while a failed execution is still settling.
 */
// covers: ["ADP-016", "ADP-018"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { UNIT_PHASES, recoveryWindow } from "../../../src/execution/recovery/gate.js"

describe("recoveryWindow", () => {
  it("opens at admission", () => {
    expect(recoveryWindow("admission")).toEqual({ kind: "open" })
  })

  it("opens when idle between episodes", () => {
    expect(recoveryWindow("idle")).toEqual({ kind: "open" })
  })

  it("closes while busy — running work is never pulled to another resource", () => {
    expect(recoveryWindow("busy")).toEqual({ kind: "closed", reason: "busy" })
  })

  it("closes while a failed execution is settling", () => {
    expect(recoveryWindow("settling")).toEqual({ kind: "closed", reason: "settling" })
  })

  it("exposes exactly the four host phases", () => {
    expect(UNIT_PHASES).toEqual(["admission", "busy", "settling", "idle"])
  })

  it("is deterministic", () => {
    expect(recoveryWindow("busy")).toEqual(recoveryWindow("busy"))
  })
})

describe("recoveryWindow properties", () => {
  it("closes exactly for busy and settling", () => {
    fc.assert(
      fc.property(fc.constantFrom(...UNIT_PHASES), (phase) => {
        const window = recoveryWindow(phase)
        const closed = phase === "busy" || phase === "settling"
        expect(window.kind === "closed").toBe(closed)
        if (window.kind === "closed") {
          expect(window.reason).toBe(phase)
        }
      }),
      { numRuns: 100 },
    )
  })
})
