// covers: ["ADP-007", "ADP-008", "ADP-009"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { classifyFailure } from "../../../src/health/classifier/classify.js"
import {
  EVIDENCE_LAYERS,
  FAILURE_CATEGORIES,
  type ErrorEvidence,
  type FailureCategory,
  type FailureClassification,
} from "../../../src/health/classifier/types.js"

/** Categories whose failures allow horizontal recovery within the tier. */
const FAILOVER_ELIGIBLE: ReadonlySet<FailureCategory> = new Set([
  "rate_limited",
  "quota_exhausted",
  "outage",
  "overload",
  "timeout",
])

/** Categories that may enter a bounded retry loop at the same resource. */
const RETRYABLE: ReadonlySet<FailureCategory> = new Set([
  "rate_limited",
  "outage",
  "overload",
  "timeout",
])

const KNOWN_STRUCTURED_TYPES = [
  "UnauthorizedError",
  "ForbiddenError",
  "ModelNotFoundError",
  "UnsupportedModelError",
  "ServiceUnavailableError",
  "ProviderRequestError",
  "UnknownError",
] as const

function expectConsistentPolicy(c: FailureClassification): void {
  expect(FAILOVER_ELIGIBLE.has(c.category)).toBe(c.failoverEligible)
  expect(RETRYABLE.has(c.category)).toBe(c.retry.retryable)
  // A present retryAfterMs is a KNOWN RESET TIME, not a recommendation to
  // retry: non-retryable categories (quota exhaustion) carry it so the health
  // layer can lift the block when the window resets.
  if (c.retry.retryAfterMs !== undefined) {
    expect(c.retry.retryAfterMs).toBeGreaterThanOrEqual(0)
    expect(c.retry.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  }
  expect(EVIDENCE_LAYERS).toContain(c.layer)
  if (c.layer === "textual" || c.layer === "none") {
    expect(c.definitive).toBe(false)
  }
}

describe("classifyFailure: quota scope", () => {
  it.each([
    "You've hit your session limit · resets 6:10pm (Europe/Budapest)",
    "You've hit your weekly limit",
    "You've hit your usage limit",
    "Insufficient credits",
    "Out of credits",
    "Credit balance is too low",
  ])("identifies a shared subscription or balance limit: %s", (text) => {
    expect(classifyFailure({ text })).toMatchObject({
      category: "quota_exhausted",
      quotaScope: "provider",
    })
  })

  it.each([
    "Model quota exhausted",
    "Sonnet weekly limit reached",
    "quota exceeded",
    "You've hit your weekly limit for Sonnet",
    "You've hit your usage limit on model X",
  ])("does not widen model-specific or ambiguous quota evidence: %s", (text) => {
    expect(classifyFailure({ text }).category).toBe("quota_exhausted")
    expect(classifyFailure({ text })).not.toHaveProperty("quotaScope")
  })
})

describe("classifyFailure: interruption evidence", () => {
  it("maps a user interruption to user_cancelled with no retry and no failover", () => {
    const c = classifyFailure({ interrupted: "user" })
    expect(c).toEqual({
      category: "user_cancelled",
      layer: "interruption",
      definitive: true,
      retry: { retryable: false },
      failoverEligible: false,
    })
  })

  it("user interruption beats every other evidence layer", () => {
    const c = classifyFailure({
      interrupted: "user",
      status: 429,
      text: "rate limit exceeded",
      headers: { "retry-after": "5" },
      providerMetadata: { quotaExhausted: true },
    })
    expect(c.category).toBe("user_cancelled")
    expect(c.failoverEligible).toBe(false)
  })

  it("maps non-user interruptions to unknown without failover", () => {
    for (const interrupted of ["shutdown", "superseded", "inactivity"] as const) {
      const c = classifyFailure({ interrupted })
      expect(c.category).toBe("unknown")
      expect(c.layer).toBe("interruption")
      expect(c.definitive).toBe(true)
      expect(c.failoverEligible).toBe(false)
      expect(c.retry.retryable).toBe(false)
    }
  })
})

describe("classifyFailure: structured metadata layer", () => {
  it.each([
    ["UnauthorizedError", "auth_failure"],
    ["ForbiddenError", "auth_failure"],
    ["ModelNotFoundError", "invalid_model"],
    ["UnsupportedModelError", "invalid_model"],
    ["ServiceUnavailableError", "outage"],
  ] as const)("maps %s to %s", (type, category) => {
    const c = classifyFailure({ structured: { type }, status: 500, text: "rate limit exceeded" })
    expect(c.category).toBe(category)
    expect(c.layer).toBe("structured")
    expect(c.definitive).toBe(true)
    expectConsistentPolicy(c)
  })

  it("carries the structured retryAfterMs into a retryable category", () => {
    const c = classifyFailure({
      structured: { type: "ServiceUnavailableError", retryAfterMs: 2500 },
    })
    expect(c.category).toBe("outage")
    expect(c.retry).toEqual({ retryable: true, retryAfterMs: 2500 })
  })

  it("falls through to HTTP status for unmapped structured tags", () => {
    for (const type of ["ProviderRequestError", "UnknownError", "SomeFutureTag"]) {
      const c = classifyFailure({ structured: { type }, status: 429 })
      expect(c.category).toBe("rate_limited")
      expect(c.layer).toBe("status")
    }
  })

  it("never resolves a structured type through the prototype chain (regression)", () => {
    // A hostile or accidental tag like "toString" must be treated as unmapped,
    // not as the inherited Object.prototype member.
    for (const type of ["toString", "constructor", "hasOwnProperty"]) {
      const c = classifyFailure({ structured: { type }, status: 429 })
      expect(c.category).toBe("rate_limited")
      expect(c.layer).toBe("status")
    }
    const noStatus = classifyFailure({ structured: { type: "toString" } })
    expect(noStatus.category).toBe("unknown")
    expect(noStatus.definitive).toBe(false)
  })
})

describe("classifyFailure: HTTP status layer", () => {
  it.each([
    [401, "auth_failure"],
    [403, "auth_failure"],
    [408, "timeout"],
    [413, "context_overflow"],
    [502, "outage"],
    [503, "outage"],
    [504, "outage"],
  ] as const)("maps %i to %s", (status, category) => {
    const c = classifyFailure({ status })
    expect(c.category).toBe(category)
    expect(c.layer).toBe("status")
    expect(c.definitive).toBe(true)
    expectConsistentPolicy(c)
  })

  it.each([
    "Insufficient Balance",
    "insufficient_credits",
    "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 100.",
    "",
  ])("maps 402 to provider-wide quota exhaustion (%j)", (text) => {
    const c = classifyFailure({ status: 402, text })
    expect(c.category).toBe("quota_exhausted")
    expect(c.layer).toBe("status")
    expect(c.definitive).toBe(true)
    expect(c.quotaScope).toBe("provider")
    expectConsistentPolicy(c)
  })

  it("honors Retry-After on a 402", () => {
    const c = classifyFailure({ status: 402, headers: { "retry-after": "30" } })
    expect(c.quotaScope).toBe("provider")
    expect(c.retry.retryAfterMs).toBe(30_000)
  })

  it("leaves ambiguous statuses to lower layers", () => {
    for (const status of [400, 404, 409, 500]) {
      const c = classifyFailure({ status })
      expect(c.category).toBe("unknown")
      expect(c.layer).toBe("none")
    }
  })

  it("classifies a bare 429 as short rate limiting", () => {
    const c = classifyFailure({ status: 429 })
    expect(c.category).toBe("rate_limited")
    expect(c.definitive).toBe(true)
    expect(c.retry.retryable).toBe(true)
    expect(c.retry.retryAfterMs).toBeUndefined()
  })

  it("refines 429 with all-zero remaining quota headers to fixed-window exhaustion", () => {
    const c = classifyFailure({
      status: 429,
      headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "50" },
    })
    expect(c.category).toBe("quota_exhausted")
    expect(c.layer).toBe("status")
    expect(c.retry.retryable).toBe(false)
    expect(c.failoverEligible).toBe(true)
  })

  it("treats mixed remaining headers as short rate limiting", () => {
    const c = classifyFailure({
      status: 429,
      headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-remaining-tokens": "1200" },
    })
    expect(c.category).toBe("rate_limited")
  })
})

