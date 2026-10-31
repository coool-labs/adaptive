import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { initialBreaker } from "../../../src/health/circuit-breaker/breaker.js"
import type { BreakerRecord } from "../../../src/health/circuit-breaker/types.js"
import {
  applyHealthEvent,
  initialRecord,
  sweepRecord,
} from "../../../src/health/resource-health/transitions.js"
import {
  HEALTH_STATES,
  type HealthEvent,
  type HealthState,
  type ResourceHealthConfig,
  type ResourceKey,
  type ResourceRecord,
  type ResourceWindow,
} from "../../../src/health/resource-health/types.js"

const CONFIG: ResourceHealthConfig = {
  breaker: { failureThreshold: 3, baseOpenMs: 1_000, maxBackoffMs: 8_000 },
  defaultRateLimitWindowMs: 20_000,
}

function record(
  health: HealthState,
  overrides: {
    breaker?: BreakerRecord
    window?: ResourceWindow | undefined
  } = {},
): ResourceRecord {
  const key: ResourceKey = { providerID: "p", modelID: "m" }
  return {
    key,
    health,
    breaker: overrides.breaker ?? initialBreaker(),
    window: overrides.window,
    updatedAt: 0,
  }
}

function recordWithKey(key: ResourceKey, health: HealthState): ResourceRecord {
  return { key, health, breaker: initialBreaker(), updatedAt: 0 }
}

