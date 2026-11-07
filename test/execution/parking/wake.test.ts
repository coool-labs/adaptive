/**
 * Parked-work wake planning (ADP-024): the wake fires when the earliest
 * candidate resource of a parked unit becomes usable, never spins, never
 * overflows the timer, and backs off when wakes keep resuming nothing.
 */
// covers: ["ADP-024"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  earliestUsable,
  FRUITLESS_BASE_MS,
  MAX_WAKE_MS,
  MIN_WAKE_MS,
  planWake,
  resourceUsableAt,
  UNKNOWN_WAKE_MS,
  WAKE_GRACE_MS,
} from "../../../src/execution/parking/wake.js"
import { initialBreaker } from "../../../src/health/circuit-breaker/breaker.js"
import { DEFAULT_CAPACITY_CONFIG } from "../../../src/health/capacity/types.js"
import type { CapacityReading } from "../../../src/health/capacity/types.js"
import type { BreakerRecord } from "../../../src/health/circuit-breaker/types.js"
import type {
  HealthState,
  ResourceRecord,
  ResourceWindow,
} from "../../../src/health/resource-health/types.js"

const NOW = 1_000_000

function record(
  health: HealthState,
  extra: { window?: ResourceWindow; breaker?: BreakerRecord } = {},
): ResourceRecord {
  return {
    key: { providerID: "p", modelID: "m" },
    health,
    breaker: extra.breaker ?? initialBreaker(),
    ...(extra.window === undefined ? {} : { window: extra.window }),
    updatedAt: 0,
  }
}

function exhausted(extra: Partial<CapacityReading> = {}): CapacityReading {
  return { remainingRatio: 0, confidence: "high", observedAt: NOW, ...extra }
}

describe("resourceUsableAt", () => {
  it("is now for an unknown or healthy resource", () => {
    expect(resourceUsableAt([], null, NOW)).toBe(NOW)
    expect(resourceUsableAt([undefined, record("healthy")], null, NOW)).toBe(NOW)
  })

  it("is the window end for a quota or rate-limit window", () => {
    const window: ResourceWindow = { kind: "quota", until: NOW + 60_000 }
    expect(resourceUsableAt([record("quota_exhausted", { window })], null, NOW)).toBe(NOW + 60_000)
    const rate: ResourceWindow = { kind: "rate-limit", until: NOW + 5_000 }
    expect(resourceUsableAt([record("rate_limited", { window: rate })], null, NOW)).toBe(
      NOW + 5_000,
    )
  })

  it("is unknown for a windowless quota, an unavailable resource, or an in-flight probe", () => {
    expect(resourceUsableAt([record("quota_exhausted")], null, NOW)).toBeUndefined()
    expect(resourceUsableAt([record("unavailable")], null, NOW)).toBeUndefined()
    const halfOpen: BreakerRecord = { ...initialBreaker(), state: "half_open" }
    expect(resourceUsableAt([record("healthy", { breaker: halfOpen })], null, NOW)).toBeUndefined()
  })

  it("waits for an open breaker to reopen (due now without a reopen time)", () => {
    const open: BreakerRecord = { ...initialBreaker(), state: "open", reopenAt: NOW + 30_000 }
    expect(resourceUsableAt([record("degraded", { breaker: open })], null, NOW)).toBe(NOW + 30_000)
    const due: BreakerRecord = { ...initialBreaker(), state: "open" }
    expect(resourceUsableAt([record("degraded", { breaker: due })], null, NOW)).toBe(NOW)
  })

  it("takes the latest blocker across the chain (a blocked ancestor blocks the model)", () => {
    const provider = record("quota_exhausted", { window: { kind: "quota", until: NOW + 90_000 } })
    const model = record("rate_limited", { window: { kind: "rate-limit", until: NOW + 10_000 } })
    expect(resourceUsableAt([provider, undefined, model], null, NOW)).toBe(NOW + 90_000)
    expect(resourceUsableAt([provider, record("unavailable")], null, NOW)).toBeUndefined()
  })

  it("never reports a past time for an elapsed window", () => {
    const window: ResourceWindow = { kind: "quota", until: NOW - 1 }
    expect(resourceUsableAt([record("quota_exhausted", { window })], null, NOW)).toBe(NOW)
  })

  it("clears exhausted capacity at its reset, or when the reading goes stale", () => {
    const stale = NOW + DEFAULT_CAPACITY_CONFIG.maxAgeMs
    expect(resourceUsableAt([], exhausted({ resetAt: NOW + 1_000 }), NOW)).toBe(NOW + 1_000)
    expect(resourceUsableAt([], exhausted({ resetAt: NOW + 10 * 60_000 }), NOW)).toBe(stale)
    expect(resourceUsableAt([], exhausted(), NOW)).toBe(stale)
    expect(resourceUsableAt([], exhausted({ remainingRatio: 0.5 }), NOW)).toBe(NOW)
  })
})

