// covers: ["ADP-008", "ADP-009", "ADP-010", "ADP-011", "ADP-012", "ADP-013"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { classifyFailure } from "../../../src/health/classifier/classify.js"
import type { ErrorEvidence, FailureCategory } from "../../../src/health/classifier/types.js"

const DAY_MS = 24 * 60 * 60 * 1000

/** Categories the circuit breaker counts (anything else is demand/request evidence). */
const BREAKER_COUNTED: readonly FailureCategory[] = ["outage", "overload", "timeout"]

describe("Retry-After header boundaries (untrusted provider data, ADP-011)", () => {
  it.each([
    ["0", 0],
    ["1", 1_000],
    ["59", 59_000],
    ["86400", DAY_MS],
    ["86401", DAY_MS],
    ["9".repeat(30), DAY_MS],
    ["9".repeat(400), DAY_MS],
  ])("accepts the integer-seconds form %j as %j ms, never above one day", (raw, expected) => {
    const c = classifyFailure({ status: 429, headers: { "retry-after": raw } })
    expect(c.category).toBe("rate_limited")
    expect(c.retry.retryAfterMs).toBe(expected)
  })

  it.each([
    "-1",
    "1.5",
    " 5",
    "5 ",
    "+5",
    "1e3",
    "0x10",
    "",
    "five",
    "٣",
    "Wed, 21 Oct 2026 07:28:00 GMT",
  ])("ignores the malformed value %j without losing the 429 classification", (raw) => {
    const c = classifyFailure({ status: 429, headers: { "retry-after": raw } })
    expect(c.category).toBe("rate_limited")
    expect(c.definitive).toBe(true)
    expect(c.retry).toEqual({ retryable: true })
  })

  it("reads header names case-insensitively", () => {
    const c = classifyFailure({ status: 429, headers: { "Retry-After": "7" } })
    expect(c.retry.retryAfterMs).toBe(7_000)
  })

  it("does not let a malformed header turn a header-only failure into a classification", () => {
    expect(classifyFailure({ headers: { "retry-after": "soon" } }).layer).toBe("none")
  })
})

