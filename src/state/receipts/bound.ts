/**
 * Bounding for receipts (ADP-030). Receipts are built from typed scheduler
 * decisions, but every string they can carry is truncated to
 * `MAX_RECEIPT_TEXT` before persisting — including identifiers. Boundedness
 * is what makes the no-secrets invariant checkable: no field accepts
 * unbounded text, so nothing unbounded can be persisted.
 */
import type {
  ApplyDecision,
  DeferDecision,
  Decision,
  EscalateDecision,
  ObserveOnlyDecision,
  ParkDecision,
} from "../../core/scheduler/types.js"
import type { ModelRef } from "../../core/work-unit/types.js"
import { MAX_RECEIPT_TEXT } from "./types.js"

export function boundText(raw: string): string {
  return raw.length > MAX_RECEIPT_TEXT ? raw.slice(0, MAX_RECEIPT_TEXT) : raw
}

function boundRef(ref: ModelRef): ModelRef {
  return {
    providerID: boundText(ref.providerID),
    id: boundText(ref.id),
    ...(ref.variant !== undefined ? { variant: boundText(ref.variant) } : {}),
  }
}

function boundApply(decision: ApplyDecision): ApplyDecision {
  return {
    kind: "apply",
    model: boundRef(decision.model),
    ...(decision.tier !== undefined ? { tier: decision.tier } : {}),
    reason: decision.reason,
    evidence: {
      skipped: decision.evidence.skipped.map((skip) => ({
        ref: boundRef(skip.ref),
        why: skip.why,
      })),
      ...(decision.evidence.probeId !== undefined
        ? { probeId: boundText(decision.evidence.probeId) }
        : {}),
    },
  }
}

function boundDefer(decision: DeferDecision): DeferDecision {
  return {
    kind: "defer",
    reason: decision.reason,
    ...(decision.detail !== undefined ? { detail: boundText(decision.detail) } : {}),
  }
}

function boundPark(decision: ParkDecision): ParkDecision {
  return {
    kind: "park",
    reason: decision.reason,
    ...(decision.detail !== undefined ? { detail: boundText(decision.detail) } : {}),
  }
}

function boundEscalate(decision: EscalateDecision): EscalateDecision {
  return {
    kind: "escalate",
    target: boundRef(decision.target),
    step: decision.step,
    tier: decision.tier,
    evidence: decision.evidence.map((item) => ({
      kind: item.kind,
      ...(item.detail !== undefined ? { detail: boundText(item.detail) } : {}),
    })),
    budgetRemaining: decision.budgetRemaining,
  }
}

function boundObserveOnly(decision: ObserveOnlyDecision, depth: number): ObserveOnlyDecision {
  return { kind: "observe-only", would: boundDecision(decision.would, depth + 1) }
}

/**
 * Structural copy of a decision with every string bounded. `depth` guards
 * the `observe-only` recursion (max one nesting level is ever produced).
 */
export function boundDecision(decision: Decision, depth = 0): Decision {
  switch (decision.kind) {
    case "apply":
      return boundApply(decision)
    case "defer":
      return boundDefer(decision)
    case "park":
      return boundPark(decision)
    case "escalate":
      return boundEscalate(decision)
    case "observe-only":
      return depth < 2 ? boundObserveOnly(decision, depth) : decision
  }
}
