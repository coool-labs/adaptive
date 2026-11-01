import { MAX_VETOES_PER_UNIT } from "./types.js"
import { sameModelRef } from "../../core/work-unit/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import type {
  NativeRetryDecision,
  RecoveryOption,
  RetryCoreDecision,
  RetryInput,
  RetryDecision,
} from "./types.js"

/**
 * Retry-hook policy (ADP-013/014). Total, deterministic, side-effect free.
 *
 * Veto (take ownership of horizontal recovery) only when ALL hold:
 * - the classification is failover-eligible (infrastructure failure —
 *   capability problems and host decisions never veto);
 * - the evidence is definitive — ambiguous evidence (Retry-After headers
 *   alone, bounded-textual matches) conservatively leaves OpenCode's native
 *   retry, which the host schedules with its parsed `retryAfterMs` (ADP-012);
 * - a same-tier recovery candidate exists AND differs from the resource that
 *   just failed — without one, the native retry of the same resource IS the
 *   preferred horizontal recovery (vetoing onto the failed resource would
 *   discard the host's backoff and re-prompt it immediately). A breaker-probe
 *   recovery is exempt: its target IS the failed resource by design, and the
 *   veto is what starts the probe episode;
 * - the host still wants to retry (`retry: true`) — an already-vetoed or
 *   exhausted lifecycle is never resurrected; recovery defers to the next
 *   safe boundary (ADP-014, ADP-023);
 * - the per-unit veto budget has room left.
 */
export function decideRetry(input: RetryInput): RetryCoreDecision {
  if (!input.classification.failoverEligible) {
    return { kind: "leave" }
  }
  if (!input.classification.definitive) {
    return { kind: "leave" }
  }
  const recovery: RecoveryOption = input.recovery
  if (recovery.kind === "none") {
    return { kind: "leave" }
  }
  // A probe recovery targets the very resource that just failed (the
  // half-open probe re-admits it); the veto is what starts the probe episode,
  // so the same-resource exemption below must not swallow it.
  // The host reports base-model calls with variant "default" (verified on
  // 2.2.5, same fact refKey normalizes in the supervisor), so the sameness
  // check must not treat that spelling as a different resource.
  const sameResource =
    recovery.probeId === undefined &&
    sameModelRef(
      {
        ...recovery.model,
        variant: recovery.model.variant === "default" ? undefined : recovery.model.variant,
      },
      {
        ...input.failingModel,
        variant: input.failingModel.variant === "default" ? undefined : input.failingModel.variant,
      },
    )
  if (sameResource) {
    return { kind: "leave" }
  }
  const native: NativeRetryDecision = input.native
  if (!native.retry) {
    return { kind: "leave" }
  }
  if (input.vetoesUsed >= MAX_VETOES_PER_UNIT) {
    return { kind: "leave" }
  }
  const { model, probeId } = recovery
  return probeId === undefined ? { kind: "veto", model } : { kind: "veto", model, probeId }
}

/**
 * Mode wrapper — the same core decision for Observe and Control; Observe
 * wraps it for receipt recording without intervening; OFF never touches
 * execution (the hook is not even registered, this keeps the union closed).
 */
export function forMode(decision: RetryCoreDecision, mode: OperatingMode): RetryDecision {
  switch (mode) {
    case "active":
      return decision
    case "observe":
      return { kind: "observe-only", would: decision }
    case "off":
      return { kind: "leave" }
  }
}
