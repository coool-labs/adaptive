// covers: ["ADP-020"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"

import {
  capacityHealthEvent,
  capacitySignals,
  confidenceRank,
  MAX_EVIDENCE_LENGTH,
  mergeReadings,
  normalizeReading,
} from "../../../src/health/capacity/index.js"
import {
  CONFIDENCE_LEVELS,
  DEFAULT_CAPACITY_CONFIG,
  type CapacityReading,
} from "../../../src/health/capacity/types.js"

const NOW = 200_000

function reading(overrides: Partial<CapacityReading> = {}): CapacityReading {
  return { confidence: "high", observedAt: NOW, ...overrides }
}

function at(overrides: Partial<CapacityReading>, observedAt: number): CapacityReading {
  return reading({ ...overrides, observedAt })
}

describe("normalizeReading", () => {
  it("rejects non-object input outright", () => {
    expect(normalizeReading(null)).toBeNull()
    expect(normalizeReading(undefined)).toBeNull()
    expect(normalizeReading(42)).toBeNull()
    expect(normalizeReading("reading")).toBeNull()
  })

  it("rejects unknown confidence levels", () => {
    expect(normalizeReading({ confidence: "certain", observedAt: NOW })).toBeNull()
  })

  it("rejects a negative observedAt (telemetry cannot predate the epoch)", () => {
    expect(normalizeReading({ confidence: "high", observedAt: -1 })).toBeNull()
  })

  it("rejects a non-finite observedAt", () => {
    expect(normalizeReading({ confidence: "high", observedAt: Number.NaN })).toBeNull()
    expect(
      normalizeReading({ confidence: "high", observedAt: Number.POSITIVE_INFINITY }),
    ).toBeNull()
  })

  it("rejects a reading whose ratio is not a fraction in [0, 1]", () => {
    expect(normalizeReading(reading({ usedRatio: 1.5 }))).toBeNull()
    expect(normalizeReading(reading({ usedRatio: -0.1 }))).toBeNull()
    expect(normalizeReading(reading({ usedRatio: Number.NaN }))).toBeNull()
    expect(normalizeReading(reading({ remainingRatio: 2 }))).toBeNull()
    expect(normalizeReading(reading({ remainingRatio: Number.NEGATIVE_INFINITY }))).toBeNull()
  })

  it("keeps a reading with one valid ratio and drops only the invalid retry delay", () => {
    expect(normalizeReading(reading({ usedRatio: 0.5, retryAfterMs: -1 }))).toEqual({
      usedRatio: 0.5,
      confidence: "high",
      observedAt: NOW,
    })
    expect(normalizeReading(reading({ remainingRatio: 0.5, retryAfterMs: 1.5 }))).toEqual({
      remainingRatio: 0.5,
      confidence: "high",
      observedAt: NOW,
    })
    expect(normalizeReading(reading({ retryAfterMs: Number.POSITIVE_INFINITY }))).toBeNull()
  })

  it("drops invalid resetAt values but keeps the reading", () => {
    expect(normalizeReading(reading({ usedRatio: 1, resetAt: Number.NaN }))).toEqual({
      usedRatio: 1,
      confidence: "high",
      observedAt: NOW,
    })
    expect(normalizeReading(reading({ usedRatio: 1, resetAt: -5 }))).toEqual({
      usedRatio: 1,
      confidence: "high",
      observedAt: NOW,
    })
  })

  it("keeps retryAfterMs 0 (an immediate retry hint is still information)", () => {
    expect(normalizeReading(reading({ retryAfterMs: 0 }))).toEqual({
      retryAfterMs: 0,
      confidence: "high",
      observedAt: NOW,
    })
  })

  it("rejects readings that carry no measured field at all", () => {
    expect(normalizeReading(reading())).toBeNull()
  })

  it("truncates evidence to the bounded length", () => {
    const long = "x".repeat(MAX_EVIDENCE_LENGTH + 50)
    const normalized = normalizeReading(reading({ usedRatio: 0.5, evidence: long }))
    expect(normalized).toEqual({
      usedRatio: 0.5,
      confidence: "high",
      observedAt: NOW,
      evidence: "x".repeat(MAX_EVIDENCE_LENGTH),
    })
  })

  it("drops non-string evidence", () => {
    expect(
      normalizeReading(reading({ usedRatio: 0.5, evidence: 7 } as unknown as CapacityReading)),
    ).toEqual({
      usedRatio: 0.5,
      confidence: "high",
      observedAt: NOW,
    })
  })

  it("keeps a fully valid reading unchanged", () => {
    const valid = reading({
      usedRatio: 0.25,
      remainingRatio: 0.75,
      retryAfterMs: 500,
      resetAt: 99_999,
      evidence: "x-codex-primary-used-percent",
    })
    expect(normalizeReading(valid)).toEqual(valid)
  })
})

