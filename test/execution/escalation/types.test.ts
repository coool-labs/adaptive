/**
 * Escalation request surface tests (T-18, ADP-015): the typed schema requires
 * a reason and evidence; the parser is total and bounded (model-produced JSON
 * is untrusted even though the standard schema describes it).
 */
// covers: ["ADP-015"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ESCALATION_TOOL_NAME,
  MAX_ESCALATION_FIELD_LENGTH,
  escalationDetail,
  parseEscalationRequest,
} from "../../../src/execution/escalation/index.js"

describe("escalation request", () => {
  it("pins the tool name and field bound", () => {
    expect(ESCALATION_TOOL_NAME).toBe("adaptive_escalate")
    expect(MAX_ESCALATION_FIELD_LENGTH).toBe(256)
  })

  it("parses a valid request", () => {
    expect(parseEscalationRequest({ reason: "context too small", evidence: "413" })).toEqual({
      reason: "context too small",
      evidence: "413",
    })
  })

  it("rejects non-objects and missing or empty fields", () => {
    expect(parseEscalationRequest(undefined)).toBeUndefined()
    expect(parseEscalationRequest(null)).toBeUndefined()
    expect(parseEscalationRequest("escalate")).toBeUndefined()
    expect(parseEscalationRequest({})).toBeUndefined()
    expect(parseEscalationRequest({ reason: "r" })).toBeUndefined()
    expect(parseEscalationRequest({ reason: "r", evidence: "" })).toBeUndefined()
    expect(parseEscalationRequest({ reason: "", evidence: "e" })).toBeUndefined()
    expect(parseEscalationRequest({ reason: 1, evidence: "e" })).toBeUndefined()
    expect(parseEscalationRequest({ reason: "r", evidence: null })).toBeUndefined()
  })

  it("bounds both fields", () => {
    const long = "x".repeat(MAX_ESCALATION_FIELD_LENGTH + 100)
    const parsed = parseEscalationRequest({ reason: long, evidence: long })
    expect(parsed?.reason).toHaveLength(MAX_ESCALATION_FIELD_LENGTH)
    expect(parsed?.evidence).toHaveLength(MAX_ESCALATION_FIELD_LENGTH)
  })

  it("never splits a UTF-16 surrogate pair when truncating (E6 regression)", () => {
    // An astral-plane character straddling the truncation point used to leave
    // a lone high surrogate in the persisted evidence.
    const text = `${"a".repeat(MAX_ESCALATION_FIELD_LENGTH - 1)}\u{1F600}${"b".repeat(10)}`
    const parsed = parseEscalationRequest({ reason: text, evidence: "e" })
    const reason = parsed?.reason ?? ""
    expect(reason.length).toBeLessThanOrEqual(MAX_ESCALATION_FIELD_LENGTH)
    const last = reason.at(-1) ?? ""
    expect(last.codePointAt(0)).not.toBeGreaterThanOrEqual(0xd800)
    const detail = escalationDetail({ reason: text, evidence: "e" })
    expect(detail.length).toBeLessThanOrEqual(MAX_ESCALATION_FIELD_LENGTH * 2 + 2)
    // for-of on a string iterates whole code points, so a lone surrogate —
    // the defect — shows up as a single unit in the surrogate range.
    for (const unit of detail) {
      const cp = unit.codePointAt(0) ?? 0
      expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false)
    }
  })

  it("builds a bounded detail line", () => {
    expect(escalationDetail({ reason: "context", evidence: "413 overflow" })).toBe(
      "context: 413 overflow",
    )
  })

  it("is total and deterministic over arbitrary input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const first = parseEscalationRequest(raw)
        expect(parseEscalationRequest(raw)).toEqual(first)
        if (first === undefined) return
        expect(first.reason.length).toBeLessThanOrEqual(MAX_ESCALATION_FIELD_LENGTH)
        expect(first.evidence.length).toBeLessThanOrEqual(MAX_ESCALATION_FIELD_LENGTH)
        expect(first.reason.length).toBeGreaterThan(0)
      }),
      { numRuns: 300 },
    )
  })
})
