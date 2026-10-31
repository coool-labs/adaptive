import type { ContinuationAction, ContinuationPlanInput } from "./types.js"

/**
 * Partial-work safety planner (ADP-023). Total, deterministic, pure.
 *
 * - No owned recovery: OpenCode's native retry is the preferred recovery;
 *   Adaptive leaves it alone.
 * - Owned recovery and the in-session path is possible: continue the same
 *   session on the recovered candidate (settle → switch → resume).
 * - Owned recovery and the in-session path is impossible: start a clean
 *   continuation work unit from existing durable session state.
 */
export function planContinuation(input: ContinuationPlanInput): ContinuationAction {
  if (input.recovery.kind === "none") return { kind: "allow-native" }
  if (input.continuationPossible)
    return input.recovery.probeId === undefined
      ? { kind: "in-session", model: input.recovery.model }
      : { kind: "in-session", model: input.recovery.model, probeId: input.recovery.probeId }
  return { kind: "clean-continuation" }
}
