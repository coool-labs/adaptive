/**
 * Contract between the deterministic fake provider (ADP-039) and the
 * classifier / capacity sensor: if a scripted scenario drifts from what the
 * production parsers understand, every E2E that relies on it silently tests
 * the wrong thing. Evidence is assembled exactly the way a host adapter would
 * from the scenario's wire response.
 */
// covers: ["ADP-008", "ADP-009", "ADP-020", "ADP-039"]
import { describe, expect, it } from "vitest"

import {
  FAKE_SCENARIOS,
  RETRY_AFTER_SECONDS,
  type FakeProviderBehavior,
} from "@coool/adaptive-testkit/fake-provider/scenarios"
import { classifyFailure } from "../../src/health/classifier/classify.js"
import type { ErrorEvidence } from "../../src/health/classifier/types.js"
import { parseCodexUsage } from "../../src/sensors/codex-capacity/parse.js"
import { readingFromUsage } from "../../src/sensors/codex-capacity/reading.js"
import { capacitySignals } from "../../src/health/capacity/merge.js"

function firstBehavior(name: keyof typeof FAKE_SCENARIOS): FakeProviderBehavior {
  return FAKE_SCENARIOS[name].behaviors[0]
}

function evidenceOf(behavior: FakeProviderBehavior): ErrorEvidence {
  const body = behavior.body === undefined ? undefined : (JSON.parse(behavior.body) as unknown)
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: { message?: string } }).error.message
      : undefined
  return {
    ...(behavior.status === undefined ? {} : { status: behavior.status }),
    ...(behavior.headers === undefined ? {} : { headers: behavior.headers }),
    ...(message === undefined ? {} : { text: message }),
  }
}

describe("fake provider scenarios classify as the product expects", () => {
  it("rate-limited is a definitive short 429 carrying its Retry-After", () => {
    const c = classifyFailure(evidenceOf(firstBehavior("rate-limited")))
    expect(c).toMatchObject({ category: "rate_limited", layer: "status", definitive: true })
    expect(c.retry.retryAfterMs).toBe(Number(RETRY_AFTER_SECONDS) * 1000)
    expect(c.failoverEligible).toBe(true)
  })

  it("quota-exhausted is fixed-window exhaustion, not a burst limit", () => {
    const c = classifyFailure(evidenceOf(firstBehavior("quota-exhausted")))
    expect(c).toMatchObject({ category: "quota_exhausted", definitive: true })
    expect(c.retry.retryAfterMs).toBe(60_000)
  })

  it("outage is a definitive failover-eligible infrastructure failure", () => {
    const c = classifyFailure(evidenceOf(firstBehavior("outage")))
    expect(c).toMatchObject({ category: "outage", definitive: true, failoverEligible: true })
  })

  it("context-rejection is a request-level failure that never fails over", () => {
    const c = classifyFailure(evidenceOf(firstBehavior("context-rejection")))
    expect(c).toMatchObject({ category: "context_overflow", failoverEligible: false })
    expect(c.retry.retryable).toBe(false)
  })

  it("recovery-after-n fails with the same rate limit it recovers from", () => {
    const [first, second, recovered] = FAKE_SCENARIOS["recovery-after-n"].behaviors
    expect(classifyFailure(evidenceOf(first)).category).toBe("rate_limited")
    expect(classifyFailure(evidenceOf(second ?? first)).category).toBe("rate_limited")
    expect(recovered?.status ?? 200).toBe(200)
  })

  it("every scripted failure status classifies without inventing certainty", () => {
    for (const script of Object.values(FAKE_SCENARIOS)) {
      for (const behavior of script.behaviors) {
        if (behavior.status === undefined || behavior.status < 400) continue
        const c = classifyFailure(evidenceOf(behavior))
        expect(c.category).not.toBe("user_cancelled")
        expect(c.category).not.toBe("auth_failure")
      }
    }
  })
})

describe("the success scenario's subscription telemetry feeds the capacity sensor", () => {
  it("parses into a high-confidence reading that is neither exhausted nor draining", () => {
    const headers = firstBehavior("success").headers ?? {}
    const usage = parseCodexUsage(headers)
    expect(usage).not.toBeNull()
    if (usage === null) return
    const reading = readingFromUsage(usage, 1_000_000)
    expect(reading.confidence).toBe("high")
    expect(reading.usedRatio).toBeCloseTo(0.72)
    expect(reading.resetAt).toBe(1_000_000 + 900_000)
    expect(capacitySignals(reading)).toEqual({ exhausted: false, draining: false })
  })
})
