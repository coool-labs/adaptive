/**
 * Resource health types (ADP-007, ADP-012, ADP-021).
 *
 * A resource is identified at the narrowest scope the evidence supports:
 * provider → account → model → variant. Health states are a closed set and
 * every transition between them is defined by the pure transition layer; the
 * registry never invents states. The circuit breaker (ADP-019) is an
 * orthogonal axis stored per resource record.
 */
import {
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerRecord,
} from "../circuit-breaker/types.js"
import type { FailureCategory } from "../classifier/types.js"

export const RESOURCE_SCOPES = [
  "provider",
  "account",
  "model",
  "variant",
] as const satisfies readonly string[]

export type ResourceScope = (typeof RESOURCE_SCOPES)[number]

/**
 * Hierarchical resource identity. The scope is derived from the most specific
 * field present, so callers attribute evidence at exactly the level they can
 * prove (e.g. a provider-wide outage without a model id stays at provider
 * scope; a per-variant failure quarantines only that variant).
 */
export interface ResourceKey {
  readonly providerID: string
  readonly accountID?: string | undefined
  readonly modelID?: string | undefined
  readonly variantID?: string | undefined
}

export const HEALTH_STATES = [
  "healthy",
  "draining",
  "degraded",
  "rate_limited",
  "quota_exhausted",
  "unavailable",
] as const satisfies readonly string[]

export type HealthState = (typeof HEALTH_STATES)[number]

/**
 * A time-bounded window during which the current state is known to hold
 * (e.g. until a Retry-After delay or a quota reset elapses). Absent when no
 * reset time is known — recovery then relies on probes, observed successes,
 * or explicit resets.
 */
export interface ResourceWindow {
  readonly kind: "rate-limit" | "quota"
  readonly until: number
}

export interface ResourceRecord {
  readonly key: ResourceKey
  readonly health: HealthState
  readonly breaker: BreakerRecord
  readonly window?: ResourceWindow | undefined
  readonly updatedAt: number
}

/**
 * Health evidence events. `failure` carries an already-classified category
 * (from the error classifier, ADP-009) plus the classification's
 * definitiveness and parsed retry delay. `capacity` carries a CapacitySensor
 * reading (ADP-020) — `exhausted: false` is positive evidence of capacity.
 * `reset` is the manual Control-mode recovery op.
 */
export type HealthEvent =
  | {
      readonly kind: "failure"
      readonly key: ResourceKey
      readonly category: FailureCategory
      readonly definitive: boolean
      readonly retryAfterMs?: number | undefined
    }
  | { readonly kind: "success"; readonly key: ResourceKey }
  | { readonly kind: "drain"; readonly key: ResourceKey }
  | {
      readonly kind: "capacity"
      readonly key: ResourceKey
      readonly exhausted: boolean
      readonly retryAfterMs?: number | undefined
    }
  | { readonly kind: "reset"; readonly key: ResourceKey }

export interface ResourceHealthConfig {
  readonly breaker: BreakerConfig
  /** Window applied to rate-limited evidence that carries no Retry-After. */
  readonly defaultRateLimitWindowMs: number
}

export const DEFAULT_HEALTH_CONFIG: ResourceHealthConfig = {
  breaker: DEFAULT_BREAKER_CONFIG,
  defaultRateLimitWindowMs: 30_000,
}

/** Injected monotonic clock, milliseconds. */
export type Clock = () => number

/**
 * Why an assessment blocks new work. Ordered from hardest to softest fact:
 * hard resource states (unavailable, quota, rate limit) are direct evidence;
 * breaker reasons are inferred from failure counts; draining is a policy
 * request, not a health fact.
 */
export const BLOCKED_REASONS = [
  "unavailable",
  "quota-exhausted",
  "rate-limited",
  "breaker-open",
  "probe-in-flight",
  "draining",
] as const satisfies readonly string[]

export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/** Opaque single-probe admission token; validated on report. */
export interface ProbeTicket {
  readonly id: string
  readonly key: ResourceKey
}

export type ProbeOutcome =
  { readonly success: true } | { readonly success: false; readonly category: FailureCategory }

/**
 * Result of assessing whether a resource may take new work right now. The
 * `blocked` variant reports the winning blocker's key (which may be a wider
 * scope than the assessed key) and, when known, when the block can lift.
 */
export type Assessment =
  | { readonly kind: "available" }
  | { readonly kind: "probe"; readonly ticket: ProbeTicket }
  | {
      readonly kind: "blocked"
      readonly reason: BlockedReason
      readonly key: ResourceKey
      readonly retryAtMs?: number
    }
