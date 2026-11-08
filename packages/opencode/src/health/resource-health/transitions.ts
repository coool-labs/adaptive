/**
 * Pure resource health transitions (ADP-007, ADP-012, ADP-019, ADP-021).
 *
 * `applyHealthEvent` is the single authority for how evidence changes a
 * resource record: total, synchronous, and clock-free (`now` is injected).
 *
 * Policy notes:
 * - Rate limiting and quota exhaustion set their own windowed states, always
 *   bounded (a default window when the evidence names no reset);
 *   a windowed state is never downgraded by weaker evidence (a 429 while
 *   quota-exhausted does not erase the quota signal).
 * - Outage, overload, and timeout count toward the circuit breaker and mark
 *   the resource degraded. They never hard-quarantine on their own: a single
 *   definitive outage signal can be a blip, so the breaker owns transient
 *   failure quarantine with backoff windows and probe recovery.
 * - Definitive configuration failures (auth, invalid model) hard-quarantine
 *   the resource: the evidence proves the resource cannot work. Non-definitive
 *   evidence of the same categories (the textual last resort, ADP-008) is
 *   transient and breaker-owned instead — one fuzzy substring in an error
 *   body must never permanently blacklist a resource with no recovery path
 *   (ADP-012).
 * - The `definitive` flag otherwise guides scheduling deference, not health:
 *   both definitive and non-definitive infra failures leave the resource
 *   degraded.
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
 * state (rate limited, quota exhausted) lifts back to healthy. Records
 * without a window, or with one still in the future, pass through unchanged.
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

function quotaExhausted(
  record: ResourceRecord,
  retryAfterMs: number | undefined,
  now: number,
  config: ResourceHealthConfig,
): ResourceRecord {
  const until = now + (validRetryAfterMs(retryAfterMs) ?? config.defaultQuotaWindowMs)
  return { ...record, health: "quota_exhausted", window: { kind: "quota", until }, updatedAt: now }
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
      return quotaExhausted(record, event.retryAfterMs, now, config)
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
    case "invalid_model": {
      // An invalid model says nothing about the provider or account; only
      // model-scoped and variant-scoped keys may be quarantined by it.
      if (event.category === "invalid_model") {
        const scope = resourceScope(record.key)
        if (scope !== "model" && scope !== "variant") {
          return touched(record, now)
        }
      }
      if (!event.definitive) {
        // Non-definitive evidence (bounded-textual last resort) is not proof
        // the resource cannot work: quarantine through the breaker's bounded
        // failure counting instead of a windowless, unrecoverable state.
        const breaker = recordBreakerFailure(record.breaker, event.category, now, config.breaker)
        const health =
          record.health === "healthy" || record.health === "draining" ? "degraded" : record.health
        return { ...record, health, breaker: breaker.record, updatedAt: now }
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
        return quotaExhausted(record, event.retryAfterMs, now, config)
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
