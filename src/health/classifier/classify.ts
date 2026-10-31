import type { ErrorEvidence, FailureCategory, FailureClassification, RetryAdvice } from "./types.js"

/**
 * Text fed to the textual last-resort layer is truncated to this bound before
 * matching, so adversarial or enormous error bodies cannot dominate
 * classification cost or smuggle patterns in late bytes (ADP-008).
 */
const TEXT_BOUND = 512

/**
 * Retry/failover policy per category (ADP-010, ADP-011).
 *
 * - Infrastructure failures (rate limiting, quota, outage, overload, timeout)
 *   are failover-eligible: horizontal recovery within the tier is exactly
 *   their remedy.
 * - Permanent configuration failures (auth, invalid model, content policy)
 *   and context overflow never retry and never failover: retrying the same
 *   request cannot help and switching resources would reproduce the failure.
 * - User cancellation is final: no retry, no failover (ADP-010).
 * - Unknown failures defer to OpenCode's native handling.
 */
const CATEGORY_POLICY: Readonly<
  Record<FailureCategory, { retryable: boolean; failoverEligible: boolean }>
> = {
  rate_limited: { retryable: true, failoverEligible: true },
  quota_exhausted: { retryable: false, failoverEligible: true },
  outage: { retryable: true, failoverEligible: true },
  overload: { retryable: true, failoverEligible: true },
  timeout: { retryable: true, failoverEligible: true },
  auth_failure: { retryable: false, failoverEligible: false },
  invalid_model: { retryable: false, failoverEligible: false },
  context_overflow: { retryable: false, failoverEligible: false },
  content_policy: { retryable: false, failoverEligible: false },
  user_cancelled: { retryable: false, failoverEligible: false },
  unknown: { retryable: false, failoverEligible: false },
}

/**
 * Error tags from the documented @opencode/protocol vocabulary that map
 * directly to a failure category. Tags absent here (`ProviderRequestError`,
 * `UnknownError`, anything unrecognized) are structured but not
 * category-specific: they never guess, and classification falls through to
 * the refining layers.
 */
const STRUCTURED_TYPES = new Map<string, FailureCategory>([
  ["UnauthorizedError", "auth_failure"],
  ["ForbiddenError", "auth_failure"],
  ["ModelNotFoundError", "invalid_model"],
  ["UnsupportedModelError", "invalid_model"],
  ["ServiceUnavailableError", "outage"],
])

/**
 * Bounded textual patterns, last resort only (ADP-008). Ordered most
 * specific first; the first match wins. These encode provider error-message
 * conventions documented by the research phase, not a general-purpose
 * keyword classifier.
 */
const TEXTUAL_PATTERNS: readonly {
  readonly category: FailureCategory
  readonly pattern: RegExp
}[] = [
  {
    category: "context_overflow",
    pattern:
      /context (length|window)|maximum context|input length exceeds|prompt is too long|too many (input )?tokens|exceeds the maximum/i,
  },
  { category: "quota_exhausted", pattern: /\bquota\b|credit balance/i },
  { category: "rate_limited", pattern: /rate ?limit/i },
  { category: "timeout", pattern: /\btimeout\b|timed? ?out|deadline exceeded|etimedout/i },
  {
    category: "auth_failure",
    pattern:
      /unauthorized|invalid (api|access) key|api key (expired|invalid)|authentication|permission denied/i,
  },
  {
    category: "invalid_model",
    pattern: /model.{0,30}(does not exist|not found)|invalid model|unknown model|no such model/i,
  },
  {
    category: "content_policy",
    pattern:
      /content (management )?(policy|filter)|safety system|violates?.{0,32}policy|flagged as/i,
  },
  { category: "overload", pattern: /overloaded|over capacity|high demand/i },
  { category: "user_cancelled", pattern: /cancel+(l)?ed|aborted by (the )?user|user abort/i },
]

function isHttpStatus(status: number | undefined): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function lowercasedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  const lowered = new Map<string, string>()
  if (headers === undefined) {
    return lowered
  }
  for (const [name, value] of Object.entries(headers)) {
    lowered.set(name.toLowerCase(), value)
  }
  return lowered
}

/**
 * Parses a `Retry-After` header into milliseconds. Only the integer-seconds
 * form is accepted: the HTTP-date form requires a clock, which the classifier
 * deliberately does not have (reset-time handling belongs to the capacity
 * boundary, T-05/T-15).
 */
function retryAfterHeaderMs(headers: ReadonlyMap<string, string>): number | undefined {
  const raw = headers.get("retry-after")
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return undefined
  }
  return Number(raw) * 1000
}

/**
 * Standard rate-limit headers (case-insensitive `x-ratelimit-remaining*`).
 * All-zero remaining capacity indicates a fixed-window quota exhaustion
 * rather than a short burst limit.
 */
