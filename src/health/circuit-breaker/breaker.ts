/**
 * Pure circuit breaker state machine (ADP-019).
 *
 * All functions are total, synchronous, and clock-free: `now` is always an
 * injected parameter. The single-probe guarantee comes from the admission
 * protocol: `admitProbe` synchronously transitions an open (and due) breaker
 * to half-open, so the second concurrent caller observes `half_open` and is
 * blocked — there is never an await between the state check and the
 * transition. Callers must persist the returned record immediately.
 */
import type { FailureCategory } from "../classifier/types.js"
import { BREAKER_EXEMPT_CATEGORIES, type BreakerConfig, type BreakerRecord } from "./types.js"

export function initialBreaker(): BreakerRecord {
  return { state: "closed", failures: 0, openCount: 0 }
}

/**
 * Backoff window for the `openCount`-th opening: doubling, capped at
 * `maxBackoffMs` so a persistently failing resource never waits longer than
 * the configured ceiling.
 */
function backoffMs(openCount: number, config: BreakerConfig): number {
  return Math.min(config.baseOpenMs * 2 ** (openCount - 1), config.maxBackoffMs)
}

function openBreaker(
  record: BreakerRecord,
  openCount: number,
  now: number,
  config: BreakerConfig,
): BreakerRecord {
  return {
    state: "open",
    failures: record.failures,
    openCount,
    reopenAt: now + backoffMs(openCount, config),
  }
}

export interface BreakerFailureResult {
  readonly record: BreakerRecord
  /** True exactly when this failure tripped the breaker from closed to open. */
  readonly opened: boolean
}

/**
 * Records a countable failure. Callers route only infrastructure failures
 * here (the resource-health transitions layer sends outage, overload, and
 * timeout); the breaker additionally exempts rate limiting and quota
 * exhaustion, which own their windowed resource states. Failures observed
 * while the breaker is not closed cannot happen through the admission
 * protocol (non-probe callers are blocked) and are ignored defensively.
 */
export function recordBreakerFailure(
  record: BreakerRecord,
  category: FailureCategory,
  now: number,
  config: BreakerConfig,
): BreakerFailureResult {
  if (BREAKER_EXEMPT_CATEGORIES.includes(category) || record.state !== "closed") {
    return { record, opened: false }
  }
  const failures = record.failures + 1
  if (failures < config.failureThreshold) {
    return { record: { ...record, failures }, opened: false }
  }
  return {
    record: openBreaker({ ...record, failures }, record.openCount + 1, now, config),
    opened: true,
  }
}

/**
 * Observed success closes the breaker and resets the failure/backoff state.
 * Evidence beats inference: a success is proof the resource works, from any
 * prior breaker state.
 */
export function recordBreakerSuccess(): BreakerRecord {
  return { state: "closed", failures: 0, openCount: 0 }
}

export type ProbeAdmission =
  | { kind: "closed"; record: BreakerRecord }
  | { kind: "waiting"; record: BreakerRecord; retryAtMs: number }
  | { kind: "in-flight"; record: BreakerRecord }
  | { kind: "admitted"; record: BreakerRecord }

/**
 * Attempts to admit the single half-open probe. Callers must persist the
 * returned record synchronously; the returned record carries no probeId — the
 * registry stamps its own ticket id on the persisted copy.
 */
export function admitProbe(record: BreakerRecord, now: number): ProbeAdmission {
  if (record.state === "closed") {
    return { kind: "closed", record }
  }
  if (record.state === "half_open") {
    return { kind: "in-flight", record }
  }
  const reopenAt = record.reopenAt
  if (reopenAt !== undefined && now < reopenAt) {
    return { kind: "waiting", record, retryAtMs: reopenAt - now }
  }
  return {
    kind: "admitted",
    record: { state: "half_open", failures: record.failures, openCount: record.openCount },
  }
}

/** Closes the breaker when a probe report confirms recovery. */
export function recordProbeSuccess(record: BreakerRecord): BreakerRecord {
  if (record.state !== "half_open") {
    return record
  }
  return { state: "closed", failures: 0, openCount: 0 }
}

/**
 * Records a failed probe. A non-exempt failure reopens the breaker with a
 * doubled backoff. An exempt failure (the probe was rate limited or quota
 * blocked) re-arms the same backoff window without escalation: the resource
 * was rejected for demand reasons, not degraded health, so doubling would
 * overstate the failure.
 */
export function recordProbeFailure(
  record: BreakerRecord,
  category: FailureCategory,
  now: number,
  config: BreakerConfig,
): BreakerRecord {
  if (record.state !== "half_open") {
    return record
  }
  if (BREAKER_EXEMPT_CATEGORIES.includes(category)) {
    return openBreaker(record, record.openCount, now, config)
  }
  return openBreaker(record, record.openCount + 1, now, config)
}
