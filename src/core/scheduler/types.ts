/**
 * Scheduler types (ADP-013/015/016/022): the pure decision core's vocabulary.
 *
 * The core is a total function over its inputs — routing outcome, demand,
 * inventory, per-candidate health and capacity views — and never performs
 * effects. Effects (switching, receipts, parking) belong to the execution
 * layer. OBSERVE and CONTROL call the same core; mode handling is a pure
 * wrapper (`forMode`).
 */
import type { ModelRef } from "../work-unit/types.js"
import type { RoutingDecision, TierName } from "../tier-policy/types.js"
import type { CandidateModel, Demand } from "../compatibility/types.js"
import type { Assessment } from "../../health/resource-health/types.js"
import type { CapacitySignals } from "../../health/capacity/types.js"
import { INCOMPATIBILITY_REASONS } from "../compatibility/types.js"
import { BLOCKED_REASONS } from "../../health/resource-health/types.js"
import { resourceKeyID } from "../../health/resource-health/key.js"

/** Operating modes (GOAL manual control). The plugin defaults to `observe`. */
export const OPERATING_MODES = ["off", "observe", "control"] as const satisfies readonly string[]

export type OperatingMode = (typeof OPERATING_MODES)[number]

/** Why an `apply` decision chose its model (receipt provenance). */
export const APPLY_REASONS = [
  "pin",
  "preferred",
  "fallback",
  "probe",
  "draining",
] as const satisfies readonly string[]

export type ApplyReason = (typeof APPLY_REASONS)[number]

/**
 * Why the core did not apply anything.
 * - `routing-defer` — the tier ladder deferred; OpenCode's choice stands.
 * - `pin-unverifiable` — the pinned model is not in the host inventory, so
 *   availability cannot be verified (inventory gate); deferring keeps the
 *   user's own model choice, which for a pin is typically the pinned model.
 * - `pin-incompatible` — the pinned model cannot execute the work.
 * - `escalation-*` — escalation evidence was absent, the budget was spent,
 *   the tier ladder is at its ceiling, or the next tier has no resources
 *   (no cross-tier borrowing).
 * - `adaptive-off` — the plugin is off; only reachable through `forMode`.
 */
export const SCHEDULER_DEFER_REASONS = [
  "routing-defer",
  "pin-unverifiable",
  "pin-incompatible",
  "escalation-not-justified",
  "escalation-budget-exhausted",
  "escalation-ceiling",
  "escalation-no-candidate",
  "adaptive-off",
] as const satisfies readonly string[]

export type SchedulerDeferReason = (typeof SCHEDULER_DEFER_REASONS)[number]

/**
 * Why work parks instead of applying: the required tier has no usable
 * resource right now. Parking waits for recovery — it never borrows across
 * tiers (ADP-022).
 */
export const PARK_REASONS = [
  "pin-blocked",
  "no-candidates",
  "no-compatible-resource",
  "all-blocked",
] as const satisfies readonly string[]

export type ParkReason = (typeof PARK_REASONS)[number]

/** Why a tier candidate was not usable. Superset of gate and health reasons. */
export const SKIP_REASONS = [
  "not-in-inventory",
  "capacity-exhausted",
  "incompatible",
  ...INCOMPATIBILITY_REASONS,
  ...BLOCKED_REASONS,
] as const satisfies readonly string[]

export type SkipReason = (typeof SKIP_REASONS)[number]

/** A tier candidate that could not take the work, with the bounded reason. */
export interface SkippedCandidate {
  readonly ref: ModelRef
  readonly why: SkipReason
}

/** Bounded evidence attached to an `apply` decision. */
export interface ApplyEvidence {
  /** Candidates considered before the applied one, in order (bounded). */
  readonly skipped: readonly SkippedCandidate[]
  /** Breaker probe id when the applied unit is the half-open probe. */
  readonly probeId?: string | undefined
}

export interface ApplyDecision {
  readonly kind: "apply"
  readonly model: ModelRef
  /** Required tier; `undefined` for pin routing (a pin is not a tier). */
  readonly tier?: TierName | undefined
  readonly reason: ApplyReason
  readonly evidence: ApplyEvidence
}

