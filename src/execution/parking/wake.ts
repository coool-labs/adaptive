import { capacitySignals } from "../../health/capacity/merge.js"
import { DEFAULT_CAPACITY_CONFIG, type CapacityReading } from "../../health/capacity/types.js"
import type { ResourceRecord } from "../../health/resource-health/types.js"

/**
 * Parked-work wake planning (ADP-024): when every resource of a parked
 * unit's tier is blocked, nothing else is guaranteed to reach a safe
 * boundary again (`experimental.idle` only follows successful work), so the
 * supervisor arms one timer for the earliest moment a candidate resource
 * becomes usable. All times are epoch ms; `undefined` means "unknown" (no
 * stated reset — e.g. an auth quarantine or an in-flight probe).
 */

/** Wake slightly after the window ends so the resource is past its reset. */
export const WAKE_GRACE_MS = 1_000
/** Shortest wake delay: a due target never spins the timer. */
export const MIN_WAKE_MS = 1_000
/** Re-check cadence when no candidate states when it recovers. */
export const UNKNOWN_WAKE_MS = 5 * 60_000
/**
 * Longest single timer. Longer waits (weekly limits) re-arm in steps, which
 * also keeps the delay far below the 2^31 ms setTimeout overflow and
 * re-anchors the schedule after laptop sleep or wall-clock jumps.
 */
export const MAX_WAKE_MS = 30 * 60_000
/** First backoff step after a wake that resumed nothing; doubles per miss. */
export const FRUITLESS_BASE_MS = 5_000

/**
 * When one health record stops blocking admission: windowed states lift at
 * their window end, an open breaker at its reopen time. Unavailable (no
 * window, permanent until reset) and half-open (a probe decides) are unknown.
 */
function recordUsableAt(record: ResourceRecord, now: number): number | undefined {
  if (record.health === "unavailable" || record.breaker.state === "half_open") {
    return undefined
  }
  let at = now
  if (record.health === "quota_exhausted" || record.health === "rate_limited") {
    if (record.window === undefined) return undefined
    at = Math.max(at, record.window.until)
  }
  if (record.breaker.state === "open") {
    at = Math.max(at, record.breaker.reopenAt ?? now)
  }
  return at
}

/**
 * When a resource becomes usable: the latest of its health chain (a blocked
 * ancestor blocks every descendant) and its capacity estimate. An exhausted
 * estimate clears at its stated reset or when the reading goes stale,
 * whichever comes first — stale readings stop blocking admission.
 */
export function resourceUsableAt(
  chain: readonly (ResourceRecord | undefined)[],
  reading: CapacityReading | null,
  now: number,
): number | undefined {
  let at = now
  for (const record of chain) {
    if (record === undefined) continue
    const usable = recordUsableAt(record, now)
    if (usable === undefined) return undefined
    at = Math.max(at, usable)
  }
  if (reading !== null && capacitySignals(reading).exhausted) {
    const stale = reading.observedAt + DEFAULT_CAPACITY_CONFIG.maxAgeMs
    const reset = reading.resetAt ?? stale
    at = Math.max(at, Math.min(reset, stale))
  }
  return at
}

/** Earliest known time among candidates; unknown when none is known. */
export function earliestUsable(times: readonly (number | undefined)[]): number | undefined {
  let earliest: number | undefined
  for (const time of times) {
    if (time !== undefined && (earliest === undefined || time < earliest)) earliest = time
  }
  return earliest
}

export interface WakePlan {
  /** When the parked work is due for a resume sweep. */
  readonly dueAt: number
  /** Timer delay; shorter than `dueAt - now` when capped by MAX_WAKE_MS. */
  readonly delayMs: number
  /**
   * Whether the timer fires before `dueAt` by design (capped delay). An
   * uncapped fire is due even when the clock reads a little early: timers
   * and wall clocks drift, and a clock stepped back must not skip the sweep.
   */
  readonly capped: boolean
}

/**
 * Plans the next wake for the parked units' resume times. `fruitless` counts
 * consecutive wake sweeps that resumed nothing: each one doubles the minimum
 * delay (capped), so a resource that looks usable but keeps refusing work
 * cannot spin the timer. No targets → no wake.
 */
export function planWake(
  targets: readonly (number | undefined)[],
  now: number,
  fruitless: number,
): WakePlan | undefined {
  if (targets.length === 0) return undefined
  const known = earliestUsable(targets)
  let dueAt = known === undefined ? Number.POSITIVE_INFINITY : known + WAKE_GRACE_MS
  if (targets.includes(undefined)) dueAt = Math.min(dueAt, now + UNKNOWN_WAKE_MS)
  const floor =
    fruitless === 0 ? MIN_WAKE_MS : Math.min(MAX_WAKE_MS, FRUITLESS_BASE_MS * 2 ** (fruitless - 1))
  dueAt = Math.max(dueAt, now + floor)
  const capped = dueAt - now > MAX_WAKE_MS
  return { dueAt, delayMs: capped ? MAX_WAKE_MS : dueAt - now, capped }
}
