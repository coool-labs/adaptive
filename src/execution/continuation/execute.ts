import type { ContinuationOutcome } from "./types.js"
import type { ContinuationExecuteInput } from "./types.js"

/**
 * Executes a planned continuation through the narrow ops seam, enforcing
 * the partial-work invariants in one place (ADP-014/ADP-023):
 *
 * 1. Every owned path settles the session FIRST — Adaptive never switches
 *    or prompts while a failed execution is still settling.
 * 2. The prompt is chosen by the side-effect ledger: with side effects the
 *    original instruction is never sent — only the continuation prompt
 *    over existing state. Without side effects the original may be
 *    re-dispatched (nothing to duplicate).
 * 3. `allow-native` performs no host operations at all.
 *
 * Ops failures propagate to the caller (the wiring's fail-open wrapper
 * decides degradation); the ordering guarantee holds up to the first
 * failure because each step awaits the previous one.
 */
export async function executeContinuation(
  input: ContinuationExecuteInput,
): Promise<ContinuationOutcome> {
  const { action, sideEffects, prompts, ops, sessionID } = input
  if (action.kind === "allow-native") return { kind: "left-native" }
  const text = sideEffects ? prompts.continuation : prompts.original
  if (action.kind === "in-session") {
    await ops.settle(sessionID)
    await ops.switchModel(sessionID, action.model)
    await ops.prompt(sessionID, text)
    return { kind: "resumed" }
  }
  await ops.settle(sessionID)
  await ops.prompt(sessionID, text)
  return { kind: "continuation-started" }
}
