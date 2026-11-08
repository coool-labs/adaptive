/**
 * Deterministic capacity merge semantics (ADP-020).
 *
 * Several sensors may observe the same resource (e.g. passive headers and an
 * optional quota endpoint). The merge picks one coherent story instead of
 * synthesizing chimera numbers: readings are prioritized by confidence, then
 * by conservativeness (lower remaining ratio first), then by input order, and
 * each measured field is taken from the first reading in priority order that
 * supplies it. Trust is reduced, never amplified:
 *
 * - the merged confidence is the LOWEST confidence among all surviving fresh
 *   readings, because any concurrent contradictory observation unsettles the
 *   whole picture (a sensor that merely corroborates still shares its doubt);
 * - `observedAt` is the oldest surviving observation, so the merged reading
 *   ages honestly;
 * - `evidence` follows the base (highest-priority) reading, which owns the
 *   merged story.
 *
 * Exact bounds are facts, not estimates: `remainingRatio === 0` or
 * `usedRatio === 1` signals exhaustion at any confidence, while the softer
 * `draining` signal requires `high` confidence (ADP-021). Anything that is
 * not a well-formed measurement is rejected — untrusted data becomes "no
 * estimate", never a guess.
 */
import type { HealthEvent, ResourceKey } from "../resource-health/types.js"
import {
  CONFIDENCE_LEVELS,
  type CapacityConfig,
  type CapacityReading,
  type CapacitySignals,
  DEFAULT_CAPACITY_CONFIG,
  type Confidence,
} from "./types.js"

/** Evidence labels are bounded so unbounded header text cannot be persisted. */
export const MAX_EVIDENCE_LENGTH = 128

