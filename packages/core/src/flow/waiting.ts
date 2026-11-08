import type { StatusSnapshot } from "../status.js"

/** How often a view re-reads parked sessions: wakes land at second granularity, a few seconds' lag is fine. */
export const WAITING_POLL_MS = 10_000

const DAY_MS = 24 * 60 * 60_000
const WEEK_DAYS = 6

/** Parked sessions by id, mapped to when their tier is next expected to be usable (null = unknown). */
export function waitingSessions(snapshot: StatusSnapshot): Record<string, number | null> {
  const sessions: Record<string, number | null> = {}
  for (const entry of snapshot.waiting) sessions[entry.sessionID] = entry.resumeAt
  return sessions
}

function startOfDay(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/**
 * Short human text for a parked session (ADP-024): "waiting · resumes 18:42". Weekly limits reset days away, so
 * a later day gains its weekday, and beyond a week its date. Local fields, not the locale formatter, keep the
 * text identical across hosts.
 */
export function waitingLabel(resumeAt: number | null, now: number): string {
  if (resumeAt === null) return "waiting"
  if (resumeAt <= now) return "waiting · resuming"
  const date = new Date(resumeAt)
  // Calendar days, not elapsed time: 01:00 tomorrow is "Sun 01:00" even when it is only two hours away.
  const days = Math.round((startOfDay(resumeAt) - startOfDay(now)) / DAY_MS)
  if (days === 0) return `waiting · resumes ${clock(date)}`
  // toDateString is spec-fixed ("Sat Nov 07 2026"), unlike toLocaleString.
  const day = date.toDateString()
  if (days <= WEEK_DAYS) return `waiting · resumes ${day.slice(0, 3)} ${clock(date)}`
  return `waiting · resumes ${day.slice(4, 7)} ${String(date.getDate())} ${clock(date)}`
}
