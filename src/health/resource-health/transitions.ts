/**
 * Pure resource health transitions (ADP-007, ADP-012, ADP-019, ADP-021).
 *
 * `applyHealthEvent` is the single authority for how evidence changes a
 * resource record: total, synchronous, and clock-free (`now` is injected).
 *
 * Policy notes:
 * - Rate limiting and quota exhaustion set their own windowed states;
 *   a windowed state is never downgraded by weaker evidence (a 429 while
 *   quota-exhausted does not erase the quota signal).
 * - Outage, overload, and timeout count toward the circuit breaker and mark
 *   the resource degraded. They never hard-quarantine on their own: a single
 *   definitive outage signal can be a blip, so the breaker owns transient
 *   failure quarantine with backoff windows and probe recovery.
 * - The `definitive` flag is scheduling evidence (deference, ADP-012), not a
 *   health input: health states track what is known about the resource, and
 *   both definitive and non-definitive infra failures leave it degraded.
 * - Ambiguous or request-level failures (context overflow, content policy,
 *   user cancellation, unknown) never change health: they say nothing about
 *   the resource.
 * - Draining is a policy request (ADP-021), not degraded health: it applies
 *   on top of healthy/degraded and never masks a harder state.
 */
import {
  recordBreakerFailure,
  recordBreakerSuccess,
  initialBreaker,
} from "../circuit-breaker/breaker.js"
import type { BreakerRecord } from "../circuit-breaker/types.js"
import { resourceScope } from "./key.js"
import type { HealthEvent, ResourceHealthConfig, ResourceKey, ResourceRecord } from "./types.js"

export function initialRecord(key: ResourceKey, now: number): ResourceRecord {
  return { key, health: "healthy", breaker: initialBreaker(), updatedAt: now }
}

/**
 * Elapses time-bounded windows: once a window's `until` passes, the windowed
 * state (rate limited, quota exhausted with a known reset) lifts back to
 * healthy. Records without a window, or with one still in the future, pass
 * through unchanged.
 */
export function sweepRecord(record: ResourceRecord, now: number): ResourceRecord {
  const window = record.window
  if (window === undefined || now < window.until) {
    return record
  }
  return { key: record.key, health: "healthy", breaker: record.breaker, updatedAt: now }
}

function touched(record: ResourceRecord, now: number): ResourceRecord {
  return { ...record, updatedAt: now }
}

/**
 * Defensive re-validation of a parsed retry delay: the classifier already
 * rejects malformed values, but the health layer never trusts a negative or
 * fractional delay to compute a window.
 */
function validRetryAfterMs(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
}

function failureEvent(
  record: ResourceRecord,
  event: Extract<HealthEvent, { kind: "failure" }>,
  now: number,
  config: ResourceHealthConfig,
): ResourceRecord {
  switch (event.category) {
    case "rate_limited": {
      if (record.health === "quota_exhausted" || record.health === "unavailable") {
        return touched(record, now)
      }
      const retryAfterMs = validRetryAfterMs(event.retryAfterMs)
      const until = now + (retryAfterMs ?? config.defaultRateLimitWindowMs)
      return {
        ...record,
        health: "rate_limited",
        window: { kind: "rate-limit", until },
        updatedAt: now,
      }
    }
    case "quota_exhausted": {
      if (record.health === "unavailable") {
        return touched(record, now)
      }
      const retryAfterMs = validRetryAfterMs(event.retryAfterMs)
      return {
        ...record,
        health: "quota_exhausted",
        window:
          retryAfterMs === undefined ? undefined : { kind: "quota", until: now + retryAfterMs },
        updatedAt: now,
      }
    }
    case "outage":
    case "overload":
    case "timeout": {
      const breaker = recordBreakerFailure(record.breaker, event.category, now, config.breaker)
      const health =
        record.health === "healthy" || record.health === "draining" ? "degraded" : record.health
      return { ...record, health, breaker: breaker.record, updatedAt: now }
    }
    case "auth_failure":
      return { ...record, health: "unavailable", updatedAt: now }
    case "invalid_model": {
      // An invalid model says nothing about the provider or account; only
      // model-scoped and variant-scoped keys may be quarantined by it.
      const scope = resourceScope(record.key)
      if (scope !== "model" && scope !== "variant") {
        return touched(record, now)
      }
      return { ...record, health: "unavailable", updatedAt: now }
    }
    default:
      // context_overflow, content_policy, user_cancelled, unknown:
      // request-level evidence, not resource health.
      return touched(record, now)
  }
}

export function applyHealthEvent(
  record: ResourceRecord,
  event: HealthEvent,
  now: number,
  config: ResourceHealthConfig,
): ResourceRecord {
  switch (event.kind) {
    case "failure":
      return failureEvent(record, event, now, config)
    case "success": {
      const breaker: BreakerRecord = recordBreakerSuccess()
      const health =
        record.health === "draining" || record.health === "quota_exhausted"
          ? record.health
          : "healthy"
      return {
        ...record,
        health,
        breaker,
        window: health === record.health ? record.window : undefined,
        updatedAt: now,
      }
    }
    case "drain": {
      const health =
        record.health === "healthy" || record.health === "degraded" ? "draining" : record.health
      return { ...record, health, updatedAt: now }
    }
    case "capacity": {
      if (event.exhausted) {
        if (record.health === "unavailable") {
          return touched(record, now)
        }
        const retryAfterMs = validRetryAfterMs(event.retryAfterMs)
        return {
          ...record,
          health: "quota_exhausted",
          window:
            retryAfterMs === undefined ? undefined : { kind: "quota", until: now + retryAfterMs },
          updatedAt: now,
        }
      }
      const health = record.health === "quota_exhausted" ? "healthy" : record.health
      return {
        ...record,
        health,
        window: health === record.health ? record.window : undefined,
        updatedAt: now,
      }
    }
    case "reset":
      return { key: record.key, health: "healthy", breaker: initialBreaker(), updatedAt: now }
  }
}
