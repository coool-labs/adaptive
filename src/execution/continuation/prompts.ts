/**
 * Continuation prompt for owned recovery and parked-work resume (ADP-023).
 * Continues from session state; never replays the original instruction once
 * tool side effects may exist. The executor sends exactly this prompt — the
 * never-replay invariant is structural, not a caller responsibility.
 */
export const CONTINUATION_PROMPT =
  "Continue the interrupted work from the current session state. Do not repeat completed work; resume from what the session already produced."
