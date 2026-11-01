// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  clockTime,
  healthEntries,
  statusLine,
  statusPage,
  STATUS_EMPTY_MESSAGE,
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

describe("status page", () => {
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

  it("groups the models by tier with the user's priority order inside each group", () => {
    const at = new Date(2026, 0, 1, 18, 42).getTime()
    const text = statusPage(
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
            entry({ ref: { providerID: "prov", id: "m0" } }),
          ],
          advanced: [
            entry({
              ref: { providerID: "prov", id: "m3" },
              breaker: "open",
            }),
          ],
        },
      }),
    )
    expect(text).toBe(
      [
        "quick:",
        "  prov/m2 — healthy (pinned)",
        "standard:",
        "  prov/m1 — rate_limited, windowed until 18:42",
        "  prov/m0 — healthy",
        "advanced:",
        "  prov/m3 — healthy, breaker open",
      ].join("\n"),
    )
  })

  it("omits empty tiers instead of printing empty groups", () => {
    const text = statusPage(snapshot({ tiers: { quick: [entry()], standard: [], advanced: [] } }))
    expect(text).toBe("quick:\n  prov/m1 — healthy")
  })

  it("marks an unknown window deadline and a probing breaker", () => {
    const text = statusPage(
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
    expect(lines[1]).toBe("  prov/m1 — rate_limited, windowed (deadline unknown)")
    expect(lines[2]).toBe("  prov/m1 — healthy, probing")
  })

  it("renders one line per resource without a tier prefix (statusLine)", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    expect(
      statusLine(entry({ health: "rate_limited", windowed: true, windowUntil: at }), null),
    ).toBe("prov/m1 — rate_limited, windowed until 09:05")
    expect(statusLine(entry(), { providerID: "prov", id: "m1" })).toBe("prov/m1 — healthy (pinned)")
    expect(
      statusLine(entry({ ref: { providerID: "prov", id: "other" } }), {
        providerID: "prov",
        id: "m1",
      }),
    ).toBe("prov/other — healthy")
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
          const lines = statusPage(s)
            .split("\n")
            .filter((line) => line.length > 0 && !line.endsWith(":"))
          // One status line per configured resource; group headers only for
          // non-empty tiers.
          expect(lines).toHaveLength(quick.length + standard.length + advanced.length)
          for (const line of lines) {
            expect(line.startsWith("  ")).toBe(true)
            expect(line).toMatch(/ — /)
          }
          expect(STATUS_EMPTY_MESSAGE.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
