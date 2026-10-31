/**
 * Circuit breaker types (ADP-019).
 *
 * The breaker is the quarantine mechanism for transient infrastructure
 * failures (outage, overload, timeout): repeated failures open the resource
 * for a backoff window, after which exactly one probe request is admitted
 * (half-open state). Rate limiting and quota exhaustion are deliberately
 * exempt from breaker counting because they already have their own windowed
 * resource states; counting them here would double-punish a resource that is
 * already known to need a cooldown.
 */
import type { FailureCategory } from "../classifier/types.js"

export const BREAKER_STATES = ["closed", "open", "half_open"] as const satisfies readonly string[]

export type BreakerState = (typeof BREAKER_STATES)[number]

export interface BreakerConfig {
  /** Consecutive countable failures in the closed state that trip the breaker. */
  readonly failureThreshold: number
  /** Backoff for the first opening; doubles on each reopening, capped below. */
  readonly baseOpenMs: number
  /** Upper bound for the backoff window. */
  readonly maxBackoffMs: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  baseOpenMs: 30_000,
  maxBackoffMs: 1_800_000,
}

export const BREAKER_EXEMPT_CATEGORIES: readonly FailureCategory[] = [
  "rate_limited",
  "quota_exhausted",
]

/**
 * Persistent breaker record for one resource. `openCount` drives the doubling
 * backoff and resets only when the breaker closes (a probe or an observed
 * success). `probeId` identifies the single admitted probe while half-open so
 * stale or forged probe reports can be rejected.
 */
export interface BreakerRecord {
  readonly state: BreakerState
  readonly failures: number
  readonly openCount: number
  readonly reopenAt?: number | undefined
  readonly probeId?: string | undefined
}
