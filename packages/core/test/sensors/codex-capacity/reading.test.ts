// covers: ["ADP-020"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  bindingWindow,
  readingFromUsage,
  CODEX_EVIDENCE,
} from "../../../src/sensors/codex-capacity/reading.js"

describe("bindingWindow", () => {
  it("returns primary when secondary is absent", () => {
    const usage = { primary: { usedPercent: 10 } }
    expect(bindingWindow(usage)).toEqual({ usedPercent: 10 })
  })

  it("returns secondary when primary is absent", () => {
    const usage = { secondary: { usedPercent: 70 } }
    expect(bindingWindow(usage)).toEqual({ usedPercent: 70 })
  })

  it("returns the more-consumed window", () => {
    const usage = { primary: { usedPercent: 30 }, secondary: { usedPercent: 80 } }
    expect(bindingWindow(usage)).toEqual({ usedPercent: 80 })
  })

  it("returns undefined for an empty snapshot", () => {
    expect(bindingWindow({})).toBeUndefined()
  })

  it("produces a no-measurement reading for an empty snapshot", () => {
    const reading = readingFromUsage({}, 1_500)
    expect("usedRatio" in reading).toBe(false)
    expect("remainingRatio" in reading).toBe(false)
    expect(reading.confidence).toBe("low")
    expect(reading.observedAt).toBe(1_500)
    expect(reading.evidence).toBe(CODEX_EVIDENCE)
  })

  it("breaks ties toward primary (deterministic)", () => {
    const usage = { primary: { usedPercent: 55 }, secondary: { usedPercent: 55 } }
    expect(bindingWindow(usage)).toEqual({ usedPercent: 55 })
  })
})

describe("readingFromUsage", () => {
  it("converts percentages to exact ratios", () => {
    const reading = readingFromUsage({ primary: { usedPercent: 17 } }, 1_000)
    expect(reading.usedRatio).toBeCloseTo(0.17, 12)
    expect(reading.remainingRatio).toBeCloseTo(0.83, 12)
  })

  it("anchors resetAt to the observation time via reset-after-seconds", () => {
    const reading = readingFromUsage(
      { primary: { usedPercent: 50, resetAfterSeconds: 120 } },
      5_000,
    )
    expect(reading.resetAt).toBe(5_000 + 120 * 1000)
  })

  it("prefers reset-after-seconds over reset-at", () => {
    const reading = readingFromUsage(
      { primary: { usedPercent: 50, resetAfterSeconds: 10, resetAtSeconds: 9_000_000 } },
      1_000,
    )
    expect(reading.resetAt).toBe(1_000 + 10 * 1000)
  })

  it("uses reset-at (epoch seconds) when reset-after is absent", () => {
    const reading = readingFromUsage(
      { secondary: { usedPercent: 1, resetAtSeconds: 12_345 } },
      1_000,
    )
    expect(reading.resetAt).toBe(12_345 * 1000)
  })

  it("omits resetAt when no reset field is present", () => {
    const reading = readingFromUsage({ primary: { usedPercent: 2 } }, 1_000)
    expect("resetAt" in reading).toBe(false)
  })

  it("grades complete telemetry high and percentage-only medium", () => {
    const complete = readingFromUsage({ primary: { usedPercent: 90, resetAfterSeconds: 60 } }, 0)
    expect(complete.confidence).toBe("high")
    const partial = readingFromUsage({ primary: { usedPercent: 90 } }, 0)
    expect(partial.confidence).toBe("medium")
    const resetAtOnly = readingFromUsage({ secondary: { usedPercent: 90, resetAtSeconds: 5 } }, 0)
    expect(resetAtOnly.confidence).toBe("high")
  })

  it("labels the evidence source without leaking header values", () => {
    const reading = readingFromUsage({ primary: { usedPercent: 5 } }, 0)
    expect(reading.evidence).toBe(CODEX_EVIDENCE)
    expect(CODEX_EVIDENCE).toBe("x-codex headers")
  })

  it("derives from the binding window", () => {
    const reading = readingFromUsage(
      { primary: { usedPercent: 20 }, secondary: { usedPercent: 95, resetAfterSeconds: 30 } },
      1_000,
    )
    expect(reading.usedRatio).toBeCloseTo(0.95, 12)
    expect(reading.remainingRatio).toBeCloseTo(0.05, 12)
    expect(reading.resetAt).toBe(1_000 + 30 * 1000)
  })

  it("property: exact boundary semantics — 100% used means remaining 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 2 ** 31 }),
        (percent, observedAt) => {
          const reading = readingFromUsage({ primary: { usedPercent: percent } }, observedAt)
          const used = reading.usedRatio
          const remaining = reading.remainingRatio ?? 0
          expect(used).toBeDefined()
          if (used === undefined) {
            return
          }
          expect(used).toBeCloseTo(percent / 100, 12)
          expect(used + remaining).toBeCloseTo(1, 12)
          if (percent === 100) {
            expect(reading.remainingRatio).toBe(0)
          }
          if (percent === 0) {
            expect(reading.usedRatio).toBe(0)
          }
          expect(reading.observedAt).toBe(observedAt)
        },
      ),
      { numRuns: 200 },
    )
  })
})
