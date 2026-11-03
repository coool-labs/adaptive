// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  clockTime,
  healthEntries,
  statusLine,
  statusTable,
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
    usedPercent: null,
    resetAt: null,
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

describe("status table", () => {
  it("distinguishes weekly reset dates even when their clock times match", () => {
    const first = statusLine(
      entry({ usedPercent: 100, resetAt: new Date(2026, 10, 3, 18, 42).getTime() }),
      null,
    )
    const next = statusLine(
      entry({ usedPercent: 100, resetAt: new Date(2026, 10, 10, 18, 42).getTime() }),
      null,
    )
    expect(first).toContain("2026-11-03 18:42")
    expect(next).toContain("2026-11-10 18:42")
    expect(first).not.toBe(next)
  })
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
    expect(clockTime(at)).toBe("2026-01-01 18:42")
  })

  it("aligns every row into columns with a header row, tier then priority order", () => {
    const at = new Date(2026, 0, 1, 18, 42).getTime()
    const lines = statusTable(
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
    expect(lines[0]).toBe("MODEL    TIER      HEALTH        STATE")
    expect(lines[1]).toBe("prov/m2  quick     healthy       (pinned)")
    expect(lines[2]).toBe("prov/m1  standard  rate_limited  windowed until 2026-01-01 18:42")
    expect(lines[3]).toBe("prov/m0  standard  healthy       -")
    expect(lines[4]).toBe("prov/m3  advanced  healthy       breaker open")
  })

  it("pads columns to the widest cell and right-trims the last column", () => {
    const lines = statusTable(snapshot({ tiers: { quick: [entry()], standard: [], advanced: [] } }))
    expect(lines[0]).toBe("MODEL    TIER   HEALTH   STATE")
    expect(lines[1]).toBe("prov/m1  quick  healthy  -")
  })

  it("renders capacity usage and its reset time in STATE", () => {
    const at = new Date(2026, 0, 1, 18, 42).getTime()
    const lines = statusTable(
      snapshot({
        tiers: {
          quick: [
            entry({ usedPercent: 72, resetAt: at }),
            entry({ usedPercent: 100 }),
            entry({ usedPercent: 0, resetAt: at }),
          ],
          standard: [],
          advanced: [],
        },
      }),
    )
    expect(lines[1]).toContain("used 72%, resets 2026-01-01 18:42")
    expect(lines[2]).toContain("used 100%")
    expect(lines[3]).toContain("used 0%, resets 2026-01-01 18:42")
    // No reading → no capacity text at all.
    expect(lines[0]).not.toContain("used")
  })

  it("marks an unknown window deadline and a probing breaker in STATE", () => {
    const lines = statusTable(
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
    expect(lines[1]).toContain("windowed (deadline unknown)")
    expect(lines[2]).toContain("probing")
  })

  it("returns no lines when nothing is configured", () => {
    expect(statusTable(snapshot())).toEqual([])
  })

  it("renders one line per resource without a tier prefix (statusLine)", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    expect(
      statusLine(entry({ health: "rate_limited", windowed: true, windowUntil: at }), null),
    ).toBe("prov/m1 — rate_limited, windowed until 2026-01-01 09:05")
    expect(statusLine(entry(), { providerID: "prov", id: "m1" })).toBe("prov/m1 — healthy (pinned)")
    expect(
      statusLine(entry({ ref: { providerID: "prov", id: "other" } }), {
        providerID: "prov",
        id: "m1",
      }),
    ).toBe("prov/other — healthy")
    const capAt = new Date(2026, 0, 1, 18, 42).getTime()
    expect(statusLine(entry({ usedPercent: 72, resetAt: capAt }), null)).toBe(
      "prov/m1 — healthy, used 72%, resets 2026-01-01 18:42",
    )
    expect(statusLine(entry({ usedPercent: 30 }), null)).toBe("prov/m1 — healthy, used 30%")
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
      providerID: fc.stringMatching(/^[a-z0-9]{1,4}$/),
      id: fc.stringMatching(/^[a-z0-9]{1,4}$/),
      variant: fc.option(fc.stringMatching(/^[a-z0-9]{1,4}$/), { nil: null }),
    }) as fc.Arbitrary<{ providerID: string; id: string; variant?: string }>
    const tierArb = fc.array(
      fc.record({
        ref: refArb,
        health: healthArb,
        breaker: breakerArb,
        windowed: fc.boolean(),
        windowUntil: fc.option(fc.nat(1_000_000), { nil: null }),
        usedPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
        resetAt: fc.option(fc.nat(1_000_000), { nil: null }),
      }),
      { maxLength: 4 },
    )
    fc.assert(
      fc.property(
        fc.constantFrom<"off" | "observe" | "active">("off", "observe", "active"),
        fc.option(refArb, { nil: null }),
        tierArb,
        tierArb,
        tierArb,
        (mode, pin, quick, standard, advanced) => {
          const s = snapshot({ mode, pin, tiers: { quick, standard, advanced } })
          const lines = statusTable(s)
          const count = quick.length + standard.length + advanced.length
          // One table row per configured resource, plus the header row when
          // anything is configured; every row has exactly four columns.
          expect(lines).toHaveLength(count === 0 ? 0 : count + 1)
          for (const line of lines) {
            expect(line.split(/ {2,}/)).toHaveLength(4)
          }
          expect(STATUS_EMPTY_MESSAGE.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
