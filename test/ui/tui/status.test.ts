// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  healthOverview,
  clockTime,
  healthDetail,
  healthEntries,
  HEALTH_EMPTY_MESSAGE,
} from "../../../src/ui/tui/status.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc/status.js"

function entry(overrides: Partial<TierResourceStatus> = {}): TierResourceStatus {
  return {
    ref: { providerID: "prov", id: "m1" },
    health: "healthy",
    breaker: "closed",
    windowed: false,
    windowUntil: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    receipts: 0,
    ...overrides,
  }
}

describe("health view", () => {
  it("flattens configured resources in tier order", () => {
    const s = snapshot({
      tiers: {
        quick: [entry({ ref: { providerID: "p", id: "q" } })],
        standard: [
          entry({ ref: { providerID: "p", id: "s" } }),
          entry({ ref: { providerID: "p", id: "s2" } }),
        ],
        advanced: [],
      },
    })
    expect(healthEntries(s).map((e) => [e.tier, e.status.ref.id])).toEqual([
      ["quick", "q"],
      ["standard", "s"],
      ["standard", "s2"],
    ])
  })

  it("renders the window deadline as a local wall-clock time", () => {
    // Built from local components so the assertion holds in any timezone.
    const at = new Date(2026, 0, 1, 18, 42).getTime()
    expect(clockTime(at)).toBe("18:42")
  })

  it("details health, breaker, and the window deadline", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    const s = snapshot({ pin: { providerID: "prov", id: "m1" } })
    const text = healthDetail(
      {
        tier: "standard",
        status: entry({ health: "rate_limited", windowed: true, windowUntil: at }),
      },
      s,
    )
    expect(text).toContain("health: rate_limited")
    expect(text).toContain("breaker: closed")
    expect(text).toContain("window: until 09:05")
    expect(text).toContain("tier: standard")
    expect(text).toContain("pin: pinned to this resource")
  })

  it("details a window whose deadline is unknown", () => {
    const text = healthDetail(
      { tier: "quick", status: entry({ windowed: true, windowUntil: null }) },
      snapshot(),
    )
    expect(text).toContain("window: active (deadline unknown)")
  })

  it("omits the pin line for other resources", () => {
    const text = healthDetail(
      { tier: "quick", status: entry({ ref: { providerID: "prov", id: "other" } }) },
      snapshot({ pin: { providerID: "prov", id: "m1" } }),
    )
    expect(text).not.toContain("pin:")
  })

  it("summarizes every resource on one screen (overview)", () => {
    const at = new Date(2026, 0, 1, 18, 42).getTime()
    const text = healthOverview(
      snapshot({
        pin: { providerID: "prov", id: "m2" },
        tiers: {
          quick: [entry({ ref: { providerID: "prov", id: "m2" } })],
          standard: [
            entry({
              ref: { providerID: "prov", id: "m1" },
              health: "rate_limited",
              windowed: true,
              windowUntil: at,
            }),
          ],
          advanced: [
            entry({
              ref: { providerID: "prov", id: "m3" },
              health: "healthy",
              breaker: "open",
            }),
          ],
        },
      }),
    )
    const lines = text.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe("prov/m2 — quick — healthy (pinned)")
    expect(lines[1]).toBe("prov/m1 — standard — rate_limited, windowed until 18:42")
    expect(lines[2]).toBe("prov/m3 — advanced — healthy, breaker open")
  })

  it("marks an unknown window deadline and a probing breaker in the overview", () => {
    const text = healthOverview(
      snapshot({
        tiers: {
          quick: [
            entry({ health: "rate_limited", windowed: true, windowUntil: null }),
            entry({ breaker: "half_open" }),
          ],
          standard: [],
          advanced: [],
        },
      }),
    )
    const lines = text.split("\n")
    expect(lines[0]).toBe("prov/m1 — quick — rate_limited, windowed (deadline unknown)")
    expect(lines[1]).toBe("prov/m1 — quick — healthy, probing")
  })

  it("never throws over arbitrary snapshots (property)", () => {
    const healthArb = fc.constantFrom(
      "healthy",
      "draining",
      "degraded",
      "rate_limited",
      "quota_exhausted",
      "unavailable",
    )
    const breakerArb = fc.constantFrom("closed", "open", "half_open")
    const refArb = fc.record({
      providerID: fc.string({ minLength: 1, maxLength: 4 }),
      id: fc.string({ minLength: 1, maxLength: 4 }),
      variant: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
    }) as fc.Arbitrary<{ providerID: string; id: string; variant?: string }>
    const tierArb = fc.array(
      fc.record({
        ref: refArb,
        health: healthArb,
        breaker: breakerArb,
        windowed: fc.boolean(),
        windowUntil: fc.option(fc.nat(1_000_000), { nil: null }),
      }),
      { maxLength: 4 },
    )
    fc.assert(
      fc.property(
        fc.constantFrom<"off" | "observe" | "active">("off", "observe", "active"),
        fc.option(refArb, { nil: null }).map((v) => v ?? null),
        tierArb,
        tierArb,
        tierArb,
        (mode, pin, quick, standard, advanced) => {
          const s = snapshot({ mode, pin, tiers: { quick, standard, advanced } })
          for (const e of healthEntries(s)) {
            const text = healthDetail(e, s)
            expect(text).toContain("health:")
            expect(text).toContain("breaker:")
          }
          // Every resource appears exactly once in the overview.
          expect(
            healthOverview(s)
              .split("\n")
              .filter((line) => line.length > 0),
          ).toHaveLength(quick.length + standard.length + advanced.length)
          expect(HEALTH_EMPTY_MESSAGE.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
