import type { ModelRef } from "../../core/work-unit/types.js"
import type { FailureClassification } from "../../health/classifier/types.js"

/**
 * Mirror of the host retry-hook decision shape (`SessionRetryDecision` from
 * `@opencode/plugin`). The execution core never imports the plugin package —
 * the adapter passes `hook.decision` straight through; the shapes are
 * structurally identical.
 */
export type NativeRetryDecision = { retry: false } | { retry: true; delay: number }

/**
 * Horizontal-recovery option computed by the wiring for the failing work
 * unit, from the same tier (ADP-013). `none` means no healthy alternative
 * exists right now — OpenCode's native retry of the same resource is then
 * the preferred recovery. `switch` carries the candidate chosen by the
 * scheduler over the remaining tier candidates; `probeId` is present when
 * that candidate was admitted as a circuit-breaker probe.
 */
export type RecoveryOption =
  { kind: "none" } | { kind: "switch"; model: ModelRef; probeId?: string | undefined }

export interface RetryInput {
  /** Classification of the failure that triggered the retry hook. */
  readonly classification: FailureClassification
  /** The resource whose execution just failed. */
  readonly failingModel: ModelRef
  /** The host's own retry decision; left untouched unless we veto. */
  readonly native: NativeRetryDecision
  readonly recovery: RecoveryOption
  /** Vetoes already issued for this work unit (per-unit budget). */
  readonly vetoesUsed: number
}

/**
 * Per-work-unit budget on owned-recovery vetoes. Each veto switches to one
 * alternative; health state already blocks repeats, but the explicit budget
 * makes loop boundedness trivially provable (ADP-038). After exhaustion the
 * policy leaves OpenCode's native retry — its built-in max attempts are the
 * hard limit — and future units re-route fresh at safe boundaries.
 */
export const MAX_VETOES_PER_UNIT = 4

/**
 * Core decision, mode-independent. `veto` takes ownership of recovery
 * (`{retry: false}` in the hook + a native continuation by switching to the
 * recovered candidate); `leave` keeps the host's own `decision` untouched.
 */
export type RetryCoreDecision =
  { kind: "veto"; model: ModelRef; probeId?: string | undefined } | { kind: "leave" }

/** Mode-wrapped decision. Observe records `would` without intervening. */
export type RetryDecision = RetryCoreDecision | { kind: "observe-only"; would: RetryCoreDecision }
