/**
 * Capacity sensor boundary (ADP-020).
 *
 * Capacity is observed, never inferred: a sensor reports what its telemetry
 * actually shows (used/remaining ratios, retry-after, reset time) and grades
 * its own confidence. A `null` reading or assessment means "no trustworthy
 * estimate" — callers must treat that as unknown, never as healthy. Provider
 * specific sensing (passive Codex headers, optional quota endpoints) lives in
 * adapters; this module owns the boundary type, the deterministic merge of
 * concurrent readings for one resource, and the derivation of the
 * draining/exhausted signals consumed by the health layer (ADP-021).
 */
import type { ResourceKey } from "../resource-health/types.js"

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const satisfies readonly string[]

/** How much a sensor trusts its own numbers. `high` is required for draining. */
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

/**
 * One observation of a resource's capacity. Ratios are fractions in [0, 1].
 * A reading may carry any subset of the measured fields (e.g. a header that
 * only reports a Retry-After); a reading with none of them carries no
 * information and is discarded. `observedAt` is when the underlying telemetry
 * was seen, not when the sensor was asked.
 */
export interface CapacityReading {
  readonly usedRatio?: number | undefined
  readonly remainingRatio?: number | undefined
  readonly retryAfterMs?: number | undefined
  /** Epoch milliseconds at which capacity is expected to reset. */
  readonly resetAt?: number | undefined
  readonly confidence: Confidence
  readonly observedAt: number
  /** Bounded, secret-free label of the data source (e.g. a header name). */
  readonly evidence?: string | undefined
}

/** A source of capacity observations for exactly one resource. */
export interface CapacitySensor {
  readonly id: string
  readonly resource: ResourceKey
  /**
   * Returns the latest reading, or `null` when the sensor has no trustworthy
   * estimate. Expected "no data" must be returned as `null`, never thrown;
   * the registry still guards against throws (fail-open: a failing sensor is
   * no estimate, not an error).
   */
  read(): Promise<CapacityReading | null>
}

export interface CapacityConfig {
  /** Readings older than this are treated as absent (no estimate). */
  readonly maxAgeMs: number
  /**
   * Near-exhaustion bound at or below which high-confidence evidence marks
   * the resource `draining` (ADP-021). A fixed product constant, deliberately
   * not user-configurable — no threshold sliders.
   */
  readonly drainingRemainingThreshold: number
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  maxAgeMs: 60_000,
  drainingRemainingThreshold: 0.1,
}

/** Drain/exhaust derivation for a merged reading. */
export interface CapacitySignals {
  readonly exhausted: boolean
  readonly draining: boolean
}

/**
 * Scheduler-facing view for one resource. `none` is the explicit "no
 * estimate" answer — unknown capacity, not zero capacity.
 */
export type CapacityAssessment =
  | { readonly kind: "none" }
  | {
      readonly kind: "estimate"
      readonly reading: CapacityReading
      readonly signals: CapacitySignals
    }
