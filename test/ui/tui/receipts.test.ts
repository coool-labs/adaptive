// covers: ["ADP-030", "ADP-033"]
import { describe, expect, it } from "vitest"
import {
  outcomeLine,
  receiptDetail,
  receiptLine,
  receiptPage,
  RECEIPTS_PAGE_SIZE,
  summarizeDecision,
} from "../../../src/ui/tui/receipts.js"
import type { Decision } from "../../../src/core/scheduler/types.js"
import type { Receipt, ReceiptOutcome } from "../../../src/state/receipts/types.js"
import { TIERS } from "../../../src/core/tier-policy/types.js"

function applyDecision(): Decision {
  return {
    kind: "apply",
    model: { providerID: "prov", id: "m1", variant: "high" },
    tier: "standard",
    reason: "preferred",
    evidence: { skipped: [] },
  }
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 3,
    at: Date.parse("2026-10-31T00:00:00.000Z"),
    sessionID: "s1",
    decision: applyDecision(),
    ...overrides,
  }
}

describe("summarizeDecision", () => {
  it("renders each decision kind", () => {
    expect(summarizeDecision(applyDecision())).toBe("apply prov/m1@high [standard] (preferred)")
    expect(
      summarizeDecision({
        kind: "apply",
        model: { providerID: "p", id: "m" },
        reason: "fallback",
        evidence: { skipped: [] },
      }),
    ).toBe("apply p/m (fallback)")
    expect(summarizeDecision({ kind: "defer", reason: "routing-defer" })).toBe(
      "defer: routing-defer",
    )
    expect(
      summarizeDecision({ kind: "defer", reason: "routing-defer", detail: "tier-not-configured" }),
    ).toBe("defer: routing-defer — tier-not-configured")
    expect(summarizeDecision({ kind: "park", reason: "all-blocked" })).toBe("park: all-blocked")
    expect(summarizeDecision({ kind: "park", reason: "all-blocked", detail: "" })).toBe(
      "park: all-blocked — ",
    )
    expect(
      summarizeDecision({
        kind: "escalate",
        target: { providerID: "prov", id: "m2" },
        step: "tier",
        tier: "advanced",
        evidence: [],
        budgetRemaining: 1,
      }),
    ).toBe("escalate tier → prov/m2 [advanced]")
    expect(
      summarizeDecision({
        kind: "observe-only",
        would: { kind: "defer", reason: "routing-defer" },
      }),
    ).toBe("observe: defer: routing-defer")
  })
})

describe("outcomeLine", () => {
  const outcomes: (ReceiptOutcome | undefined)[] = [
    undefined,
    { status: "succeeded" },
    { status: "failed", category: "rate_limited" },
    { status: "interrupted", reason: "user" },
  ]
  const expected = ["pending", "succeeded", "failed (rate_limited)", "interrupted (user)"]
  it("renders pending, succeeded, failed, and interrupted outcomes", () => {
    outcomes.forEach((outcome, i) => {
      expect(outcomeLine(outcome)).toBe(expected[i])
    })
  })
})

describe("receiptLine", () => {
  it("joins id, decision, and outcome", () => {
    expect(receiptLine(receipt())).toBe("#3 apply prov/m1@high [standard] (preferred) — pending")
    expect(receiptLine(receipt({ id: 12, outcome: { status: "succeeded" } }))).toBe(
      "#12 apply prov/m1@high [standard] (preferred) — succeeded",
    )
  })
})

describe("receiptDetail", () => {
  it("renders every field with dashes for missing optionals", () => {
    const text = receiptDetail(receipt({ outcome: { status: "failed", category: "outage" } }))
    const lines = text.split("\n")
    expect(lines).toEqual([
      "id: 3",
      "at: 2026-10-31T00:00:00.000Z",
      "session: s1",
      "unit: -",
      "tier: -",
      "decision: apply prov/m1@high [standard] (preferred)",
      "outcome: failed (outage)",
    ])
  })

  it("renders unit and tier when present", () => {
    const text = receiptDetail(receipt({ unitID: "s1#1", tier: TIERS[1] }))
    expect(text).toContain("unit: s1#1")
    expect(text).toContain("tier: standard")
  })
})

describe("receiptPage", () => {
  it("caps the page at the page size", () => {
    expect(RECEIPTS_PAGE_SIZE).toBe(20)
    const many: Receipt[] = Array.from({ length: 25 }, (_, i) => receipt({ id: i }))
    expect(receiptPage(many)).toHaveLength(20)
    expect(receiptPage(many)[0]).toEqual(receipt({ id: 0 }))
    expect(receiptPage([])).toEqual([])
  })
})
