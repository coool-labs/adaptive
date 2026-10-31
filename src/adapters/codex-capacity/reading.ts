/**
 * Codex usage → `CapacityReading` conversion. The binding constraint is the
 * most-consumed window (ties read the primary window, deterministic). Ratios
 * are exact percent/100 fractions; the reset timestamp is anchored to when the
 * headers were observed, preferring the relative `reset-after-seconds` over
 * the absolute `reset-at` epoch-seconds field.
 *
 * Confidence grades telemetry completeness: a binding window with BOTH a
 * usage percentage and a validated reset field is `high` (self-consistent,
 * provider-generated, actionable for draining); a percentage alone is
 * `medium`. An usage snapshot with no window at all yields a no-measurement
 * reading that the capacity merge layer discards as pure noise.
 */
import type { Confidence } from "../../health/capacity/types.js"
import type { CapacityReading } from "../../health/capacity/types.js"
import type { CodexUsage, CodexWindow } from "./types.js"

export const CODEX_EVIDENCE = "x-codex headers"

function hasReset(window: CodexWindow): boolean {
  return window.resetAfterSeconds !== undefined || window.resetAtSeconds !== undefined
}

/**
 * The window whose exhaustion binds first: higher usage wins, ties → primary.
 * Returns `undefined` only for a snapshot with no window at all.
 */
export function bindingWindow(usage: CodexUsage): CodexWindow | undefined {
  const primary = usage.primary
  const secondary = usage.secondary
  if (primary === undefined) {
    return secondary
  }
  if (secondary === undefined) {
    return primary
  }
  return secondary.usedPercent > primary.usedPercent ? secondary : primary
}

export function readingFromUsage(usage: CodexUsage, observedAt: number): CapacityReading {
  const window = bindingWindow(usage)
  if (window === undefined) {
    // No measured field — the capacity merge layer rejects this as noise.
    return { confidence: "low", observedAt, evidence: CODEX_EVIDENCE }
  }
  const usedRatio = window.usedPercent / 100
  const remainingRatio = 1 - usedRatio
  let resetAt: number | undefined
  if (window.resetAfterSeconds !== undefined) {
    resetAt = observedAt + window.resetAfterSeconds * 1000
  } else if (window.resetAtSeconds !== undefined) {
    resetAt = window.resetAtSeconds * 1000
  }
  const confidence: Confidence = hasReset(window) ? "high" : "medium"
  return {
    usedRatio,
    remainingRatio,
    ...(resetAt !== undefined ? { resetAt } : {}),
    confidence,
    observedAt,
    evidence: CODEX_EVIDENCE,
  }
}