describe("resource health transitions", () => {
  it("starts every record healthy with a closed breaker", () => {
    expect(initialRecord({ providerID: "p" }, 7)).toEqual({
      key: { providerID: "p" },
      health: "healthy",
      breaker: { state: "closed", failures: 0, openCount: 0 },
      updatedAt: 7,
    })
  })

  describe("sweeping", () => {
    it("passes through records without a window", () => {
      const base = record("degraded")
      expect(sweepRecord(base, 1_000)).toBe(base)
    })

    it("passes through records whose window is still open", () => {
      const base = record("rate_limited", { window: { kind: "rate-limit", until: 2_000 } })
      expect(sweepRecord(base, 1_999)).toBe(base)
    })

    it("lifts a windowed state back to healthy once the window elapses", () => {
      const base = record("quota_exhausted", { window: { kind: "quota", until: 2_000 } })
      expect(sweepRecord(base, 2_000)).toEqual({
        key: base.key,
        health: "healthy",
        breaker: base.breaker,
        updatedAt: 2_000,
      })
    })
  })

  describe("rate_limited failures", () => {
    it("sets the state and window from a valid retry delay", () => {
      const result = applyHealthEvent(
        record("healthy"),
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "rate_limited",
          definitive: true,
          retryAfterMs: 4_000,
        },
        100,
        CONFIG,
      )
      expect(result.health).toBe("rate_limited")
      expect(result.window).toEqual({ kind: "rate-limit", until: 4_100 })
    })

    it("uses the default window when no retry delay is present", () => {
      const result = applyHealthEvent(
        record("degraded"),
        { kind: "failure", key: { providerID: "p" }, category: "rate_limited", definitive: false },
        100,
        CONFIG,
      )
      expect(result.health).toBe("rate_limited")
      expect(result.window).toEqual({ kind: "rate-limit", until: 20_100 })
    })

    it("uses the default window for an invalid retry delay", () => {
      const result = applyHealthEvent(
        record("healthy"),
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "rate_limited",
          definitive: false,
          retryAfterMs: -5,
        },
        100,
        CONFIG,
      )
      expect(result.window).toEqual({ kind: "rate-limit", until: 20_100 })
    })

    it("replaces an earlier window", () => {
      const result = applyHealthEvent(
        record("rate_limited", { window: { kind: "rate-limit", until: 500 } }),
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "rate_limited",
          definitive: false,
          retryAfterMs: 1_000,
        },
        100,
        CONFIG,
      )
      expect(result.window).toEqual({ kind: "rate-limit", until: 1_100 })
    })

    it("never downgrades a quota-exhausted or unavailable state", () => {
      for (const health of ["quota_exhausted", "unavailable"] as const) {
        const base = record(health)
        const result = applyHealthEvent(
          base,
          {
            kind: "failure",
            key: { providerID: "p" },
            category: "rate_limited",
            definitive: true,
            retryAfterMs: 1_000,
          },
          100,
          CONFIG,
        )
        expect(result.health).toBe(health)
        expect(result.updatedAt).toBe(100)
      }
    })
  })

  describe("quota_exhausted failures", () => {
    it("sets the state with a window when a reset delay is known", () => {
      const result = applyHealthEvent(
        record("healthy"),
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "quota_exhausted",
          definitive: true,
          retryAfterMs: 60_000,
        },
        100,
        CONFIG,
      )
      expect(result.health).toBe("quota_exhausted")
      expect(result.window).toEqual({ kind: "quota", until: 60_100 })
    })

    it("sets the state without a window when no reset delay is known", () => {
      const result = applyHealthEvent(
        record("healthy"),
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "quota_exhausted",
          definitive: true,
        },
        100,
        CONFIG,
      )
      expect(result.health).toBe("quota_exhausted")
      expect(result.window).toBeUndefined()
    })

    it("never downgrades an unavailable state", () => {
      const base = record("unavailable")
      const result = applyHealthEvent(
        base,
        {
          kind: "failure",
          key: { providerID: "p" },
          category: "quota_exhausted",
          definitive: true,
        },
        100,
        CONFIG,
      )
      expect(result.health).toBe("unavailable")
    })
  })

  describe("infrastructure failures (outage, overload, timeout)", () => {
    const categories = ["outage", "overload", "timeout"] as const

    it("marks healthy and draining records degraded and counts the breaker", () => {
      for (const health of ["healthy", "draining"] as const) {
        for (const category of categories) {
          const result = applyHealthEvent(
            record(health),
            { kind: "failure", key: { providerID: "p" }, category, definitive: true },
            0,
            CONFIG,
          )
          expect(result.health).toBe("degraded")
          expect(result.breaker.failures).toBe(1)
        }
      }
    })

    it("keeps degraded, windowed, and unavailable states but still counts the breaker", () => {
      for (const health of [
        "degraded",
        "rate_limited",
        "quota_exhausted",
        "unavailable",
      ] as const) {
        const base = record(health, {
          window: health === "rate_limited" ? { kind: "rate-limit", until: 100 } : undefined,
        })
        const result = applyHealthEvent(
          base,
          { kind: "failure", key: { providerID: "p" }, category: "outage", definitive: false },
          0,
          CONFIG,
        )
        expect(result.health).toBe(health)
        expect(result.breaker.failures).toBe(1)
        expect(result.window).toEqual(base.window)
      }
    })

    it("opens the breaker when the threshold is reached", () => {
      const base = record("degraded", {
        breaker: { state: "closed", failures: 2, openCount: 0 },
      })
      const result = applyHealthEvent(
        base,
        { kind: "failure", key: { providerID: "p" }, category: "timeout", definitive: true },
        50,
        CONFIG,
      )
      expect(result.breaker).toEqual({ state: "open", failures: 3, openCount: 1, reopenAt: 1_050 })
    })

    it("treats definitive and non-definitive evidence identically for health", () => {
      const definitive = applyHealthEvent(
        record("healthy"),
        { kind: "failure", key: { providerID: "p" }, category: "outage", definitive: true },
        0,
        CONFIG,
      )
      const nonDefinitive = applyHealthEvent(
        record("healthy"),
        { kind: "failure", key: { providerID: "p" }, category: "outage", definitive: false },
        0,
        CONFIG,
      )
      expect(definitive.health).toBe(nonDefinitive.health)
    })
  })

  describe("auth failures", () => {
    it("marks the resource unavailable from any state", () => {
      for (const health of HEALTH_STATES) {
        const result = applyHealthEvent(
          record(health),
          { kind: "failure", key: { providerID: "p" }, category: "auth_failure", definitive: true },
          0,
          CONFIG,
        )
        expect(result.health).toBe("unavailable")
      }
    })
  })

  describe("invalid model failures", () => {
    it("quarantines model-scoped and variant-scoped keys", () => {
      for (const key of [
        { providerID: "p", modelID: "m" },
        { providerID: "p", modelID: "m", variantID: "v" },
      ] as const) {
        const result = applyHealthEvent(
          recordWithKey(key, "healthy"),
          { kind: "failure", key, category: "invalid_model", definitive: true },
          0,
          CONFIG,
        )
        expect(result.health).toBe("unavailable")
      }
    })

    it("never quarantines provider-scoped or account-scoped keys", () => {
      for (const key of [{ providerID: "p" }, { providerID: "p", accountID: "a" }] as const) {
        const base = recordWithKey(key, "degraded")
        const result = applyHealthEvent(
          base,
          { kind: "failure", key, category: "invalid_model", definitive: true },
          0,
          CONFIG,
        )
        expect(result.health).toBe("degraded")
      }
    })
  })

  describe("request-level failures", () => {
    it("never changes health for context overflow, content policy, user cancellation, or unknown", () => {
      for (const category of [
        "context_overflow",
        "content_policy",
        "user_cancelled",
        "unknown",
      ] as const) {
        const base = record("degraded", { breaker: { state: "closed", failures: 2, openCount: 0 } })
        const result = applyHealthEvent(
          base,
          { kind: "failure", key: { providerID: "p" }, category, definitive: false },
          100,
          CONFIG,
        )
        expect(result.health).toBe("degraded")
        expect(result.breaker).toEqual(base.breaker)
        expect(result.updatedAt).toBe(100)
      }
    })
  })

  describe("success", () => {
    it("restores healthy and clears the window, and closes an open breaker", () => {
      const result = applyHealthEvent(
        record("rate_limited", {
          breaker: { state: "open", failures: 3, openCount: 2, reopenAt: 5_000 },
          window: { kind: "rate-limit", until: 9_000 },
        }),
        { kind: "success", key: { providerID: "p" } },
        100,
        CONFIG,
      )
      expect(result.health).toBe("healthy")
      expect(result.breaker).toEqual({ state: "closed", failures: 0, openCount: 0 })
      expect(result.window).toBeUndefined()
    })

    it("restores degraded and unavailable states", () => {
      for (const health of ["degraded", "unavailable"] as const) {
        const result = applyHealthEvent(
          record(health),
          { kind: "success", key: { providerID: "p" } },
          0,
          CONFIG,
        )
        expect(result.health).toBe("healthy")
      }
    })

    it("never overrides draining or quota exhaustion", () => {
      for (const health of ["draining", "quota_exhausted"] as const) {
        const base = record(health, { window: { kind: "quota", until: 9_000 } })
        const result = applyHealthEvent(
          base,
          { kind: "success", key: { providerID: "p" } },
          0,
          CONFIG,
        )
        expect(result.health).toBe(health)
        expect(result.window).toEqual(base.window)
      }
    })
  })

  describe("draining", () => {
    it("applies to healthy and degraded records", () => {
      for (const health of ["healthy", "degraded"] as const) {
        const result = applyHealthEvent(
          record(health),
          { kind: "drain", key: { providerID: "p" } },
          0,
          CONFIG,
        )
        expect(result.health).toBe("draining")
      }
    })

    it("never masks a harder state", () => {
      for (const health of [
        "rate_limited",
        "quota_exhausted",
        "unavailable",
        "draining",
      ] as const) {
        const result = applyHealthEvent(
          record(health),
          { kind: "drain", key: { providerID: "p" } },
          0,
          CONFIG,
        )
        expect(result.health).toBe(health)
      }
    })
  })

  describe("capacity readings", () => {
    it("exhaustion marks quota exhausted (including from draining) with a known reset", () => {
      for (const health of ["healthy", "draining", "degraded", "rate_limited"] as const) {
        const result = applyHealthEvent(
          record(health, { window: { kind: "rate-limit", until: 100 } }),
          { kind: "capacity", key: { providerID: "p" }, exhausted: true, retryAfterMs: 30_000 },
          0,
          CONFIG,
        )
        expect(result.health).toBe("quota_exhausted")
        expect(result.window).toEqual({ kind: "quota", until: 30_000 })
      }
    })

    it("exhaustion without a reset delay sets no window", () => {
      const result = applyHealthEvent(
        record("healthy"),
        { kind: "capacity", key: { providerID: "p" }, exhausted: true, retryAfterMs: -1 },
        0,
        CONFIG,
      )
      expect(result.health).toBe("quota_exhausted")
      expect(result.window).toBeUndefined()
    })

    it("never overrides an unavailable state", () => {
      const result = applyHealthEvent(
        record("unavailable"),
        { kind: "capacity", key: { providerID: "p" }, exhausted: true },
        0,
        CONFIG,
      )
      expect(result.health).toBe("unavailable")
    })

    it("a non-exhausted reading lifts quota exhaustion", () => {
      const result = applyHealthEvent(
        record("quota_exhausted", { window: { kind: "quota", until: 9_000 } }),
        { kind: "capacity", key: { providerID: "p" }, exhausted: false },
        0,
        CONFIG,
      )
      expect(result.health).toBe("healthy")
      expect(result.window).toBeUndefined()
    })

    it("a non-exhausted reading leaves other states alone", () => {
      for (const health of [
        "healthy",
        "degraded",
        "rate_limited",
        "draining",
        "unavailable",
      ] as const) {
        const result = applyHealthEvent(
          record(health),
          { kind: "capacity", key: { providerID: "p" }, exhausted: false },
          0,
          CONFIG,
        )
        expect(result.health).toBe(health)
      }
    })
  })

  describe("reset", () => {
    it("restores a fully healthy record from any state", () => {
      const result = applyHealthEvent(
        record("unavailable", {
          breaker: { state: "open", failures: 3, openCount: 4, reopenAt: 9_000 },
          window: { kind: "quota", until: 9_000 },
        }),
        { kind: "reset", key: { providerID: "p" } },
        100,
        CONFIG,
      )
      expect(result).toEqual({
        key: { providerID: "p", modelID: "m" },
        health: "healthy",
        breaker: { state: "closed", failures: 0, openCount: 0 },
        updatedAt: 100,
      })
    })
  })

  describe("properties", () => {
    const stateArb = fc.constantFrom(...HEALTH_STATES)
    const nowArb = fc.integer({ min: 0, max: 1_000_000_000 })
    const retryAfterArb = fc.option(fc.integer({ min: -3, max: 500_000 }), { nil: undefined })
    const keyArb = fc.oneof(
      fc.constant({ providerID: "p" } satisfies ResourceKey),
      fc.constant({ providerID: "p", accountID: "a" } satisfies ResourceKey),
      fc.constant({ providerID: "p", modelID: "m" } satisfies ResourceKey),
      fc.constant({
        providerID: "p",
        accountID: "a",
        modelID: "m",
        variantID: "v",
      } satisfies ResourceKey),
    )
    const windowArb = fc.option(
      fc.record({
        kind: fc.constantFrom("rate-limit", "quota"),
        until: fc.integer({ min: 0, max: 1_000_000_000 }),
      }),
      { nil: undefined },
    )

    const eventArb: fc.Arbitrary<HealthEvent> = fc.oneof(
      fc.record({
        kind: fc.constant("failure" as const),
        key: keyArb,
        category: fc.constantFrom(
          "rate_limited",
          "quota_exhausted",
          "outage",
          "overload",
          "timeout",
          "auth_failure",
          "invalid_model",
          "context_overflow",
          "content_policy",
          "user_cancelled",
          "unknown",
        ),
        definitive: fc.boolean(),
        retryAfterMs: retryAfterArb,
      }),
      fc.record({ kind: fc.constant("success" as const), key: keyArb }),
      fc.record({ kind: fc.constant("drain" as const), key: keyArb }),
      fc.record({
        kind: fc.constant("capacity" as const),
        key: keyArb,
        exhausted: fc.boolean(),
        retryAfterMs: retryAfterArb,
      }),
      fc.record({ kind: fc.constant("reset" as const), key: keyArb }),
    )

    /** Independent expectation for the resulting health state. */
    function expectedHealth(
      state: HealthState,
      event: HealthEvent,
      recordKey: ResourceKey,
    ): HealthState {
      switch (event.kind) {
        case "failure":
          switch (event.category) {
            case "rate_limited":
              return state === "quota_exhausted" || state === "unavailable" ? state : "rate_limited"
            case "quota_exhausted":
              return state === "unavailable" ? state : "quota_exhausted"
            case "outage":
            case "overload":
            case "timeout":
              return state === "healthy" || state === "draining" ? "degraded" : state
            case "auth_failure":
              return "unavailable"
            case "invalid_model": {
              const specific = recordKey.variantID !== undefined || recordKey.modelID !== undefined
              return specific ? "unavailable" : state
            }
            default:
              return state
          }
        case "success":
          return state === "draining" || state === "quota_exhausted" ? state : "healthy"
        case "drain":
          return state === "healthy" || state === "degraded" ? "draining" : state
        case "capacity":
          if (event.exhausted) {
            return state === "unavailable" ? state : "quota_exhausted"
          }
          return state === "quota_exhausted" ? "healthy" : state
        case "reset":
          return "healthy"
      }
    }

    it("every event on every state produces the pinned transition matrix", () => {
      fc.property(
        stateArb,
        nowArb,
        keyArb,
        windowArb,
        eventArb,
        (state, now, key, window, event) => {
          const base: ResourceRecord = {
            key,
            health: state,
            breaker: initialBreaker(),
            window,
            updatedAt: 0,
          }
          const result = applyHealthEvent(base, event, now, CONFIG)
          expect(HEALTH_STATES).toContain(result.health)
          expect(result.health).toBe(expectedHealth(state, event, key))
          expect(result.key).toEqual(key)
          expect(result.updatedAt).toBe(now)
        },
      )
    })

    it("rate limiting always carries a window; weak evidence never clears one", () => {
      fc.property(stateArb, nowArb, retryAfterArb, (state, now, retryAfterMs) => {
        const result = applyHealthEvent(
          record(state),
          {
            kind: "failure",
            key: { providerID: "p" },
            category: "rate_limited",
            definitive: false,
            retryAfterMs,
          },
          now,
          CONFIG,
        )
        if (state === "quota_exhausted" || state === "unavailable") {
          expect(result.window).toBeUndefined()
          return
        }
        const delay =
          retryAfterMs !== undefined && Number.isInteger(retryAfterMs) && retryAfterMs >= 0
            ? retryAfterMs
            : CONFIG.defaultRateLimitWindowMs
        expect(result.window).toEqual({ kind: "rate-limit", until: now + delay })
      })
    })

    it("sweeping is idempotent before the window elapses and lifts it after", () => {
      fc.property(stateArb, nowArb, fc.integer({ min: 1, max: 10_000 }), (state, now, delta) => {
        const base = record(state, { window: { kind: "rate-limit", until: now + delta } })
        const before = sweepRecord(base, now + Math.max(delta - 1, 0))
        expect(before).toBe(base)
        const after = sweepRecord(base, now + delta)
        expect(after.health).toBe("healthy")
        expect(sweepRecord(after, now + delta)).toEqual(after)
      })
    })
  })
})
