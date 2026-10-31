/**
 * Escalation planner unit tests (ADP-015): ladder order, budget, evidence.
 */
import { describe, expect, it } from "vitest"
import { planEscalation } from "../../../src/core/scheduler/index.js"
import type { EscalationInput } from "../../../src/core/scheduler/index.js"
import { ref } from "./helpers.js"

const evidence = [{ kind: "repeated-failure", detail: "3 structured failures in-unit" }] as const

function inputOf(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    currentModel: ref("p", "m"),
    currentTier: "standard",
    nextTierResources: [],
    evidence: [...evidence],
    budget: { used: 0, max: 3 },
    ...overrides,
  }
}

describe("planEscalation — refusals", () => {
  it("defers when there is no structured evidence", () => {
    const decision = planEscalation(inputOf({ evidence: [] }))
    expect(decision).toEqual({ kind: "defer", reason: "escalation-not-justified" })
  })

  it("defers when the budget is spent", () => {
    expect(planEscalation(inputOf({ budget: { used: 3, max: 3 } }))).toEqual({
      kind: "defer",
      reason: "escalation-budget-exhausted",
    })
    expect(planEscalation(inputOf({ budget: { used: 5, max: 3 } }))).toEqual({
      kind: "defer",
      reason: "escalation-budget-exhausted",
    })
  })

  it("defers when the budget is non-positive", () => {
    expect(planEscalation(inputOf({ budget: { used: 0, max: 0 } }))).toEqual({
      kind: "defer",
      reason: "escalation-budget-exhausted",
    })
  })

  it("defers at the advanced ceiling", () => {
    const decision = planEscalation(inputOf({ currentTier: "advanced" }))
    expect(decision).toEqual({ kind: "defer", reason: "escalation-ceiling" })
  })

  it("defers when the next tier has no configured resources (no borrowing)", () => {
    const decision = planEscalation(inputOf({ nextTierResources: [] }))
    expect(decision).toEqual({ kind: "defer", reason: "escalation-no-candidate" })
  })
})

describe("planEscalation — variant step", () => {
  it("escalates to the next stronger variant on the same model", () => {
    const decision = planEscalation(
      inputOf({
        currentModel: ref("p", "m", "low"),
        variantLadder: ["minimal", "low", "medium", "high"],
        nextTierResources: [ref("q", "bigger")],
      }),
    )
    expect(decision).toEqual({
      kind: "escalate",
      target: ref("p", "m", "medium"),
      step: "variant",
      tier: "standard",
      evidence: [...evidence],
      budgetRemaining: 2,
    })
  })

  it("falls through to the tier step when the variant is already strongest", () => {
    const decision = planEscalation(
      inputOf({
        currentModel: ref("p", "m", "high"),
        variantLadder: ["low", "high"],
        nextTierResources: [ref("q", "bigger")],
      }),
    )
    expect(decision).toEqual({
      kind: "escalate",
      target: ref("q", "bigger"),
      step: "tier",
      tier: "advanced",
      evidence: [...evidence],
      budgetRemaining: 2,
    })
  })

  it("falls through to the tier step when the variant is not on the ladder", () => {
    const decision = planEscalation(
      inputOf({
        currentModel: ref("p", "m", "mystery"),
        variantLadder: ["low", "high"],
        nextTierResources: [ref("q", "bigger")],
      }),
    )
    expect(decision.kind).toBe("escalate")
    expect(decision.kind === "escalate" ? decision.step : undefined).toBe("tier")
  })

  it("falls through to the tier step when the current model has no variant", () => {
    const decision = planEscalation(
      inputOf({
        variantLadder: ["low", "high"],
        nextTierResources: [ref("q", "bigger")],
      }),
    )
    expect(decision.kind === "escalate" ? decision.step : undefined).toBe("tier")
  })
})

describe("planEscalation — tier step", () => {
  it("escalates to the first resource of the next tier in user order", () => {
    const decision = planEscalation(
      inputOf({ nextTierResources: [ref("q", "first"), ref("q", "second")] }),
    )
    expect(decision).toEqual({
      kind: "escalate",
      target: ref("q", "first"),
      step: "tier",
      tier: "advanced",
      evidence: [...evidence],
      budgetRemaining: 2,
    })
  })

  it("maps the tier ladder quick → standard", () => {
    const decision = planEscalation(
      inputOf({ currentTier: "quick", nextTierResources: [ref("q", "bigger")] }),
    )
    expect(decision.kind === "escalate" ? decision.tier : undefined).toBe("standard")
  })

  it("keeps only the latest evidence, bounded", () => {
    const many = [
      { kind: "repeated-failure", detail: "1" },
      { kind: "repeated-failure", detail: "2" },
      { kind: "agent-request", detail: "3" },
      { kind: "verification-failure", detail: "4" },
      { kind: "explicit-blocker", detail: "5" },
    ] as const
    const decision = planEscalation(
      inputOf({ evidence: [...many], nextTierResources: [ref("q", "bigger")] }),
    )
    expect(decision.kind).toBe("escalate")
    if (decision.kind !== "escalate") {
      throw new Error("unreachable")
    }
    expect(decision.evidence).toEqual([
      { kind: "repeated-failure", detail: "2" },
      { kind: "agent-request", detail: "3" },
      { kind: "verification-failure", detail: "4" },
      { kind: "explicit-blocker", detail: "5" },
    ])
  })
})
