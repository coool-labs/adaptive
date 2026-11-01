// covers: ["ADP-023"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { SideEffectLedger } from "../../../src/execution/continuation/ledger.js"

describe("SideEffectLedger", () => {
  it("reports unknown units as side-effect free", () => {
    const ledger = new SideEffectLedger()
    expect(ledger.had("s1#1")).toBe(false)
  })

  it("marks a unit and reports it", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    expect(ledger.had("s1#1")).toBe(true)
  })

  it("mark is idempotent", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    ledger.mark("s1#1")
    expect(ledger.had("s1#1")).toBe(true)
  })

  it("forgets a unit on close", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    ledger.forget("s1#1")
    expect(ledger.had("s1#1")).toBe(false)
  })

  it("forgetting an unknown unit is a no-op", () => {
    const ledger = new SideEffectLedger()
    expect(() => {
      ledger.forget("s1#1")
    }).not.toThrow()
  })

  it("units are independent", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    expect(ledger.had("s1#2")).toBe(false)
    expect(ledger.had("s2#1")).toBe(false)
  })

  it("forgets every episode of a session without touching others", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    ledger.mark("s1#2")
    ledger.mark("s10#1")
    ledger.mark("s2#1")
    ledger.forgetSession("s1")
    expect(ledger.had("s1#1")).toBe(false)
    expect(ledger.had("s1#2")).toBe(false)
    expect(ledger.had("s10#1")).toBe(true)
    expect(ledger.had("s2#1")).toBe(true)
  })

  it("keeps entries when a unit re-marks after forget", () => {
    const ledger = new SideEffectLedger()
    ledger.mark("s1#1")
    ledger.forget("s1#1")
    ledger.mark("s1#1")
    expect(ledger.had("s1#1")).toBe(true)
  })

  it("tracks side-effect state across a full unit lifecycle", () => {
    const ledger = new SideEffectLedger()
    expect(ledger.had("s1#1")).toBe(false)
    ledger.mark("s1#1")
    expect(ledger.had("s1#1")).toBe(true)
    ledger.forget("s1#1")
    expect(ledger.had("s1#1")).toBe(false)
    expect(ledger.had("s1#2")).toBe(false)
  })
})

describe("SideEffectLedger properties", () => {
  it("mark/had/forget behave consistently over arbitrary sequences", () => {
    const unitIDs = fc.integer({ min: 0, max: 9 }).map((n) => `s${String(n)}#1`)
    fc.assert(
      fc.property(
        fc.array(fc.record({ unit: unitIDs, op: fc.constantFrom("mark", "forget") }), {
          maxLength: 60,
        }),
        (ops) => {
          const ledger = new SideEffectLedger()
          const expected = new Set<string>()
          for (const { unit, op } of ops) {
            if (op === "mark") {
              ledger.mark(unit)
              expected.add(unit)
            } else {
              ledger.forget(unit)
              expected.delete(unit)
            }
            expect(ledger.had(unit)).toBe(expected.has(unit))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("mark on one session never leaks to a differently-prefixed session", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("#")),
        fc.integer({ min: 1, max: 5 }),
        (sessionID, episode) => {
          const ledger = new SideEffectLedger()
          const other = sessionID + "x"
          ledger.mark(`${sessionID}#${String(episode)}`)
          expect(ledger.had(`${other}#${String(episode)}`)).toBe(false)
          ledger.forgetSession(sessionID)
          expect(ledger.had(`${other}#${String(episode)}`)).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })
})
