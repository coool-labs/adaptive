import type { ModelRef } from "../../routing/work-unit/types.js"
import type { RecoveryOption } from "../retry/types.js"

/**
 * What Adaptive does for a failed work unit's recovery (ADP-013/ADP-014).
 * - `allow-native`: Adaptive did not take ownership (no veto) — OpenCode's
 *   native retry lifecycle is the preferred recovery and stays untouched.
 * - `in-session`: Adaptive vetoed native retry and continues the same
 *   session on a recovered candidate (settle → switch → resume).
 * - `clean-continuation`: the in-session path is not possible; start a
 *   clean continuation work unit from existing durable session state.
 *
 * The union has no "replay" variant by construction: every owned path
 * continues from session state, so "Adaptive replays the original
 * instruction after side effects" is unrepresentable, not merely avoided.
 */
export const CONTINUATION_ACTIONS = ["allow-native", "in-session", "clean-continuation"] as const
export type ContinuationActionKind = (typeof CONTINUATION_ACTIONS)[number]

export type ContinuationAction =
  | { kind: "allow-native" }
  | { kind: "in-session"; model: ModelRef }
  | { kind: "clean-continuation" }

export interface ContinuationPlanInput {
  /**
   * Recovery option computed by the wiring for the failing unit: `none`
   * means Adaptive did not veto (OpenCode's native retry is the preferred
   * recovery); `switch` means Adaptive vetoed and owns the recovery.
   */
  readonly recovery: RecoveryOption
  /**
   * True when the in-session owned path is possible (session alive, settle
   * + switch + resume available). Only consulted for `switch` recovery.
   */
  readonly continuationPossible: boolean
}

/**
 * Narrow seam over the host session operations the owned continuation
 * needs. Implemented by the OpenCode adapter (which tags its own model
 * switches for attribution before calling the host); tests use fakes that
 * record call order. Never imports `@opencode/plugin`.
 */
export interface ContinuationOps {
  /**
   * Wait until the session's failed execution has settled. Every owned
   * path settles first — Adaptive never switches or prompts while a failed
   * execution is still settling.
   */
  settle(sessionID: string): Promise<void>
  /** Switch the session's model (own-switch attribution handled by the adapter). */
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  /** Deliver a prompt to the session; starts/continues execution. */
  prompt(sessionID: string, text: string): Promise<void>
}

export interface ContinuationExecuteInput {
  readonly sessionID: string
  readonly action: ContinuationAction
  readonly ops: ContinuationOps
}

export type ContinuationOutcome =
  { kind: "left-native" } | { kind: "resumed" } | { kind: "continuation-started" }
