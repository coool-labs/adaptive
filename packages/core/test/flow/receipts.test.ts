// covers: ["ADP-030", "ADP-033"]
import { describe, expect, it } from "vitest"
import {
  outcomeLine,
  receiptDetail as formatReceiptDetail,
  relativeTime,
  receiptLine,
  receiptPage,
  RECEIPTS_PAGE_SIZE,
  summarizeDecision,
  whatHappened as explainReceipt,
} from "../../src/flow/receipts.js"
import type { Decision } from "../../src/routing/scheduler/types.js"
import type { Receipt, ReceiptOutcome } from "../../src/state/receipts/types.js"
import { TIERS } from "../../src/routing/tier-policy/types.js"
import { OPENCODE_COPY } from "../host-copy.js"

const receiptDetail = (value: Receipt, now?: number): string =>
  formatReceiptDetail(value, OPENCODE_COPY, now)
const whatHappened = (value: Receipt): string => explainReceipt(value, OPENCODE_COPY)

it("lets durable-parking hosts explain waits without changing legacy host copy", () => {
  const value = receipt({ decision: { kind: "park", reason: "all-blocked" } })
  expect(
    explainReceipt(value, { ...OPENCODE_COPY, parkExplanation: (reason) => `Waiting: ${reason}` }),
  ).toBe("Waiting: all-blocked")
  expect(explainReceipt(value, OPENCODE_COPY)).toContain("ran without Adaptive routing")
})

it("uses host-specific defer semantics rather than substituting a product name", () => {
  const copy = {
    ...OPENCODE_COPY,
    receiptExplanation: () => "The same-tier baseline was retained.",
  }
  for (const reason of [
    "routing-defer",
    "adaptive-off",
    "pin-unverifiable",
    "pin-incompatible",
  ] as const) {
    const value = receipt({ decision: { kind: "defer", reason } })
    expect(explainReceipt(value, copy)).toBe("The same-tier baseline was retained.")
    expect(formatReceiptDetail(value, copy, 0)).toContain("The same-tier baseline was retained.")
  }
})

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
    const at = Date.parse("2026-10-31T00:00:00.000Z")
    const text = receiptDetail(
      receipt({ outcome: { status: "failed", category: "outage" } }),
      at + 90_000,
    )
    const lines = text.split("\n")
    expect(lines).toEqual([
      "id: 3",
      "when: 1m ago (2026-10-31T00:00:00.000Z)",
      "session: s1",
      "unit: -",
      "tier: -",
      "decision: apply prov/m1@high [standard] (preferred)",
      "outcome: failed (outage)",
      "",
      expect.stringContaining("What happened: Adaptive chose this resource"),
    ])
  })

  it("renders unit and tier when present", () => {
    const text = receiptDetail(receipt({ unitID: "s1#1", tier: TIERS[1] }))
    expect(text).toContain("unit: s1#1")
    expect(text).toContain("tier: standard")
  })
})

describe("whatHappened", () => {
  it.each([
    ["escalation-ceiling", "no stronger tier is configured"],
    ["escalation-budget-exhausted", "escalation budget"],
    ["escalation-not-justified", "structured capability evidence"],
    ["pin-incompatible", "requirements"],
  ] as const)("explains %s distinctly", (reason, explanation) => {
    expect(whatHappened(receipt({ decision: { kind: "defer", reason } }))).toContain(explanation)
  })

  // A receipt parsed from a newer host may carry a reason this build does not
  // know; the drifted casts simulate that vocabulary extension at the type
  // level so the runtime fallback branches stay pinned.
  it("explains every decision kind in plain language", () => {
    expect(
      whatHappened(
        receipt({
          decision: {
            kind: "apply",
            model: { providerID: "p", id: "m" },
            reason: "fallback",
            evidence: { skipped: [] },
          },
        }),
      ),
    ).toMatch(/moved the turn/)
    expect(whatHappened(receipt({ decision: { kind: "park", reason: "all-blocked" } }))).toMatch(
      /Every resource in the tier/,
    )
    expect(
      whatHappened(
        receipt({
          decision: {
            kind: "escalate",
            target: { providerID: "prov", id: "m2" },
            step: "tier",
            tier: "advanced",
            evidence: [],
            budgetRemaining: 1,
          },
        }),
      ),
    ).toMatch(/stronger capability/)
    expect(
      whatHappened(receipt({ decision: { kind: "observe-only", would: applyDecision() } })),
    ).toMatch(/observing/)
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z")
  it("renders each bucket", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now")
    expect(relativeTime(now - 90_000, now)).toBe("1m ago")
    expect(relativeTime(now - 90 * 60_000, now)).toBe("1h ago")
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("1d ago")
  })

  it("clamps clock skew into the just-now bucket", () => {
    expect(relativeTime(now + 10_000, now)).toBe("just now")
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