describe("structured retry delay boundaries", () => {
  it.each([
    [0, 0],
    [1, 1],
    [DAY_MS, DAY_MS],
    [DAY_MS + 1, DAY_MS],
    [Number.MAX_SAFE_INTEGER, DAY_MS],
  ])("keeps %j ms as %j (bounded to one day)", (given, expected) => {
    const c = classifyFailure({
      structured: { type: "ServiceUnavailableError", retryAfterMs: given },
    })
    expect(c.retry.retryAfterMs).toBe(expected)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "drops the invalid delay %j",
    (given) => {
      const c = classifyFailure({
        structured: { type: "ServiceUnavailableError", retryAfterMs: given },
      })
      expect(c.category).toBe("outage")
      expect(c.retry.retryAfterMs).toBeUndefined()
    },
  )

  it("prefers a valid structured delay over the header but falls back to it when invalid", () => {
    expect(
      classifyFailure({
        status: 503,
        structured: { type: "ProviderRequestError", retryAfterMs: 2_000 },
        headers: { "retry-after": "9" },
      }).retry.retryAfterMs,
    ).toBe(2_000)
    expect(
      classifyFailure({
        status: 503,
        structured: { type: "ProviderRequestError", retryAfterMs: -5 },
        headers: { "retry-after": "9" },
      }).retry.retryAfterMs,
    ).toBe(9_000)
  })
})

describe("HTTP status boundaries", () => {
  it.each([99, 600, 0, -1, 429.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats the out-of-range status %j as no status evidence",
    (status) => {
      expect(classifyFailure({ status, text: "plain failure" }).layer).toBe("none")
    },
  )

  it.each([100, 199, 200, 204, 301, 400, 404, 409, 422, 500, 501, 505, 529, 599])(
    "leaves the ambiguous status %j to lower layers (never invents certainty)",
    (status) => {
      const c = classifyFailure({ status })
      expect(c.category).toBe("unknown")
      expect(c.definitive).toBe(false)
    },
  )
})

describe("quota refinement of a 429", () => {
  it("keeps the short window when any remaining-quota header is non-zero or unparsable", () => {
    for (const other of ["1", "", "0.0", "00", " 0", "unlimited"]) {
      const c = classifyFailure({
        status: 429,
        headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-remaining-tokens": other },
      })
      expect(c.category).toBe("rate_limited")
    }
  })

  it("is exhausted only when every remaining header reads exactly zero", () => {
    const c = classifyFailure({
      status: 429,
      headers: { "X-RateLimit-Remaining-Requests": "0", "x-ratelimit-remaining-tokens": "0" },
    })
    expect(c.category).toBe("quota_exhausted")
  })
})

describe("policy properties over arbitrary evidence", () => {
  const textArb = fc.option(
    fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.constantFrom(
        "rate limit exceeded",
        "You exceeded your current quota",
        "request timed out",
        "invalid api key",
        "model not found",
        "service overloaded",
        "context length exceeded",
        "Unauthorized",
      ),
    ),
    { nil: undefined },
  )
  const headersArb = fc.dictionary(
    fc.constantFrom(
      "retry-after",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-remaining-tokens",
      "Retry-After",
    ),
    fc.constantFrom("0", "1", "5", "86400", "-1", "abc", ""),
    { maxKeys: 4 },
  )
  const evidenceArb: fc.Arbitrary<ErrorEvidence> = fc.record(
    {
      status: fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined }),
      headers: headersArb,
      providerMetadata: fc.record({ quotaExhausted: fc.boolean(), overloaded: fc.boolean() }),
      text: textArb,
    },
    { requiredKeys: [] },
  )

  it("a 429 status is never breaker-counted evidence (429s are demand, not health)", () => {
    const prop = fc.property(evidenceArb, (evidence) => {
      const c = classifyFailure({ ...evidence, status: 429 })
      expect(BREAKER_COUNTED).not.toContain(c.category)
      expect(["rate_limited", "quota_exhausted"]).toContain(c.category)
      expect(c.definitive).toBe(true)
      expect(c.layer).toBe("status")
    })
    fc.assert(prop, { numRuns: 400 })
  })

  it("text and bare headers never produce a definitive configuration failure (ADP-012)", () => {
    const prop = fc.property(evidenceArb, (evidence) => {
      const c = classifyFailure(evidence)
      if (c.definitive && (c.category === "auth_failure" || c.category === "invalid_model")) {
        expect(["structured", "status"]).toContain(c.layer)
      }
      if (c.layer === "textual" || c.layer === "headers" || c.layer === "none") {
        expect(c.definitive).toBe(false)
      }
    })
    fc.assert(prop, { numRuns: 400 })
  })

  it("user cancellation is final whatever else the evidence says (ADP-010)", () => {
    const prop = fc.property(
      evidenceArb,
      fc.option(fc.record({ type: fc.string(), retryAfterMs: fc.nat() }), { nil: undefined }),
      (evidence, structured) => {
        const c = classifyFailure({ ...evidence, structured, interrupted: "user" })
        expect(c).toEqual({
          category: "user_cancelled",
          layer: "interruption",
          definitive: true,
          retry: { retryable: false },
          failoverEligible: false,
        })
      },
    )
    fc.assert(prop, { numRuns: 200 })
  })

  it("only failover-eligible classifications carry a retry delay worth acting on", () => {
    const prop = fc.property(evidenceArb, (evidence) => {
      const c = classifyFailure(evidence)
      if (c.retry.retryAfterMs !== undefined) {
        expect(c.retry.retryAfterMs).toBeLessThanOrEqual(DAY_MS)
        expect(Number.isInteger(c.retry.retryAfterMs)).toBe(true)
      }
      if (!c.failoverEligible) {
        expect([
          "auth_failure",
          "invalid_model",
          "context_overflow",
          "content_policy",
          "user_cancelled",
          "unknown",
        ]).toContain(c.category)
      }
    })
    fc.assert(prop, { numRuns: 400 })
  })
})
