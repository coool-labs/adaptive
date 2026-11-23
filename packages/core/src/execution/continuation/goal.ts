/**
 * Host goal snapshots the supervisor reads (structural mirror; the adapter
 * converts the host's goal payload).
 */
export interface GoalSnapshot {
  readonly status: string
  readonly reason?: string | undefined
}

/**
 * The host goal engine pauses with this prefix when the session's execution
 * failed — exactly the failure Adaptive recovers from (limit hit, model
 * switch).
 */
const SESSION_FAILED_PREFIX = "The session failed: "

/**
 * The host goal engine's stall detector pauses the goal when the session
 * produced no message while it waited on background work (subagents, jobs).
 * The host writes the count itself, so this is machine-generated like the
 * session-failure pause — not a user pause, and the work being waited on is
 * still there for a continuation to resume. Other pause reasons (user pause,
 * user stop, reviewer stall, round limit, server restart) are deliberate and
 * Adaptive never overrides them.
 */
const STALLED_ON_BACKGROUND_WORK =
  /^Nothing ran for \d+ minutes? while the goal waited on background work$/

/** Whether a goal in this state may be brought back by an owned continuation. */
export function shouldResumeGoal(snapshot: GoalSnapshot | null | undefined): boolean {
  if (snapshot === undefined || snapshot === null) return false
  if (snapshot.status !== "paused") return false
  const reason = snapshot.reason
  if (reason === undefined) return false
  return reason.startsWith(SESSION_FAILED_PREFIX) || STALLED_ON_BACKGROUND_WORK.test(reason)
}