describe("classifyFailure: 429 quota text", () => {
  it("refines a 429 whose message says the quota is spent to quota exhaustion", () => {
    const c = classifyFailure({
      status: 429,
      text: "You exceeded your current quota, please check your plan and billing details.",
    })
    expect(c.category).toBe("quota_exhausted")
    expect(c.layer).toBe("status")
    expect(c.definitive).toBe(true)
    expect(c.failoverEligible).toBe(true)
    expect(c.quotaScope).toBeUndefined()
  })

  it("keeps the 429's Retry-After as the quota window bound", () => {
    const c = classifyFailure({
      status: 429,
      headers: { "retry-after": "60" },
      text: "insufficient_quota: You exceeded your current quota",
    })
    expect(c.category).toBe("quota_exhausted")
    expect(c.retry.retryAfterMs).toBe(60_000)
  })

  it("scopes a 429 shared subscription limit to the provider", () => {
    const c = classifyFailure({
      status: 429,
      text: "You've hit your session limit · resets 6:10pm (Europe/Budapest)",
    })
    expect(c.category).toBe("quota_exhausted")
    expect(c.quotaScope).toBe("provider")
  })

  it("keeps the short window when the message is about rate limits", () => {
    for (const text of [
      "Rate limit reached for gpt-x on tokens per min (TPM): Limit 10000. quota",
      "You exceeded your current quota. See https://ai.google.dev/gemini-api/docs/rate-limits",
      "rate limited",
    ]) {
      expect(classifyFailure({ status: 429, text }).category).toBe("rate_limited")
    }
  })

  it("never lets quota text override a non-429 status", () => {
    const c = classifyFailure({ status: 503, text: "quota exceeded" })
    expect(c.category).toBe("outage")
  })
})

