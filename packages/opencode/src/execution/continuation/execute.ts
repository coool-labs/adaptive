import { CONTINUATION_PROMPT } from "./prompts.js"
import type { ContinuationOutcome } from "./types.js"
import type { ContinuationExecuteInput } from "./types.js"

/**
 * Executes a planned continuation through the narrow ops seam, enforcing
 * the partial-work invariants in one place (ADP-014/ADP-023):
 *
 * 1. Every owned path settles the session FIRST — Adaptive never switches
 *    or prompts while a failed execution is still settling.
 * 2. The delivered prompt is always the fixed continuation prompt over the
 *    existing session/workspace state — the original instruction is never
 *    re-sent, so the never-replay invariant holds by construction.
 * 3. `allow-native` performs no host operations at all.
 *
 * Ops failures propagate to the caller (the wiring's fail-open wrapper
 * decides degradation); the ordering guarantee holds up to the first
 * failure because each step awaits the previous one.
 */
export async function executeContinuation(
  input: ContinuationExecuteInput,
): Promise<ContinuationOutcome> {
  const { action, ops, sessionID } = input
  if (action.kind === "allow-native") return { kind: "left-native" }
  if (action.kind === "in-session") {
    await ops.settle(sessionID)
    await ops.switchModel(sessionID, action.model)
    await ops.prompt(sessionID, CONTINUATION_PROMPT)
    return { kind: "resumed" }
  }
  await ops.settle(sessionID)
  await ops.prompt(sessionID, CONTINUATION_PROMPT)
  return { kind: "continuation-started" }
}
