/**
 * Failure classification types (ADP-008, ADP-009).
 *
 * The classifier consumes a layered evidence record assembled by the OpenCode
 * adapter. Evidence layers exist so classification can honor the ADP-008
 * precedence chain: structured metadata beats HTTP status beats standard
 * headers beats documented provider-specific metadata beats bounded text.
 */
import type { InterruptReason } from "../../core/work-unit/interruption.js"

export const FAILURE_CATEGORIES = [
  "rate_limited",
  "quota_exhausted",
  "outage",
  "overload",
  "timeout",
  "auth_failure",
  "invalid_model",
  "context_overflow",
  "content_policy",
  "user_cancelled",
  "unknown",
] as const satisfies readonly string[]

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number]

/**
 * Where the winning classification came from. Exposed so receipts can show
 * why a decision was made and so tests can pin the precedence chain.
 */
export const EVIDENCE_LAYERS = [
  "interruption",
  "structured",
  "status",
  "headers",
  "provider-metadata",
  "textual",
  "none",
] as const satisfies readonly string[]

export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number]

/**
 * Structured OpenCode evidence (`Session.StructuredError`): a server-assigned
 * error tag plus, when the provider sent it, a retry delay OpenCode already
 * parsed from `Retry-After`. `type` is a free-form string on the wire, so the
 * classifier only interprets types from the documented @opencode/protocol
 * vocabulary and falls through to lower layers for anything unmapped instead
 * of guessing.
 */
export interface StructuredSignal {
  readonly type: string
  readonly retryAfterMs?: number | undefined
}

/**
 * Documented provider-specific metadata, already normalized by our own
 * adapters (e.g. the Codex capacity sensor validates `x-codex-*` headers
 * before producing these). The classifier never reads raw provider headers
 * itself.
 */
export interface ProviderMetadata {
  readonly quotaExhausted?: boolean | undefined
  readonly overloaded?: boolean | undefined
}

/**
 * Layered failure evidence. `status` is the merged HTTP status (the adapter
 * prefers the wire status seen by `http.response` over any status echoed in
 * structured metadata). `text` is the bounded concatenation of error message
 * and response body, bounded again defensively inside the classifier.
 */
export interface ErrorEvidence {
  readonly interrupted?: InterruptReason | undefined
  readonly structured?: StructuredSignal | undefined
  readonly status?: number | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly providerMetadata?: ProviderMetadata | undefined
  readonly text?: string | undefined
}

/** Advisory retry semantics; the retry policy (T-12) makes final decisions. */
export interface RetryAdvice {
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

export interface FailureClassification {
  readonly category: FailureCategory
  readonly layer: EvidenceLayer
  /**
   * True when the evidence conclusively identifies the failure. Textual
   * classifications are always non-definitive; scheduling treats
   * non-definitive evidence more conservatively (ADP-012).
   */
  readonly definitive: boolean
  readonly retry: RetryAdvice
  /** Horizontal recovery (switch resource within the tier) is allowed. */
  readonly failoverEligible: boolean
}