describe("confidenceRank", () => {
  it("orders low < medium < high", () => {
    expect(confidenceRank("low")).toBeLessThan(confidenceRank("medium"))
    expect(confidenceRank("medium")).toBeLessThan(confidenceRank("high"))
    expect(CONFIDENCE_LEVELS.map(confidenceRank)).toEqual([0, 1, 2])
  })
})

describe("mergeReadings", () => {
  it("returns null for no readings", () => {
    expect(mergeReadings([], NOW)).toBeNull()
  })

  it("returns null when every reading is stale (never guesses from expired data)", () => {
    const stale = at({ usedRatio: 0.5 }, NOW - DEFAULT_CAPACITY_CONFIG.maxAgeMs - 1)
    expect(mergeReadings([stale], NOW)).toBeNull()
  })

  it("treats the freshness boundary inclusively", () => {
    const edge = at({ usedRatio: 0.5 }, NOW - DEFAULT_CAPACITY_CONFIG.maxAgeMs)
    expect(mergeReadings([edge], NOW)).not.toBeNull()
    const expired = at({ usedRatio: 0.5 }, NOW - DEFAULT_CAPACITY_CONFIG.maxAgeMs - 1)
    expect(mergeReadings([expired], NOW)).toBeNull()
  })

  it("silently drops readings that fail normalization", () => {
    const garbage = { confidence: 3, observedAt: "now" } as unknown as CapacityReading
    const empty = reading()
    const valid = reading({ usedRatio: 0.5 })
    expect(mergeReadings([garbage, empty, valid], NOW)).toEqual(valid)
  })

  it("picks the highest-confidence reading as the base and follows its evidence", () => {
    const medium = at({ confidence: "medium", usedRatio: 0.9, evidence: "endpoint" }, NOW - 10)
    const high = at({ usedRatio: 0.2, evidence: "x-codex-primary-used-percent" }, NOW)
    const merged = mergeReadings([medium, high], NOW)
    // The base story comes from the high-confidence reading, but trust is
    // capped by the concurrent medium sensor: confidence is the survivor minimum.
    expect(merged).toEqual({
      usedRatio: 0.2,
      confidence: "medium",
      observedAt: NOW - 10,
      evidence: high.evidence,
    })
  })

  it("prefers the more conservative remaining ratio on equal confidence", () => {
    const abundant = reading({ confidence: "medium", remainingRatio: 0.9 })
    const scarce = reading({ confidence: "medium", remainingRatio: 0.2 })
    const merged = mergeReadings([abundant, scarce], NOW)
    expect(merged?.remainingRatio).toBe(0.2)
  })

  it("keeps input order when equal readings carry no remaining ratio", () => {
    const first = reading({ usedRatio: 0.3 })
    const second = reading({ usedRatio: 0.7 })
    expect(mergeReadings([first, second], NOW)?.usedRatio).toBe(0.3)
    expect(mergeReadings([second, first], NOW)?.usedRatio).toBe(0.7)
  })

  it("fills missing fields from lower-priority readings", () => {
    const base = reading({ confidence: "high", retryAfterMs: 5000 })
    const filler = reading({ confidence: "medium", remainingRatio: 0.4, resetAt: 50_000 })
    const merged = mergeReadings([base, filler], NOW)
    expect(merged).toEqual({
      retryAfterMs: 5000,
      remainingRatio: 0.4,
      resetAt: 50_000,
      confidence: "medium",
      observedAt: base.observedAt,
    })
  })

  it("never amplifies trust: a contradictory low-confidence sensor drags the merged confidence down", () => {
    // The low-confidence reading contributes no field (the base already
    // covers remaining), yet its existence unsettles the merged claim.
    const high = reading({ remainingRatio: 0.5 })
    const low = reading({ confidence: "low", remainingRatio: 0.99, observedAt: NOW - 5 })
    const merged = mergeReadings([high, low], NOW)
    expect(merged).toEqual({
      remainingRatio: 0.5,
      confidence: "low",
      observedAt: NOW - 5,
    })
  })

  it("reports the oldest surviving observation so the merged reading ages honestly", () => {
    const newer = at({ usedRatio: 0.5 }, NOW)
    const older = at({ usedRatio: 0.6 }, NOW - 2_000)
    expect(mergeReadings([newer, older], NOW)?.observedAt).toBe(NOW - 2_000)
  })

  it("is driven by the injected clock through the freshness window", () => {
    const fresh = at({ usedRatio: 0.5 }, 0)
    const lateConfig = { ...DEFAULT_CAPACITY_CONFIG, maxAgeMs: 10 }
    expect(mergeReadings([fresh], 10, lateConfig)).not.toBeNull()
    expect(mergeReadings([fresh], 11, lateConfig)).toBeNull()
  })
})

