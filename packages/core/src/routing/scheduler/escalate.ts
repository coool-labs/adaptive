/**
 * Capability escalation planner (ADP-015).
 *
 * Escalation is justified only by non-empty structured evidence, follows the
 * ladder next tier, and is bounded by the caller's finite budget. The
 * same-model stronger-variant rung is not implemented: it would need an
 * ordered variant ladder the host does not expose, and strength is never
 * guessed from variant names. Every output moves strictly up the ladder or
 * refuses. Termination rests on the budget, which the caller must carry
 * across every unit of one task (each escalation continues on a new unit).
 */
import { nextTier } from "../tier-policy/types.js"
import type { ModelRef } from "../work-unit/types.js"
import type { DeferDecision, EscalateDecision, EscalationInput } from "./types.js"
import { MAX_ESCALATION_EVIDENCE } from "./types.js"

/**
 * Only a well-formed whole-number budget can bound the loop: NaN, infinite,
 * fractional, or negative counters would make `used >= max` unreachable or
 * leave a negative remainder, so they read as exhausted (finite is the
 * invariant, not the caller's good behavior).
 */
function hasBudgetLeft({ used, max }: EscalationInput["budget"]): boolean {
  return Number.isSafeInteger(used) && Number.isSafeInteger(max) && used >= 0 && used < max
}

function escalate(
  input: EscalationInput,
  target: ModelRef,
  step: EscalateDecision["step"],
  tier: EscalateDecision["tier"],
): EscalateDecision {
  return {
    kind: "escalate",
    target,
    step,
    tier,
    evidence: input.evidence.slice(-MAX_ESCALATION_EVIDENCE),
    budgetRemaining: input.budget.max - input.budget.used - 1,
  }
}

/**
 * Plan the next escalation step, or defer with the reason escalation cannot
 * proceed. Total and deterministic.
 */
export function planEscalation(input: EscalationInput): EscalateDecision | DeferDecision {
  if (input.evidence.length === 0) {
    return { kind: "defer", reason: "escalation-not-justified" }
  }
  if (!hasBudgetLeft(input.budget)) {
    return { kind: "defer", reason: "escalation-budget-exhausted" }
  }
  const next = nextTier(input.currentTier)
  if (next === undefined) {
    return { kind: "defer", reason: "escalation-ceiling" }
  }
  const target = input.nextTierResources[0]
  if (target === undefined) {
    return { kind: "defer", reason: "escalation-no-candidate" }
  }
  return escalate(input, target, "tier", next)
}
