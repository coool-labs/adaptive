// covers: ["ADP-007", "ADP-019"]
import { expect, it } from "vitest"

import { classifyFailure } from "../../../src/health/classifier/classify.js"
import { failureEvent, failureKey } from "../../../src/health/resource-health/failure.js"
import type { ResourceKey } from "../../../src/health/resource-health/types.js"

const VARIANT: ResourceKey = { providerID: "p", modelID: "m", variantID: "high" }

it("scopes provider-wide quota to the provider and model quota above the variant", () => {
  expect(failureKey(VARIANT, classifyFailure({ status: 402 }))).toEqual({ providerID: "p" })
  const quota = classifyFailure({ text: "You exceeded your current quota" })
  expect(quota.category).toBe("quota_exhausted")
  expect(failureKey(VARIANT, quota)).toEqual({ providerID: "p", modelID: "m" })
  expect(failureKey({ providerID: "p", modelID: "m" }, quota)).toEqual({
    providerID: "p",
    modelID: "m",
  })
  expect(failureKey(VARIANT, classifyFailure({ status: 503 }))).toBe(VARIANT)
})

it("forwards a provider-declared reset instant", () => {
  const c = classifyFailure({
    text: "You've hit your session limit. Resets at 2026-11-03T17:10:00Z",
  })
  expect(failureEvent(VARIANT, c)).toEqual({
    kind: "failure",
    key: { providerID: "p" },
    category: "quota_exhausted",
    definitive: false,
    retryAt: Date.parse("2026-11-03T17:10:00Z"),
  })
})

it("carries category, definitiveness and any known retry delay", () => {
  expect(failureEvent(VARIANT, classifyFailure({ status: 503 }))).toEqual({
    kind: "failure",
    key: VARIANT,
    category: "outage",
    definitive: true,
  })
  const limited = classifyFailure({ status: 429, headers: { "retry-after": "7" } })
  expect(failureEvent(VARIANT, limited)).toEqual({
    kind: "failure",
    key: VARIANT,
    category: "rate_limited",
    definitive: true,
    retryAfterMs: 7_000,
  })
})
