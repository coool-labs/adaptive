/**
 * Admission routing (ADP-013/016/022): pick the model for a fresh work unit,
 * or decide to defer (OpenCode's choice stands) or park (wait for recovery).
 *
 * Selection order, after the compatibility gate (ADP-017) filters candidates:
 * ready → probe → draining. Rationale: a half-open breaker candidate is one
 * single-flight admission away from verified recovery; a draining resource is
 * being retired, so depending on it is the last resort. Breaker single-flight
 * is enforced by the resource-health registry, not here.
 */
import { checkCompatibility } from "../compatibility/gate.js"
import type { CandidateModel } from "../compatibility/types.js"
import type { RoutingDecision, TierName } from "../tier-policy/types.js"
import { sameModelRef, type ModelRef } from "../work-unit/types.js"
import type { Assessment } from "../../health/resource-health/types.js"
import type { CapacitySignals } from "../../health/capacity/types.js"
import type {
  AdmissionDecision,
  ApplyDecision,
  ApplyReason,
  SchedulerInput,
  SkippedCandidate,
  SkipReason,
} from "./types.js"
import { MAX_EVIDENCE_SKIPPED, schedulerHealthKey } from "./types.js"

/** The health/capacity view of one candidate, resolved to an admission bucket. */
type Bucket =
  | { readonly kind: "ready" }
  | { readonly kind: "probe"; readonly probeId: string }
  | { readonly kind: "draining" }
  | { readonly kind: "skip"; readonly why: SkipReason }

function refOfCandidate(candidate: CandidateModel): ModelRef {
  return {
    providerID: candidate.providerID,
    id: candidate.modelID,
    variant: candidate.variant,
  }
}

function lookup(inventory: readonly CandidateModel[], ref: ModelRef): CandidateModel | undefined {
  return inventory.find((candidate) => sameModelRef(refOfCandidate(candidate), ref))
}

function classify(
  assessment: Assessment | undefined,
  signals: CapacitySignals | undefined,
): Bucket {
  if (signals?.exhausted === true) {
    return { kind: "skip", why: "capacity-exhausted" }
  }
  if (assessment === undefined) {
    return signals?.draining === true ? { kind: "draining" } : { kind: "ready" }
  }
  if (assessment.kind === "probe") {
    return { kind: "probe", probeId: assessment.ticket.id }
  }
  if (assessment.kind === "available") {
    return signals?.draining === true ? { kind: "draining" } : { kind: "ready" }
  }
  return assessment.reason === "draining"
    ? { kind: "draining" }
    : { kind: "skip", why: assessment.reason }
}

function apply(
  model: ModelRef,
  tier: TierName | undefined,
  reason: ApplyReason,
  skipped: readonly SkippedCandidate[],
  probeId: string | undefined,
): ApplyDecision {
  return {
    kind: "apply",
    model,
    ...(tier === undefined ? {} : { tier }),
    reason,
    evidence: {
      skipped: skipped.slice(0, MAX_EVIDENCE_SKIPPED),
      ...(probeId === undefined ? {} : { probeId }),
    },
  }
}

function admitPin(input: SchedulerInput, pin: ModelRef): AdmissionDecision {
  const entry = lookup(input.inventory, pin)
  if (entry === undefined) {
    return { kind: "defer", reason: "pin-unverifiable" }
  }
  const verdict = checkCompatibility(entry, input.demand)
  if (!verdict.compatible) {
    return { kind: "defer", reason: "pin-incompatible", detail: verdict.reasons.join(",") }
  }
  const key = schedulerHealthKey(pin)
  const bucket = classify(input.health[key], input.capacity[key])
  if (bucket.kind === "skip") {
    return { kind: "park", reason: "pin-blocked", detail: bucket.why }
  }
  // Manual intent wins (GOAL): a pinned model is applied even while draining;
  // a probe admission is recorded for observability but never overrides intent.
  return apply(pin, undefined, "pin", [], bucket.kind === "probe" ? bucket.probeId : undefined)
}

function admitTier(input: SchedulerInput, tier: TierName): AdmissionDecision {
  if (input.tierCandidates.length === 0) {
    // The tier was reported configured but has an empty list — a configuration
    // discrepancy; park rather than invent resources (ADP-005).
    return { kind: "park", reason: "no-candidates" }
  }
  const seen: { ref: ModelRef; bucket: Bucket }[] = []
  let gateSkipped = 0
  const skipWhys: string[] = []
  let readyRef: ModelRef | undefined
  for (const ref of input.tierCandidates) {
    const entry = lookup(input.inventory, ref)
    if (entry === undefined) {
      seen.push({ ref, bucket: { kind: "skip", why: "not-in-inventory" } })
      skipWhys.push("not-in-inventory")
      gateSkipped += 1
      continue
    }
    const verdict = checkCompatibility(entry, input.demand)
    if (!verdict.compatible) {
      // The gate reports incompatible only when at least one reason exists; the
      // non-null assertion is the only way to express that invariant locally.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const why = verdict.reasons[0]!
      seen.push({ ref, bucket: { kind: "skip", why } })
      skipWhys.push(why)
      gateSkipped += 1
      continue
    }
    const key = schedulerHealthKey(ref)
    const bucket = classify(input.health[key], input.capacity[key])
    if (bucket.kind === "ready") {
      // First ready candidate wins; later candidates are irrelevant, so the
      // scan stops and the evidence stays an honest prefix of the user order.
      readyRef = ref
      break
    }
    seen.push({ ref, bucket })
    if (bucket.kind === "skip") {
      skipWhys.push(bucket.why)
    }
  }
  const first = input.tierCandidates[0]
  const evidenceBefore = (until: number): SkippedCandidate[] =>
    seen.slice(0, until).map((e): SkippedCandidate => {
      if (e.bucket.kind === "skip") return { ref: e.ref, why: e.bucket.why }
      return { ref: e.ref, why: e.bucket.kind === "draining" ? "draining" : "probe-in-flight" }
    })
  if (readyRef !== undefined) {
    return apply(
      readyRef,
      tier,
      first !== undefined && sameModelRef(readyRef, first) ? "preferred" : "fallback",
      evidenceBefore(seen.length),
      undefined,
    )
  }
  const probeIndex = seen.findIndex((e) => e.bucket.kind === "probe")
  const probeEntry = probeIndex >= 0 ? seen[probeIndex] : undefined
  if (probeEntry?.bucket.kind === "probe") {
    return apply(
      probeEntry.ref,
      tier,
      "probe",
      evidenceBefore(probeIndex),
      probeEntry.bucket.probeId,
    )
  }
  const drainIndex = seen.findIndex((e) => e.bucket.kind === "draining")
  const drainEntry = drainIndex >= 0 ? seen[drainIndex] : undefined
  if (drainEntry !== undefined) {
    return apply(drainEntry.ref, tier, "draining", evidenceBefore(drainIndex), undefined)
  }
  const summary = skipWhys.slice(0, 3).join(",")
  return {
    kind: "park",
    reason: gateSkipped === skipWhys.length ? "no-compatible-resource" : "all-blocked",
    detail: summary,
  }
}

/**
 * Decide the model for a fresh work unit. Total and deterministic: the same
 * input always yields the same decision, and the function has no effects.
 */
export function admit(input: SchedulerInput): AdmissionDecision {
  const routing: RoutingDecision = input.routing
  if (routing.kind === "defer") {
    return { kind: "defer", reason: "routing-defer", detail: routing.reason }
  }
  if (routing.kind === "pin") {
    return admitPin(input, routing.model)
  }
  return admitTier(input, routing.tier)
}
