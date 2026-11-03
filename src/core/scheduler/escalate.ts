/**
 * Capability escalation planner (ADP-015).
 *
 * Escalation is justified only by non-empty structured evidence, follows the
 * ladder same model / current effort → same model / stronger effort → next
 * tier, and is bounded by the caller's finite budget. Every output either
 * moves strictly up the ladder or refuses: the planner itself never steps
 * sideways or down. Termination across steps rests on the budget, which the
 * caller must carry across every unit of one task (each escalation continues
 * on a new unit).
 */
import { nextTier } from "../tier-policy/types.js"
import type { ModelRef } from "../work-unit/types.js"
import type { DeferDecision, EscalateDecision, EscalationInput } from "./types.js"
import { MAX_ESCALATION_EVIDENCE } from "./types.js"

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
  if (input.budget.max <= 0 || input.budget.used >= input.budget.max) {
    return { kind: "defer", reason: "escalation-budget-exhausted" }
  }
  const { currentModel, variantLadder } = input
  if (currentModel.variant !== undefined && variantLadder !== undefined) {
    const index = variantLadder.indexOf(currentModel.variant)
    if (index >= 0) {
      // For a well-formed (non-holey) ladder, undefined here means the current
      // variant is the strongest — the ladder is exhausted.
      const stronger = variantLadder[index + 1]
      if (stronger !== undefined) {
        return escalate(input, { ...currentModel, variant: stronger }, "variant", input.currentTier)
      }
    }
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
