/**
 * Escalation boundedness and capability/availability separation (ADP-011,
 * ADP-013, ADP-015): the planner stays finite for any budget it is handed, and
 * the vocabulary that justifies escalation can never be infrastructure health.
 */
// covers: ["ADP-011", "ADP-013", "ADP-015", "ADP-038"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  CAPABILITY_FAILURE_CATEGORIES,
  MAX_ESCALATIONS_PER_TASK,
} from "../../../src/execution/escalation/types.js"
import { classifyFailure } from "../../../src/health/classifier/classify.js"
import { FAILURE_CATEGORIES } from "../../../src/health/classifier/types.js"
import { ESCALATION_EVIDENCE_KINDS, planEscalation } from "../../../src/routing/scheduler/index.js"
import type { EscalationInput } from "../../../src/routing/scheduler/index.js"
import { ref } from "./helpers.js"

function inputOf(budget: EscalationInput["budget"]): EscalationInput {
  return {
    currentModel: ref("p", "m"),
    currentTier: "quick",
    nextTierResources: [ref("q", "bigger")],
    evidence: [{ kind: "repeated-failure", detail: "structured" }],
    budget,
  }
}

describe("planEscalation — malformed budgets never loosen the bound", () => {
  it.each([
    ["NaN max", { used: 0, max: Number.NaN }],
    ["infinite max", { used: 0, max: Number.POSITIVE_INFINITY }],
    ["fractional max", { used: 0, max: 0.5 }],
    ["NaN used", { used: Number.NaN, max: 2 }],
    ["negative used", { used: -1, max: 2 }],
    ["fractional used", { used: 0.5, max: 2 }],
    ["negative max", { used: -3, max: -1 }],
  ])("defers on %s as an exhausted budget", (_name, budget) => {
    expect(planEscalation(inputOf(budget))).toEqual({
      kind: "defer",
      reason: "escalation-budget-exhausted",
    })
  })

  it("honors the last whole slot and refuses the next", () => {
    expect(planEscalation(inputOf({ used: 1, max: 2 })).kind).toBe("escalate")
    expect(planEscalation(inputOf({ used: 2, max: 2 })).kind).toBe("defer")
  })

  it("any budget yields either a refusal or a non-negative whole remainder", () => {
    const numberArb = fc.oneof(
      fc.integer({ min: -3, max: 8 }),
      fc.double({ noDefaultInfinity: false, noNaN: false }),
    )
    const prop = fc.property(numberArb, numberArb, (used, max) => {
      const decision = planEscalation(inputOf({ used, max }))
      if (decision.kind === "escalate") {
        expect(Number.isInteger(decision.budgetRemaining)).toBe(true)
        expect(decision.budgetRemaining).toBeGreaterThanOrEqual(0)
        expect(decision.budgetRemaining).toBeLessThan(max)
      }
    })
    fc.assert(prop, { numRuns: 500 })
  })

  it("a chained escalation under the per-task budget stops at exactly the budget", () => {
    let used = 0
    let steps = 0
    while (planEscalation(inputOf({ used, max: MAX_ESCALATIONS_PER_TASK })).kind === "escalate") {
      used += 1
      steps += 1
      expect(steps).toBeLessThanOrEqual(MAX_ESCALATIONS_PER_TASK)
    }
    expect(steps).toBe(MAX_ESCALATIONS_PER_TASK)
  })
})

describe("capability vs availability vocabulary (ADP-013)", () => {
  it("no escalation evidence kind is an infrastructure failure category", () => {
    for (const kind of ESCALATION_EVIDENCE_KINDS) {
      expect(FAILURE_CATEGORIES as readonly string[]).not.toContain(kind)
      expect(kind).not.toMatch(/rate|quota|outage|overload|timeout|unavailable|5\d\d|429/i)
    }
  })

  it("capability failure categories are never failover-eligible infrastructure", () => {
    for (const category of CAPABILITY_FAILURE_CATEGORIES) {
      const infra = FAILURE_CATEGORIES.filter(
        (candidate) =>
          candidate === "rate_limited" ||
          candidate === "quota_exhausted" ||
          candidate === "outage" ||
          candidate === "overload" ||
          candidate === "timeout",
      )
      expect(infra as readonly string[]).not.toContain(category)
    }
  })

  it("every category the classifier marks failover-eligible is outside the capability set", () => {
    const evidences = [
      { status: 429 },
      { status: 402 },
      { status: 408 },
      { status: 503 },
      { text: "overloaded" },
      { text: "timed out" },
      { structured: { type: "ServiceUnavailableError" } },
    ]
    for (const evidence of evidences) {
      const c = classifyFailure(evidence)
      expect(c.failoverEligible).toBe(true)
      expect(CAPABILITY_FAILURE_CATEGORIES).not.toContain(c.category)
    }
  })
})
