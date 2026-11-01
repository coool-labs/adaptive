// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { formatStatus } from "../../../src/ui/tui/status.js"
import type { StatusSnapshot } from "../../../src/rpc/status.js"

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

describe("formatStatus", () => {
  it("renders mode, pin, tiers, and counters", () => {
    const text = formatStatus(snapshot())
    expect(text).toBe(
      "mode: observe\npin: none\ntier quick (0)\n  (empty)\ntier standard (0)\n  (empty)\ntier advanced (0)\n  (empty)\nparked: 0\nreceipts: 0",
    )
  })

  it("renders a pin and health tags", () => {
    const text = formatStatus(
      snapshot({
        mode: "control",
        pin: { providerID: "prov", id: "m1", variant: "high" },
        tiers: {
          quick: [],
          standard: [
            {
              ref: { providerID: "prov", id: "m1" },
              health: "rate_limited",
              breaker: "closed",
              windowed: true,
            },
            {
              ref: { providerID: "prov", id: "m2" },
              health: "healthy",
              breaker: "open",
              windowed: false,
            },
            {
              ref: { providerID: "prov", id: "m3" },
              health: "healthy",
              breaker: "half_open",
              windowed: false,
            },
            {
              ref: { providerID: "prov", id: "m4" },
              health: "healthy",
              breaker: "closed",
              windowed: false,
            },
          ],
          advanced: [],
        },
        parked: 3,
        receipts: 9,
      }),
    )
    const lines = text.split("\n")
    expect(lines[0]).toBe("mode: control")
    expect(lines[1]).toBe("pin: prov/m1@high")
    expect(lines[4]).toBe("tier standard (4)")
    expect(lines[5]).toContain("prov/m1 [rate_limited, windowed]")
    expect(lines[6]).toContain("prov/m2 [breaker-open]")
    expect(lines[7]).toContain("prov/m3 [half-open]")
    expect(lines[8]).toBe("  prov/m4")
    expect(text).toContain("parked: 3")
    expect(text).toContain("receipts: 9")
  })

  it("is deterministic and never throws over arbitrary snapshots", () => {
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
      variant: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: undefined }),
    }) as fc.Arbitrary<{ providerID: string; id: string; variant?: string }>
    const tierArb = fc.array(
      fc.record({
        ref: refArb,
        health: healthArb,
        breaker: breakerArb,
        windowed: fc.boolean(),
      }),
      { maxLength: 4 },
    )
    fc.assert(
      fc.property(
        fc.constantFrom<"off" | "observe" | "control">("off", "observe", "control"),
        fc.option(refArb, { nil: null }).map((v) => v ?? null),
        tierArb,
        tierArb,
        tierArb,
        fc.nat(20),
        fc.nat(20),
        (mode, pin, quick, standard, advanced, parked, receipts) => {
          const s = snapshot({ mode, pin, tiers: { quick, standard, advanced }, parked, receipts })
          const text = formatStatus(s)
          expect(formatStatus(s)).toBe(text)
          expect(text.split("\n").length).toBeGreaterThan(8)
        },
      ),
      { numRuns: 100 },
    )
  })
})