describe("capacitySignals", () => {
  it("signals exhaustion from exact bounds at any confidence", () => {
    expect(capacitySignals(reading({ confidence: "low", remainingRatio: 0 }))).toEqual({
      exhausted: true,
      draining: false,
    })
    expect(capacitySignals(reading({ confidence: "medium", usedRatio: 1 }))).toEqual({
      exhausted: true,
      draining: false,
    })
  })

  it("does not signal exhaustion for values merely near the bounds", () => {
    expect(capacitySignals(reading({ remainingRatio: 0.0001 })).exhausted).toBe(false)
    expect(capacitySignals(reading({ usedRatio: 0.9999 })).exhausted).toBe(false)
  })

  it("signals draining for high-confidence near-exhaustion", () => {
    expect(capacitySignals(reading({ remainingRatio: 0.1 }))).toEqual({
      exhausted: false,
      draining: true,
    })
    expect(capacitySignals(reading({ usedRatio: 0.9 }))).toEqual({
      exhausted: false,
      draining: true,
    })
  })

  it("requires high confidence for draining", () => {
    expect(capacitySignals(reading({ confidence: "medium", remainingRatio: 0.05 })).draining).toBe(
      false,
    )
    expect(capacitySignals(reading({ confidence: "low", usedRatio: 0.95 })).draining).toBe(false)
  })

  it("never signals draining when exhausted", () => {
    expect(capacitySignals(reading({ remainingRatio: 0, usedRatio: 1 }))).toEqual({
      exhausted: true,
      draining: false,
    })
  })

  it("signals nothing without measured ratios", () => {
    expect(capacitySignals(reading({ retryAfterMs: 1000 }))).toEqual({
      exhausted: false,
      draining: false,
    })
  })

  it("does not signal draining when both ratios are comfortably mid-range", () => {
    expect(capacitySignals(reading({ remainingRatio: 0.5, usedRatio: 0.5 }))).toEqual({
      exhausted: false,
      draining: false,
    })
  })

  it("respects a custom draining threshold", () => {
    const config = { ...DEFAULT_CAPACITY_CONFIG, drainingRemainingThreshold: 0.2 }
    expect(capacitySignals(reading({ remainingRatio: 0.15 }), config).draining).toBe(true)
    expect(capacitySignals(reading({ remainingRatio: 0.25 }), config).draining).toBe(false)
  })
})

describe("capacityHealthEvent", () => {
  it("shapes a capacity event from an exhausted reading", () => {
    const event = capacityHealthEvent(
      { providerID: "p" },
      reading({ remainingRatio: 0, retryAfterMs: 60_000 }),
    )
    expect(event).toEqual({
      kind: "capacity",
      key: { providerID: "p" },
      exhausted: true,
      retryAfterMs: 60_000,
    })
  })

  it("omits retryAfterMs when the reading carries none", () => {
    const event = capacityHealthEvent({ providerID: "p" }, reading({ usedRatio: 0.5 }))
    expect(event).toEqual({ kind: "capacity", key: { providerID: "p" }, exhausted: false })
    expect("retryAfterMs" in event).toBe(false)
  })
})