describe("classifyFailure: retry-after extraction", () => {
  it("prefers the structured retryAfterMs over the header", () => {
    const c = classifyFailure({
      structured: { type: "ProviderRequestError", retryAfterMs: 1000 },
      status: 429,
      headers: { "retry-after": "60" },
    })
    expect(c.retry.retryAfterMs).toBe(1000)
  })

  it("parses integer-second Retry-After headers into milliseconds", () => {
    const c = classifyFailure({ status: 429, headers: { "retry-after": "3" } })
    expect(c.retry.retryAfterMs).toBe(3000)
  })

  it("ignores HTTP-date Retry-After headers (no clock in the classifier)", () => {
    const c = classifyFailure({
      status: 429,
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    })
    expect(c.retry.retryAfterMs).toBeUndefined()
    expect(c.category).toBe("rate_limited")
  })

  it("rejects negative or non-integer structured delays", () => {
    const c = classifyFailure({
      structured: { type: "ProviderRequestError", retryAfterMs: -5 },
      status: 429,
    })
    expect(c.retry.retryAfterMs).toBeUndefined()
    const c2 = classifyFailure({
      structured: { type: "ProviderRequestError", retryAfterMs: 1.5 },
      status: 429,
    })
    expect(c2.retry.retryAfterMs).toBeUndefined()
  })

  it("carries the known reset through a non-retryable quota classification", () => {
    // The health layer needs the quota window even though the classification
    // is non-retryable: without it the resource would block forever.
    const c = classifyFailure({
      status: 429,
      headers: {
        "x-ratelimit-remaining-requests": "0",
        "retry-after": "3600",
      },
    })
    expect(c.category).toBe("quota_exhausted")
    expect(c.retry.retryable).toBe(false)
    expect(c.retry.retryAfterMs).toBe(3_600_000)
  })

  it("caps absurd Retry-After values at one day", () => {
    const c = classifyFailure({ status: 429, headers: { "retry-after": "999999999" } })
    expect(c.retry.retryable).toBe(true)
    expect(c.retry.retryAfterMs).toBe(24 * 60 * 60 * 1000)
  })

  it("classifies Retry-After without a decisive status as non-definitive rate limiting", () => {
    const c = classifyFailure({ headers: { "retry-after": "30" } })
    expect(c).toEqual({
      category: "rate_limited",
      layer: "headers",
      definitive: false,
      retry: { retryable: true, retryAfterMs: 30000 },
      failoverEligible: true,
    })
  })
})

describe("classifyFailure: provider metadata layer", () => {
  it("maps normalized quota exhaustion from our own sensor", () => {
    const c = classifyFailure({ providerMetadata: { quotaExhausted: true } })
    expect(c.category).toBe("quota_exhausted")
    expect(c.layer).toBe("provider-metadata")
    expect(c.definitive).toBe(true)
    expect(c.failoverEligible).toBe(true)
  })

  it("maps normalized overload signals", () => {
    const c = classifyFailure({ providerMetadata: { overloaded: true } })
    expect(c.category).toBe("overload")
    expect(c.layer).toBe("provider-metadata")
    expect(c.failoverEligible).toBe(true)
  })

  it("yields to stronger standard-header evidence", () => {
    const c = classifyFailure({
      providerMetadata: { quotaExhausted: true },
      headers: { "retry-after": "10" },
    })
    expect(c.category).toBe("rate_limited")
    expect(c.layer).toBe("headers")
  })
})

