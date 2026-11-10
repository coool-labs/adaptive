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
 * switch). Every other pause reason is a deliberate stop (user pause, user
 * stop, reviewer stall, round limit, server restart) that Adaptive must
 * never override.
 */
const SESSION_FAILED_PREFIX = "The session failed: "

/** Whether a goal in this state may be brought back by an owned continuation. */
export function shouldResumeGoal(snapshot: GoalSnapshot | null | undefined): boolean {
  if (snapshot === undefined || snapshot === null) return false
  return (
    snapshot.status === "paused" && (snapshot.reason?.startsWith(SESSION_FAILED_PREFIX) ?? false)
  )
}