export function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(confidence)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isValidRatio(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

/**
 * Re-validates a reading field by field. A reading with an invalid ratio is
 * rejected entirely (its numbers cannot be partially trusted); invalid
 * `retryAfterMs`/`resetAt` values only drop their own field. A reading with
 * no measured field left is discarded as pure noise.
 */
export function normalizeReading(reading: unknown): CapacityReading | null {
  if (typeof reading !== "object" || reading === null) {
    return null
  }
  const candidate = reading as CapacityReading
  if (!CONFIDENCE_LEVELS.includes(candidate.confidence)) {
    return null
  }
  if (!isFiniteNumber(candidate.observedAt) || candidate.observedAt < 0) {
    return null
  }
  if (
    (candidate.usedRatio !== undefined && !isValidRatio(candidate.usedRatio)) ||
    (candidate.remainingRatio !== undefined && !isValidRatio(candidate.remainingRatio))
  ) {
    return null
  }
  const retryAfterMs =
    candidate.retryAfterMs !== undefined &&
    isFiniteNumber(candidate.retryAfterMs) &&
    Number.isInteger(candidate.retryAfterMs) &&
    candidate.retryAfterMs >= 0
      ? candidate.retryAfterMs
      : undefined
  const resetAt =
    isFiniteNumber(candidate.resetAt) && candidate.resetAt >= 0 ? candidate.resetAt : undefined
  const evidence =
    typeof candidate.evidence === "string"
      ? candidate.evidence.slice(0, MAX_EVIDENCE_LENGTH)
      : undefined
  if (
    candidate.usedRatio === undefined &&
    candidate.remainingRatio === undefined &&
    retryAfterMs === undefined &&
    resetAt === undefined
  ) {
    return null
  }
  return {
    ...(candidate.usedRatio !== undefined ? { usedRatio: candidate.usedRatio } : {}),
    ...(candidate.remainingRatio !== undefined ? { remainingRatio: candidate.remainingRatio } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    confidence: candidate.confidence,
    observedAt: candidate.observedAt,
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

function isFresh(reading: CapacityReading, now: number, config: CapacityConfig): boolean {
  return now - reading.observedAt <= config.maxAgeMs
}

/**
 * Strict priority between two readings: higher confidence wins; on equal
 * confidence the more conservative remaining ratio wins (a missing remaining
 * ratio cannot prove scarcity, so it counts as the least conservative value).
 * Equal readings keep their relative order.
 */
function strictlyHigherPriority(candidate: CapacityReading, incumbent: CapacityReading): boolean {
  const byConfidence = confidenceRank(candidate.confidence) - confidenceRank(incumbent.confidence)
  if (byConfidence !== 0) {
    return byConfidence > 0
  }
  const candidateRemaining = candidate.remainingRatio ?? 1
  const incumbentRemaining = incumbent.remainingRatio ?? 1
  return candidateRemaining < incumbentRemaining
}

/**
 * Merges concurrent readings for one resource. Returns `null` when nothing
 * survives normalization and the freshness window — an explicit "no estimate".
 *
 * Selection runs over the input order with a strict priority comparator, so
 * ties keep the earliest reading and both comparator outcomes stay reachable.
 */
export function mergeReadings(
  readings: readonly CapacityReading[],
  now: number,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG,
): CapacityReading | null {
  const survivors = readings
    .map(normalizeReading)
    .filter((reading): reading is CapacityReading => reading !== null)
    .filter((reading) => isFresh(reading, now, config))
  if (survivors.length === 0) {
    return null
  }
  const base = survivors.reduce((best, reading) =>
    strictlyHigherPriority(reading, best) ? reading : best,
  )
  const bestField = <T>(pick: (reading: CapacityReading) => T | undefined): T | undefined => {
    let best: CapacityReading | undefined
    let bestValue: T | undefined
    for (const reading of survivors) {
      const value = pick(reading)
      if (value === undefined) {
        continue
      }
      if (best === undefined || strictlyHigherPriority(reading, best)) {
        best = reading
        bestValue = value
      }
    }
    return bestValue
  }
  const usedRatio = bestField((reading) => reading.usedRatio)
  const remainingRatio = bestField((reading) => reading.remainingRatio)
  const retryAfterMs = bestField((reading) => reading.retryAfterMs)
  const resetAt = bestField((reading) => reading.resetAt)
  const confidence = survivors.reduce<Confidence>(
    (lowest, reading) =>
      confidenceRank(reading.confidence) < confidenceRank(lowest) ? reading.confidence : lowest,
    base.confidence,
  )
  const observedAt = Math.min(...survivors.map((reading) => reading.observedAt))
  return {
    ...(usedRatio !== undefined ? { usedRatio } : {}),
    ...(remainingRatio !== undefined ? { remainingRatio } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    confidence,
    observedAt,
    ...(base.evidence !== undefined ? { evidence: base.evidence } : {}),
  }
}

/**
 * Drain/exhaust derivation. Exhaustion is signaled by exact bounds at any
 * confidence (a header stating zero remaining is a fact, not a guess);
 * draining additionally requires `high` confidence because it withdraws new
 * work before hard evidence exists (ADP-021).
 */
export function capacitySignals(
  reading: CapacityReading,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG,
): CapacitySignals {
  const exhausted = reading.remainingRatio === 0 || reading.usedRatio === 1
  const draining =
    !exhausted &&
    reading.confidence === "high" &&
    ((reading.remainingRatio !== undefined &&
      reading.remainingRatio <= config.drainingRemainingThreshold) ||
      (reading.usedRatio !== undefined &&
        reading.usedRatio >= 1 - config.drainingRemainingThreshold))
  return { exhausted, draining }
}

/**
 * Pure bridge to the health layer: converts a merged reading into the
 * capacity event consumed by resource-health transitions (ADP-021). The
 * scheduler wiring decides when to observe it; this function only shapes it.
 */
export function capacityHealthEvent(key: ResourceKey, reading: CapacityReading): HealthEvent {
  return {
    kind: "capacity",
    key,
    exhausted: capacitySignals(reading).exhausted,
    ...(reading.retryAfterMs !== undefined ? { retryAfterMs: reading.retryAfterMs } : {}),
  }
}
