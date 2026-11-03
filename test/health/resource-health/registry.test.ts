// covers: ["ADP-007", "ADP-019"]
import { describe, expect, it } from "vitest"

import { ResourceHealthRegistry } from "../../../src/health/resource-health/registry.js"
import {
  DEFAULT_HEALTH_CONFIG,
  type ResourceKey,
} from "../../../src/health/resource-health/types.js"

function fakeClock() {
  const state = { now: 0 }
  return {
    now: () => state.now,
    advance: (delta: number) => {
      state.now += delta
    },
  }
}

const PROVIDER_KEY: ResourceKey = { providerID: "p" }
const MODEL_KEY: ResourceKey = { providerID: "p", modelID: "m" }

function tripBreaker(registry: ResourceHealthRegistry, key: ResourceKey): void {
  for (let index = 0; index < DEFAULT_HEALTH_CONFIG.breaker.failureThreshold; index += 1) {
    registry.observe({ kind: "failure", key, category: "timeout", definitive: false })
  }
}

describe("ResourceHealthRegistry", () => {
  it("assesses an unknown key as available without creating records", () => {
    const { now } = fakeClock()
    const registry = new ResourceHealthRegistry(now)
    expect(registry.assess({ providerID: "p" })).toEqual({ kind: "available" })
    expect(registry.assess({ providerID: "p" })).toEqual({ kind: "available" })
    expect(registry.snapshot()).toEqual([])
    expect(registry.recordFor({ providerID: "p" })).toBeUndefined()
  })

  it("creates a record on first observation", () => {
    const { now } = fakeClock()
    const registry = new ResourceHealthRegistry(now)
    registry.observe({ kind: "success", key: PROVIDER_KEY })
    expect(registry.recordFor(PROVIDER_KEY)?.health).toBe("healthy")
  })

  describe("hard state blocking", () => {
    it("blocks on rate limiting with the window's remaining delay", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: MODEL_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 1_000,
      })
      const assessment = registry.assess(MODEL_KEY)
      expect(assessment.kind).toBe("blocked")
      expect(assessment).toEqual({
        kind: "blocked",
        reason: "rate-limited",
        key: MODEL_KEY,
        retryAtMs: 1_000,
      })
    })

    it("blocks quota exhaustion without a known reset indefinitely", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: PROVIDER_KEY,
        category: "quota_exhausted",
        definitive: true,
      })
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "quota-exhausted",
        key: PROVIDER_KEY,
      })
    })

    it("blocks a provider-wide rate limit for all of its models", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: PROVIDER_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 2_000,
      })
      expect(registry.assess({ providerID: "p", modelID: "m", variantID: "v" }).kind).toBe(
        "blocked",
      )
    })

    it("reports the most severe hard blocker, narrowest on ties", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: PROVIDER_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 2_000,
      })
      registry.observe({
        kind: "failure",
        key: PROVIDER_KEY,
        category: "auth_failure",
        definitive: true,
      })
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "unavailable",
        key: PROVIDER_KEY,
      })
    })

    it("keeps the more severe blocker when a narrower one is weaker", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: PROVIDER_KEY,
        category: "auth_failure",
        definitive: true,
      })
      registry.observe({
        kind: "failure",
        key: MODEL_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 2_000,
      })
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "unavailable",
        key: PROVIDER_KEY,
      })
    })

    it("reports the narrowest scope when two scopes share a hard state", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      for (const key of [PROVIDER_KEY, MODEL_KEY]) {
        registry.observe({
          kind: "failure",
          key,
          category: "rate_limited",
          definitive: false,
          retryAfterMs: 2_000,
        })
      }
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "rate-limited",
        key: MODEL_KEY,
        retryAtMs: 2_000,
      })
    })

    it("lifts rate-limit windows when they elapse", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: MODEL_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 500,
      })
      advance(500)
      expect(registry.assess(MODEL_KEY)).toEqual({ kind: "available" })
      expect(registry.recordFor(MODEL_KEY)?.health).toBe("healthy")
    })
  })

  describe("circuit breaker assessment", () => {
    it("blocks on an open breaker with the remaining backoff", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(10_000)
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "breaker-open",
        key: PROVIDER_KEY,
        retryAtMs: 20_000,
      })
    })

    it("admits exactly one probe under concurrent assessment", async () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessments = await Promise.all(
        Array.from({ length: 50 }, async () => {
          await Promise.resolve()
          return registry.assess(MODEL_KEY)
        }),
      )
      const probes = assessments.filter((assessment) => assessment.kind === "probe")
      const inFlight = assessments.filter(
        (assessment) => assessment.kind === "blocked" && assessment.reason === "probe-in-flight",
      )
      expect(probes).toHaveLength(1)
      expect(inFlight).toHaveLength(49)
      expect(registry.recordFor(PROVIDER_KEY)?.breaker.state).toBe("half_open")
    })

    it("prefers the widest due breaker for the probe", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      tripBreaker(registry, MODEL_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(MODEL_KEY)
      expect(assessment.kind).toBe("probe")
      expect(assessment.kind === "probe" ? assessment.ticket.key : undefined).toEqual(PROVIDER_KEY)
    })

    it("evaluate never mutates breaker state (a due-open breaker blocks without issuing a probe)", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const first = registry.evaluate(PROVIDER_KEY)
      const second = registry.evaluate(PROVIDER_KEY)
      expect(first).toEqual(second)
      expect(first).toMatchObject({ kind: "blocked", reason: "breaker-open" })
      // Only assess flips the breaker to half-open and issues the ticket.
      expect(registry.assess(PROVIDER_KEY).kind).toBe("probe")
    })

    it("evaluate reports a hard-blocked window without mutating it", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({
        kind: "failure",
        key: MODEL_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 1_000,
      })
      expect(registry.evaluate(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "rate-limited",
        key: MODEL_KEY,
        retryAtMs: 1_000,
      })
    })

    it("evaluate reports a half-open probe as in flight without consuming it", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      // assess flips to half-open and issues the ticket; evaluate must see
      // the probe as in flight while leaving it available for assess.
      expect(registry.assess(PROVIDER_KEY).kind).toBe("probe")
      expect(registry.evaluate(PROVIDER_KEY)).toEqual({
        kind: "blocked",
        reason: "probe-in-flight",
        key: PROVIDER_KEY,
        retryAtMs: undefined,
      })
      expect(registry.assess(PROVIDER_KEY).kind).toBe("blocked")
    })

    it("evaluate reports a draining resource as blocked", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({ kind: "drain", key: MODEL_KEY })
      expect(registry.evaluate(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "draining",
        key: MODEL_KEY,
        retryAtMs: undefined,
      })
    })

    it("resolves a successful probe and becomes available", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(PROVIDER_KEY)
      if (assessment.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      expect(registry.reportProbe(assessment.ticket, { success: true })).toBe(true)
      expect(registry.assess(PROVIDER_KEY)).toEqual({ kind: "available" })
      expect(registry.recordFor(PROVIDER_KEY)?.breaker).toEqual({
        state: "closed",
        failures: 0,
        openCount: 0,
      })
    })

    it("reopens with doubled backoff on a failed probe", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(PROVIDER_KEY)
      if (assessment.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      advance(1)
      expect(registry.reportProbe(assessment.ticket, { success: false, category: "outage" })).toBe(
        true,
      )
      expect(registry.assess(PROVIDER_KEY)).toEqual({
        kind: "blocked",
        reason: "breaker-open",
        key: PROVIDER_KEY,
        retryAtMs: 60_000,
      })
    })

    it("rejects stale, unknown, and replayed probe tickets", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      expect(registry.reportProbe({ id: "1", key: PROVIDER_KEY }, { success: true })).toBe(false)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(PROVIDER_KEY)
      if (assessment.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      expect(registry.reportProbe(assessment.ticket, { success: true })).toBe(true)
      expect(registry.reportProbe(assessment.ticket, { success: true })).toBe(false)
      tripBreaker(registry, MODEL_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const second = registry.assess(MODEL_KEY)
      if (second.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      expect(
        registry.reportProbe(second.ticket, { success: false, category: "rate_limited" }),
      ).toBe(true)
    })

    it("releases a never-dispatched probe still due, and rejects stale release tickets", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      expect(registry.releaseProbe({ id: "1", key: PROVIDER_KEY })).toBe(false)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(PROVIDER_KEY)
      if (assessment.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      advance(5_000)
      expect(registry.releaseProbe(assessment.ticket)).toBe(true)
      expect(registry.releaseProbe(assessment.ticket)).toBe(false)
      const fresh = registry.assess(PROVIDER_KEY)
      expect(fresh.kind).toBe("probe")
      if (fresh.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      expect(fresh.ticket.id).not.toBe(assessment.ticket.id)
      expect(registry.releaseProbe(assessment.ticket)).toBe(false)
    })

    it("expires a probe whose outcome never arrives and re-arms the same window", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      const assessment = registry.assess(PROVIDER_KEY)
      if (assessment.kind !== "probe") {
        throw new Error("expected a probe admission")
      }
      // The probe's terminal event never arrives. Just before the probe
      // deadline the resource stays wedged in half-open...
      advance(DEFAULT_HEALTH_CONFIG.breaker.probeTimeoutMs - 1)
      expect(registry.assess(PROVIDER_KEY)).toEqual({
        kind: "blocked",
        reason: "probe-in-flight",
        key: PROVIDER_KEY,
      })
      // ...at the deadline the lost probe is discarded (same window, no
      // doubling) and after that window a fresh probe is admitted.
      advance(1)
      expect(registry.assess(PROVIDER_KEY)).toEqual({
        kind: "blocked",
        reason: "breaker-open",
        key: PROVIDER_KEY,
        retryAtMs: DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs,
      })
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs)
      const fresh = registry.assess(PROVIDER_KEY)
      expect(fresh.kind).toBe("probe")
      if (fresh.kind === "probe") {
        expect(fresh.ticket.id).not.toBe(assessment.ticket.id)
      }
    })

    it("keeps the breaker open while a hard state shadows it, then admits the probe", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      tripBreaker(registry, PROVIDER_KEY)
      registry.observe({
        kind: "failure",
        key: MODEL_KEY,
        category: "rate_limited",
        definitive: false,
        retryAfterMs: 30_500,
      })
      advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "rate-limited",
        key: MODEL_KEY,
        retryAtMs: 499,
      })
      expect(registry.recordFor(PROVIDER_KEY)?.breaker.state).toBe("open")
      advance(499)
      const assessment = registry.assess(MODEL_KEY)
      expect(assessment.kind).toBe("probe")
      expect(assessment.kind === "probe" ? assessment.ticket.key : undefined).toEqual(PROVIDER_KEY)
    })
  })

  describe("draining", () => {
    it("blocks with the narrowest draining scope", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({ kind: "drain", key: PROVIDER_KEY })
      registry.observe({ kind: "drain", key: MODEL_KEY })
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "draining",
        key: MODEL_KEY,
      })
    })

    it("reports a draining ancestor for a healthy descendant", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.observe({ kind: "drain", key: PROVIDER_KEY })
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "draining",
        key: PROVIDER_KEY,
      })
    })
  })

  it("reports block and probe outcomes for the assessed scope only", () => {
    const { now, advance } = fakeClock()
    const registry = new ResourceHealthRegistry(now)
    tripBreaker(registry, PROVIDER_KEY)
    advance(DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1)
    const assessment = registry.assess(MODEL_KEY)
    if (assessment.kind !== "probe") {
      throw new Error("expected a probe admission")
    }
    // A ticket forged for the assessed (model) key is rejected: the probe was
    // admitted for the provider record.
    expect(
      registry.reportProbe({ id: assessment.ticket.id, key: MODEL_KEY }, { success: true }),
    ).toBe(false)
    expect(registry.recordFor(PROVIDER_KEY)?.breaker.state).toBe("half_open")
  })

  it("sweeps windows in snapshots", () => {
    const { now, advance } = fakeClock()
    const registry = new ResourceHealthRegistry(now)
    registry.observe({
      kind: "failure",
      key: PROVIDER_KEY,
      category: "rate_limited",
      definitive: false,
      retryAfterMs: 100,
    })
    advance(100)
    expect(registry.snapshot()[0]?.health).toBe("healthy")
  })

  describe("hydrate (persisted-record seeding)", () => {
    it("assesses hydrated failures without re-persisting or mutating them", () => {
      const { now, advance } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.hydrate([
        {
          key: MODEL_KEY,
          health: "rate_limited",
          breaker: { state: "closed", failures: 2, openCount: 0 },
          window: { kind: "rate-limit", until: 500 },
          updatedAt: 100,
        },
      ])
      expect(registry.assess(MODEL_KEY)).toEqual({
        kind: "blocked",
        reason: "rate-limited",
        key: MODEL_KEY,
        retryAtMs: 500,
      })
      // Sweeping on the clock applies; nothing else about the record changes.
      expect(registry.recordFor(MODEL_KEY)?.health).toBe("rate_limited")
      advance(500)
      expect(registry.assess(MODEL_KEY)).toEqual({ kind: "available" })
      expect(registry.recordFor(MODEL_KEY)?.health).toBe("healthy")
    })

    it("re-opens a hydrated half-open breaker due immediately (no wedge, one probe)", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.hydrate([
        {
          key: MODEL_KEY,
          health: "degraded",
          breaker: {
            state: "half_open",
            failures: 5,
            openCount: 1,
            reopenAt: 0,
            probeId: "7",
            probeAt: 0,
          },
          updatedAt: 100,
        },
      ])
      // The lost probe's ticket cannot come back; the record re-opens due and
      // the very next assessment admits exactly one fresh probe.
      expect(registry.recordFor(MODEL_KEY)?.breaker.state).toBe("open")
      const assessment = registry.assess(MODEL_KEY)
      expect(assessment.kind).toBe("probe")
      if (assessment.kind === "probe") {
        expect(registry.reportProbe(assessment.ticket, { success: true })).toBe(true)
      }
      expect(registry.recordFor(MODEL_KEY)?.breaker.state).toBe("closed")
    })

    it("sweeps an already-expired window during hydration", () => {
      const { now, advance } = fakeClock()
      advance(10_000)
      const registry = new ResourceHealthRegistry(now)
      registry.hydrate([
        {
          key: MODEL_KEY,
          health: "rate_limited",
          breaker: { state: "closed", failures: 1, openCount: 0 },
          window: { kind: "rate-limit", until: 5_000 },
          updatedAt: 4_000,
        },
      ])
      expect(registry.assess(MODEL_KEY)).toEqual({ kind: "available" })
      expect(registry.recordFor(MODEL_KEY)?.window).toBeUndefined()
      expect(registry.recordFor(MODEL_KEY)?.health).toBe("healthy")
    })

    it("leaves the registry untouched for empty or unknown-scope input", () => {
      const { now } = fakeClock()
      const registry = new ResourceHealthRegistry(now)
      registry.hydrate([])
      expect(registry.snapshot()).toEqual([])
      registry.hydrate([
        {
          key: { providerID: "other" },
          health: "healthy",
          breaker: { state: "closed", failures: 0, openCount: 0 },
          updatedAt: 1,
        },
      ])
      expect(registry.assess(PROVIDER_KEY)).toEqual({ kind: "available" })
      expect(registry.recordFor(MODEL_KEY)).toBeUndefined()
    })
  })
})