export interface DeferDecision {
  readonly kind: "defer"
  readonly reason: SchedulerDeferReason
  readonly detail?: string | undefined
}

export interface ParkDecision {
  readonly kind: "park"
  readonly reason: ParkReason
  readonly detail?: string | undefined
}

/** Structured capability evidence for escalation (ADP-015). Never prose mining. */
export const ESCALATION_EVIDENCE_KINDS = [
  "agent-request",
  "reviewer-rejection",
  "verification-failure",
  "repeated-failure",
  "explicit-blocker",
] as const satisfies readonly string[]

export type EscalationEvidenceKind = (typeof ESCALATION_EVIDENCE_KINDS)[number]

export interface EscalationEvidence {
  readonly kind: EscalationEvidenceKind
  readonly detail?: string | undefined
}

export const ESCALATION_STEPS = ["variant", "tier"] as const satisfies readonly string[]

export type EscalationStep = (typeof ESCALATION_STEPS)[number]

/** Finite per-unit escalation budget (ADP-015). `used >= max` ends escalation. */
export interface EscalationBudget {
  readonly used: number
  readonly max: number
}

/** Bound on evidence carried by an `escalate` decision (latest wins). */
export const MAX_ESCALATION_EVIDENCE = 4

export interface EscalationInput {
  readonly currentModel: ModelRef
  readonly currentTier: TierName
  /**
   * Ordered variant ids for the current model, weakest → strongest, when the
   * host inventory exposes an order. Without a ladder the variant step is
   * skipped — strength is never guessed from variant names (ADP-004).
   */
  readonly variantLadder?: readonly string[] | undefined
  /** Configured resources of the next tier, user order, already gated. */
  readonly nextTierResources: readonly ModelRef[]
  /** Non-empty structured evidence justifies escalation. */
  readonly evidence: readonly EscalationEvidence[]
  readonly budget: EscalationBudget
}

export interface EscalateDecision {
  readonly kind: "escalate"
  readonly target: ModelRef
  readonly step: EscalationStep
  /** Tier of the target: unchanged for the variant step, next tier otherwise. */
  readonly tier: TierName
  readonly evidence: readonly EscalationEvidence[]
  readonly budgetRemaining: number
}

/** OBSERVE mode's wrapper: the identical decision, recorded but not applied. */
export interface ObserveOnlyDecision {
  readonly kind: "observe-only"
  readonly would: Decision
}

export type Decision =
  ApplyDecision | DeferDecision | ParkDecision | EscalateDecision | ObserveOnlyDecision

/** What admission can return — escalation never originates from admission. */
export type AdmissionDecision = ApplyDecision | DeferDecision | ParkDecision

/**
 * Everything admission looks at. `health` and `capacity` are keyed by
 * `schedulerHealthKey(ref)`; an absent health entry means "no observed
 * failure" (the registry's default), an absent capacity entry means "no
 * estimate" — unknown is never treated as exhausted.
 */
export interface SchedulerInput {
  readonly routing: RoutingDecision
  readonly demand: Demand
  /** Host inventory (adapter-normalized). Candidates absent here are unverifiable. */
  readonly inventory: readonly CandidateModel[]
  /** Configured resources of the required tier, in user order (ADP-005). */
  readonly tierCandidates: readonly ModelRef[]
  readonly health: Readonly<Record<string, Assessment>>
  readonly capacity: Readonly<Record<string, CapacitySignals>>
}

/** Bound on the `skipped` evidence list of an `apply` decision. */
export const MAX_EVIDENCE_SKIPPED = 8

/** Canonical health/capacity map key for a candidate model reference. */
export function schedulerHealthKey(ref: ModelRef): string {
  return resourceKeyID(
    ref.variant === undefined
      ? { providerID: ref.providerID, modelID: ref.id }
      : { providerID: ref.providerID, modelID: ref.id, variantID: ref.variant },
  )
}
