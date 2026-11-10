/**
 * Receipt text bounds must never cut an emoji in half: agent-written escalation
 * evidence ends up in receipts, and a lone surrogate would persist, render as
 * garbage, and throw in URI encoders (ADP-030, ADP-051).
 */
// covers: ["ADP-030", "ADP-051"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { boundDecision, boundText } from "../../../src/state/receipts/bound.js"
import { parseReceiptsPayload } from "../../../src/state/receipts/parse.js"
import { MAX_RECEIPT_TEXT, RECEIPTS_VERSION } from "../../../src/state/receipts/types.js"

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

describe("receipt text bounds keep surrogate pairs whole", () => {
  it("backs off an emoji straddling the bound instead of cutting it", () => {
    const text = `${"a".repeat(MAX_RECEIPT_TEXT - 1)}😀tail`
    const bounded = boundText(text)
    expect(bounded).toBe("a".repeat(MAX_RECEIPT_TEXT - 1))
    expect(LONE_SURROGATE.test(bounded)).toBe(false)
  })

  it("keeps an emoji that fits exactly", () => {
    const text = `${"a".repeat(MAX_RECEIPT_TEXT - 2)}😀tail`
    expect(boundText(text)).toBe(`${"a".repeat(MAX_RECEIPT_TEXT - 2)}😀`)
  })

  it("bounds escalate evidence detail without a lone surrogate, and it survives a read", () => {
    const detail = `${"b".repeat(MAX_RECEIPT_TEXT - 1)}🚀 more`
    const decision = boundDecision({
      kind: "escalate",
      target: { providerID: "p", id: "m" },
      step: "tier",
      tier: "advanced",
      evidence: [{ kind: "agent-request", detail }],
      budgetRemaining: 1,
    })
    const stored = JSON.stringify({
      version: RECEIPTS_VERSION,
      receipts: [{ id: 1, at: 1, sessionID: "s", decision }],
    })
    const [receipt] = parseReceiptsPayload(JSON.parse(stored))
    const read = receipt?.decision.kind === "escalate" ? receipt.decision.evidence[0]?.detail : ""
    expect(read).toBe("b".repeat(MAX_RECEIPT_TEXT - 1))
    expect(() => encodeURIComponent(read ?? "")).not.toThrow()
  })

  it("re-bounds an over-long persisted detail on read without splitting a pair", () => {
    const raw = {
      version: RECEIPTS_VERSION,
      receipts: [
        {
          id: 1,
          at: 1,
          sessionID: "s",
          decision: { kind: "defer", reason: "routing-defer", detail: `${"c".repeat(127)}😀` },
        },
      ],
    }
    const [receipt] = parseReceiptsPayload(raw)
    expect(receipt?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "c".repeat(127),
    })
  })

  it("property: bounded text is a prefix, within the bound, pair-safe and idempotent", () => {
    const prop = fc.property(
      fc.string({ unit: fc.constantFrom("a", "😀", "🚀"), minLength: 100, maxLength: 200 }),
      (text) => {
        const bounded = boundText(text)
        expect(bounded.length).toBeLessThanOrEqual(MAX_RECEIPT_TEXT)
        expect(text.startsWith(bounded)).toBe(true)
        expect(LONE_SURROGATE.test(bounded)).toBe(
          LONE_SURROGATE.test(text.slice(0, bounded.length)),
        )
        if (!LONE_SURROGATE.test(text)) expect(LONE_SURROGATE.test(bounded)).toBe(false)
        expect(boundText(bounded)).toBe(bounded)
        // Never needlessly short: at most one unit is given up for pair integrity.
        expect(bounded.length).toBeGreaterThanOrEqual(Math.min(text.length, MAX_RECEIPT_TEXT - 1))
      },
    )
    fc.assert(prop, { numRuns: 400 })
  })
})