describe("classifyFailure: textual last resort", () => {
  it.each([
    ["prompt is too long: 200000 tokens > 128000 maximum context length", "context_overflow"],
    ["Your input length exceeds the context window", "context_overflow"],
    [
      "You exceeded your current quota, please check your plan and billing details",
      "quota_exhausted",
    ],
    ["Your credit balance is too low", "quota_exhausted"],
    // Regression (live daemon): claude-agent's subscription-limit message was
    // classified unknown, so the resource stayed "ready" and every following
    // prompt re-picked it instead of falling back to the tier's next resource.
    [
      "You've hit your session limit · resets 6:10pm (Europe/Budapest) Resets at 2026-11-03T17:10:00.000Z.",
      "quota_exhausted",
    ],
    ["You've hit your usage limit. Your limit will reset at 5pm", "quota_exhausted"],
    // Real-world phrasings sibling fallback plugins missed (their issue
    // trackers): Anthropic's snake-cased limit, OpenCode Zen's free-usage
    // wording, and credit exhaustion without "balance".
    ["usage_limit_has_been_reached", "quota_exhausted"],
    ["Free usage exceeded, subscribe to Go", "quota_exhausted"],
    ["You are out of credits", "quota_exhausted"],
    ["Insufficient credits to run this request", "quota_exhausted"],
    ["ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.", "quota_exhausted"],
    ["Rate limit exceeded, please retry after 20s", "rate_limited"],
    ["Request timed out", "timeout"],
    ["Connection error: ETIMEDOUT", "timeout"],
    ["Invalid API key provided", "auth_failure"],
    ["The model `gpt-9x` does not exist", "invalid_model"],
    ["Your request was flagged by the safety system", "content_policy"],
    ["The provider is overloaded, try again later", "overload"],
    ["Request cancelled by user", "user_cancelled"],
  ] as const)("classifies %j as %s", (text, category) => {
    const c = classifyFailure({ text })
    expect(c.category).toBe(category)
    expect(c.layer).toBe("textual")
    expect(c.definitive).toBe(false)
    expectConsistentPolicy(c)
  })

  it("ignores patterns beyond the text bound", () => {
    const c = classifyFailure({ text: `${"x".repeat(512)} rate limit exceeded` })
    expect(c.category).toBe("unknown")
    expect(c.layer).toBe("none")
  })

  it("matches patterns inside the bound", () => {
    const c = classifyFailure({ text: `${"x".repeat(400)} rate limit exceeded` })
    expect(c.category).toBe("rate_limited")
  })
})

describe("classifyFailure: total classification", () => {
  it("returns unknown for empty evidence", () => {
    expect(classifyFailure({})).toEqual({
      category: "unknown",
      layer: "none",
      definitive: false,
      retry: { retryable: false },
      failoverEligible: false,
    })
  })

  it("never throws and always honors the policy invariants over generated evidence", () => {
    const statusArb = fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined })
    const structuredArb = fc.option(
      fc.record({
        type: fc.oneof(fc.constantFrom(...KNOWN_STRUCTURED_TYPES), fc.string({ maxLength: 40 })),
        retryAfterMs: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
      }),
      { nil: undefined },
    )
    const headersArb = fc.dictionary(
      fc.oneof(
        fc.constantFrom(
          "retry-after",
          "x-ratelimit-remaining",
          "x-ratelimit-remaining-tokens",
          "x-codex-quota",
        ),
        fc.string({ maxLength: 24 }),
      ),
      fc.string({ maxLength: 60 }),
      { minKeys: 0, maxKeys: 4 },
    )
    const metadataArb = fc.option(
      fc.record({ quotaExhausted: fc.boolean(), overloaded: fc.boolean() }),
      { nil: undefined },
    )
    const interruptedArb = fc.option(
      fc.constantFrom("user", "shutdown", "superseded", "inactivity"),
      { nil: undefined },
    )
    const evidenceArb: fc.Arbitrary<ErrorEvidence> = fc.record(
      {
        interrupted: interruptedArb,
        structured: structuredArb,
        status: statusArb,
        headers: headersArb,
        providerMetadata: metadataArb,
        text: fc.option(fc.string({ maxLength: 3000 }), { nil: undefined }),
      },
      { requiredKeys: [] },
    )

    const props = [
      fc.property(evidenceArb, (evidence) => {
        const c = classifyFailure(evidence)
        expect(FAILURE_CATEGORIES).toContain(c.category)
        expect(EVIDENCE_LAYERS).toContain(c.layer)
        expectConsistentPolicy(c)
      }),
      fc.property(evidenceArb, (evidence) => {
        expect(classifyFailure(evidence)).toEqual(classifyFailure(evidence))
      }),
      fc.property(evidenceArb, (evidence) => {
        const c = classifyFailure({ ...evidence, interrupted: "user" })
        expect(c.category).toBe("user_cancelled")
        expect(c.failoverEligible).toBe(false)
        expect(c.retry.retryable).toBe(false)
      }),
    ]
    for (const prop of props) {
      fc.assert(prop)
    }
  })
})