describe("mergeReadings properties", () => {
  const ratio = fc.option(
    fc.integer({ min: 0, max: 1000 }).map((n) => n / 1000),
    { nil: undefined },
  )
  const delay = fc.option(fc.integer({ min: 0, max: 3_600_000 }), { nil: undefined })
  const confidence = fc.constantFrom(...CONFIDENCE_LEVELS)

  // Fresh, fully valid readings; at least one carries a measured field so a
  // survivor always exists and the merged view is non-null.
  const arbFreshReading: fc.Arbitrary<CapacityReading> = fc.record({
    usedRatio: ratio,
    remainingRatio: ratio,
    retryAfterMs: delay,
    resetAt: delay,
    confidence,
    observedAt: fc.integer({ min: NOW, max: NOW + 1_000 }),
    evidence: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  })

  function hasMeasured(reading: CapacityReading): boolean {
    return (
      reading.usedRatio !== undefined ||
      reading.remainingRatio !== undefined ||
      reading.retryAfterMs !== undefined ||
      reading.resetAt !== undefined
    )
  }

  it("is total and deterministic, and never mutates its input", () => {
    fc.assert(
      fc.property(
        fc.array(arbFreshReading, { maxLength: 6 }),
        fc.integer({ min: NOW, max: NOW + 2_000 }),
        (readings, now) => {
          const snapshot = structuredClone(readings)
          const first = mergeReadings(readings, now)
          const second = mergeReadings(readings, now)
          expect(second).toEqual(first)
          expect(readings).toEqual(snapshot)
        },
      ),
    )
  })

  it("merges with the lowest surviving confidence and the oldest surviving observation", () => {
    fc.assert(
      fc.property(
        fc
          .array(arbFreshReading, { maxLength: 6 })
          .filter((readings) => readings.some(hasMeasured)),
        (readings) => {
          const merged = mergeReadings(readings, NOW)
          expect(merged).not.toBeNull()
          // Readings without any measured field normalize away and cannot
          // drag trust or age; the survivors decide.
          const survivors = readings.filter(hasMeasured)
          const lowest = Math.min(...survivors.map((r) => confidenceRank(r.confidence)))
          expect(confidenceRank(merged?.confidence ?? "high")).toBe(lowest)
          const oldest = Math.min(...survivors.map((r) => r.observedAt))
          expect(merged?.observedAt).toBe(oldest)
        },
      ),
      { numRuns: 500 },
    )
  })

  it("normalization is idempotent for valid readings", () => {
    fc.assert(
      fc.property(arbFreshReading, (value) => {
        expect(normalizeReading(normalizeReading(value))).toEqual(normalizeReading(value))
      }),
    )
  })

  it("never estimates from empty or expired evidence", () => {
    const empty = fc.record({ confidence, observedAt: fc.integer({ min: 0, max: NOW }) })
    const expired: fc.Arbitrary<CapacityReading> = fc.record({
      usedRatio: ratio,
      confidence,
      observedAt: fc.integer({ min: 0, max: NOW - DEFAULT_CAPACITY_CONFIG.maxAgeMs - 1 }),
    })
    fc.assert(
      fc.property(
        fc.oneof(fc.array(empty, { minLength: 1 }), fc.array(expired, { minLength: 1 })),
        (readings) => {
          expect(mergeReadings(readings, NOW)).toBeNull()
        },
      ),
    )
  })

  it("only derives draining from high-confidence non-exhausted near-exhaustion", () => {
    fc.assert(
      fc.property(fc.array(arbFreshReading, { minLength: 1, maxLength: 6 }), (readings) => {
        const merged = mergeReadings(readings, NOW)
        if (merged === null) {
          return
        }
        const { exhausted, draining } = capacitySignals(merged)
        if (!draining) {
          return
        }
        expect(exhausted).toBe(false)
        expect(merged.confidence).toBe("high")
        expect(
          (merged.remainingRatio !== undefined &&
            merged.remainingRatio <= DEFAULT_CAPACITY_CONFIG.drainingRemainingThreshold) ||
            (merged.usedRatio !== undefined &&
              merged.usedRatio >= 1 - DEFAULT_CAPACITY_CONFIG.drainingRemainingThreshold),
        ).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it("signals exhaustion exactly when the merged reading sits on an exact bound", () => {
    fc.assert(
      fc.property(fc.array(arbFreshReading, { minLength: 1, maxLength: 6 }), (readings) => {
        const merged = mergeReadings(readings, NOW)
        if (merged === null) {
          return
        }
        expect(capacitySignals(merged).exhausted).toBe(
          merged.remainingRatio === 0 || merged.usedRatio === 1,
        )
      }),
      { numRuns: 500 },
    )
  })
})