describe("earliestUsable", () => {
  it("is the earliest known time, unknown when none is known", () => {
    expect(earliestUsable([])).toBeUndefined()
    expect(earliestUsable([undefined, undefined])).toBeUndefined()
    expect(earliestUsable([undefined, 30, 10, 20])).toBe(10)
  })
})

describe("planWake", () => {
  it("does not wake without targets", () => {
    expect(planWake([], NOW, 0)).toBeUndefined()
  })

  it("wakes just after the earliest known reset", () => {
    expect(planWake([NOW + 60_000, NOW + 10_000], NOW, 0)).toEqual({
      dueAt: NOW + 10_000 + WAKE_GRACE_MS,
      delayMs: 10_000 + WAKE_GRACE_MS,
      capped: false,
    })
  })

  it("re-checks unknown resets on a fixed cadence, sooner if a known reset comes first", () => {
    expect(planWake([undefined], NOW, 0)).toEqual({
      dueAt: NOW + UNKNOWN_WAKE_MS,
      delayMs: UNKNOWN_WAKE_MS,
      capped: false,
    })
    expect(planWake([undefined, NOW + 1_000], NOW, 0)?.dueAt).toBe(NOW + 1_000 + WAKE_GRACE_MS)
    expect(planWake([undefined, NOW + 60 * 60_000], NOW, 0)?.dueAt).toBe(NOW + UNKNOWN_WAKE_MS)
  })

  it("never fires sooner than the minimum delay for a due target", () => {
    expect(planWake([NOW - 60_000], NOW, 0)).toEqual({
      dueAt: NOW + MIN_WAKE_MS,
      delayMs: MIN_WAKE_MS,
      capped: false,
    })
  })

  it("doubles the floor per fruitless wake, capped", () => {
    expect(planWake([NOW], NOW, 1)?.delayMs).toBe(FRUITLESS_BASE_MS)
    expect(planWake([NOW], NOW, 3)?.delayMs).toBe(FRUITLESS_BASE_MS * 4)
    expect(planWake([NOW], NOW, 40)?.delayMs).toBe(MAX_WAKE_MS)
  })

  it("caps a long wait (weekly limits) to one bounded step that keeps the due time", () => {
    const weekly = NOW + 7 * 24 * 60 * 60_000
    expect(planWake([weekly], NOW, 0)).toEqual({
      dueAt: weekly + WAKE_GRACE_MS,
      delayMs: MAX_WAKE_MS,
      capped: true,
    })
  })

  it("property: the delay is bounded, the due time never precedes the reset or the floor", () => {
    const target = fc.option(fc.integer({ min: NOW - 10 ** 9, max: NOW + 10 ** 10 }), {
      nil: undefined,
    })
    fc.assert(
      fc.property(
        fc.array(target, { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 60 }),
        (targets, fruitless) => {
          const plan = planWake(targets, NOW, fruitless)
          expect(plan).toBeDefined()
          if (plan === undefined) return
          expect(plan.delayMs).toBeGreaterThanOrEqual(MIN_WAKE_MS)
          expect(plan.delayMs).toBeLessThanOrEqual(MAX_WAKE_MS)
          expect(plan.delayMs).toBeLessThanOrEqual(plan.dueAt - NOW)
          expect(plan.capped).toBe(plan.delayMs < plan.dueAt - NOW)
          expect(Number.isFinite(plan.dueAt)).toBe(true)
          const known = earliestUsable(targets)
          if (known !== undefined && !targets.includes(undefined)) {
            expect(plan.dueAt).toBeGreaterThanOrEqual(known + WAKE_GRACE_MS)
          }
        },
      ),
    )
  })
})
