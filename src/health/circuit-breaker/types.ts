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
  /**
   * How long a half-open probe may stay unreported before assessment treats
   * it as lost. Generous by design: a probe episode is a real work unit and
   * may run for minutes; the deadline only exists so a probe whose terminal
   * event never arrives cannot wedge the resource in half_open forever.
   */
  readonly probeTimeoutMs: number
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  baseOpenMs: 30_000,
  maxBackoffMs: 1_800_000,
  probeTimeoutMs: 600_000,
}

export const BREAKER_EXEMPT_CATEGORIES: readonly FailureCategory[] = [
  "rate_limited",
  "quota_exhausted",
  "user_cancelled",
]

/**
 * Persistent breaker record for one resource. `openCount` drives the doubling
 * backoff and resets only when the breaker closes (a probe or an observed
 * success). Rate limiting, quota exhaustion and user cancellation are
 * deliberately exempt from breaker counting: the first two own their own
 * windowed resource states (counting them would double-punish a resource
 * already known to need a cooldown), and a user-interrupted probe says
 * nothing about resource health, so an interrupted probe re-arms the same
 * window rather than doubling it. `probeId` identifies the single admitted
 * probe while half-open so stale or forged probe reports can be rejected;
 * `probeAt` records when it was admitted so a probe whose outcome report is
 * lost can expire instead of wedging the resource half-open forever.
 */
export interface BreakerRecord {
  readonly state: BreakerState
  readonly failures: number
  readonly openCount: number
  readonly reopenAt?: number | undefined
  readonly probeId?: string | undefined
  readonly probeAt?: number | undefined
}