function fixedWindowExhausted(headers: ReadonlyMap<string, string>): boolean {
  let sawRemaining = false
  for (const [name, value] of headers) {
    if (name.startsWith("x-ratelimit-remaining")) {
      sawRemaining = true
      if (value !== "0") {
        return false
      }
    }
  }
  return sawRemaining
}

function retryAdvice(category: FailureCategory, retryAfterMs: number | undefined): RetryAdvice {
  const policy = CATEGORY_POLICY[category]
  if (!policy.retryable || retryAfterMs === undefined) {
    return { retryable: policy.retryable }
  }
  return { retryable: true, retryAfterMs }
}

function classification(
  category: FailureCategory,
  layer: FailureClassification["layer"],
  definitive: boolean,
  retryAfterMs: number | undefined,
): FailureClassification {
  const policy = CATEGORY_POLICY[category]
  return {
    category,
    layer,
    definitive,
    retry: retryAdvice(category, retryAfterMs),
    failoverEligible: policy.failoverEligible,
  }
}

/**
 * Classifies an HTTP status. 429 consults the standard rate-limit headers in
 * the same step: status plus documented standard headers are one HTTP
 * semantics layer, and the quota refinement is more specific evidence than a
 * bare 429, so it cannot weaken the ADP-008 precedence.
 */
function classifyStatus(
  status: number,
  headers: ReadonlyMap<string, string>,
): FailureCategory | undefined {
  if (status === 429) {
    return fixedWindowExhausted(headers) ? "quota_exhausted" : "rate_limited"
  }
  if (status === 401 || status === 403) {
    return "auth_failure"
  }
  if (status === 408) {
    return "timeout"
  }
  if (status === 413) {
    return "context_overflow"
  }
  if (status === 502 || status === 503 || status === 504) {
    return "outage"
  }
  return undefined
}

function classifyText(text: string): FailureCategory | undefined {
  const bounded = text.length > TEXT_BOUND ? text.slice(0, TEXT_BOUND) : text
  for (const { category, pattern } of TEXTUAL_PATTERNS) {
    if (pattern.test(bounded)) {
      return category
    }
  }
  return undefined
}

/**
 * Total classification of layered failure evidence. Never throws and always
 * returns a category: any evidence shape outside the documented vocabularies
 * classifies as `unknown` via the `none` layer, deferring to OpenCode's
 * native failure handling (ADP-009, ADP-012).
 */
export function classifyFailure(evidence: ErrorEvidence): FailureClassification {
  // Layer 0: interruption evidence. Interruptions are host decisions, not
  // provider failures; a user cancellation is final (ADP-010).
  if (evidence.interrupted === "user") {
    return classification("user_cancelled", "interruption", true, undefined)
  }
  if (evidence.interrupted !== undefined) {
    return classification("unknown", "interruption", true, undefined)
  }

  // Layer 1: structured OpenCode metadata.
  const structured = evidence.structured
  const structuredRetryAfterMs = isNonNegativeInteger(structured?.retryAfterMs)
    ? structured.retryAfterMs
    : undefined
  if (structured !== undefined) {
    const mapped = STRUCTURED_TYPES.get(structured.type)
    if (mapped !== undefined) {
      return classification(mapped, "structured", true, structuredRetryAfterMs)
    }
    // Unmapped tag: fall through so HTTP semantics can refine the category.
  }

  // Layer 2: HTTP status (+ standard headers for the 429 refinement).
  const headers = lowercasedHeaders(evidence.headers)
  if (isHttpStatus(evidence.status)) {
    const category = classifyStatus(evidence.status, headers)
    if (category !== undefined) {
      return classification(
        category,
        "status",
        true,
        structuredRetryAfterMs ?? retryAfterHeaderMs(headers),
      )
    }
  }

  // Layer 3: standard headers alone (Retry-After without a decisive status).
  const headerRetryAfterMs = retryAfterHeaderMs(headers)
  if (headerRetryAfterMs !== undefined) {
    return classification("rate_limited", "headers", false, headerRetryAfterMs)
  }

  // Layer 4: documented provider-specific metadata, normalized by our own
  // adapters after validation (T-15).
  if (evidence.providerMetadata?.quotaExhausted === true) {
    return classification("quota_exhausted", "provider-metadata", true, undefined)
  }
  if (evidence.providerMetadata?.overloaded === true) {
    return classification("overload", "provider-metadata", true, structuredRetryAfterMs)
  }

  // Layer 5: bounded textual classification, always non-definitive.
  const text = evidence.text
  if (text !== undefined) {
    const category = classifyText(text)
    if (category !== undefined) {
      return classification(category, "textual", false, structuredRetryAfterMs)
    }
  }

  return classification("unknown", "none", false, undefined)
}
