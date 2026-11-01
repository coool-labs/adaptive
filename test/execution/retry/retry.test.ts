// covers: ["ADP-008", "ADP-010", "ADP-011", "ADP-013"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { decideRetry, forMode } from "../../../src/execution/retry/decide.js"
import { MAX_VETOES_PER_UNIT } from "../../../src/execution/retry/types.js"
import type {
  NativeRetryDecision,
  RecoveryOption,
  RetryCoreDecision,
  RetryInput,
} from "../../../src/execution/retry/types.js"
import { OPERATING_MODES } from "../../../src/core/scheduler/types.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"
import {
  FAILURE_CATEGORIES,
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

const REF: ModelRef = { providerID: "provider-a", id: "model-a" }
const OTHER: ModelRef = { providerID: "provider-b", id: "model-b" }
const FAILED: ModelRef = { providerID: "provider-a", id: "model-a" }

function classification(category: FailureCategory, definitive: boolean): FailureClassification {
  return {
    category,
    layer: definitive ? "status" : "textual",
    definitive,
    retry: { retryable: true },
    failoverEligible: FAILOVER_ELIGIBLE.has(category),
  }
}

function input(overrides: Partial<RetryInput> = {}): RetryInput {
  return {
    classification: overrides.classification ?? classification("rate_limited", true),
    failingModel: overrides.failingModel ?? FAILED,
    native: overrides.native ?? { retry: true, delay: 1000 },
    recovery: overrides.recovery ?? { kind: "switch", model: OTHER },
    vetoesUsed: overrides.vetoesUsed ?? 0,
  }
}

describe("decideRetry", () => {
  it("vetoes when a definitive infrastructure failure has a recovery candidate", () => {
    expect(decideRetry(input())).toEqual({ kind: "veto", model: OTHER })
  })

  it.each([...FAILOVER_ELIGIBLE])("vetoes for %s", (category) => {
    const decision = decideRetry(input({ classification: classification(category, true) }))
    expect(decision).toEqual({ kind: "veto", model: OTHER })
  })

  it("carries the probe id of a probe-admitted recovery candidate", () => {
    const recovery: RecoveryOption = { kind: "switch", model: OTHER, probeId: "p7" }
    expect(decideRetry(input({ recovery }))).toEqual({ kind: "veto", model: OTHER, probeId: "p7" })
  })

  it("does not add a probeId field when the recovery has none", () => {
    const decision = decideRetry(input())
    expect(decision.kind === "veto" && "probeId" in decision).toBe(false)
  })

  it("vetoes at the last budget slot", () => {
    const decision = decideRetry(input({ vetoesUsed: MAX_VETOES_PER_UNIT - 1 }))
    expect(decision.kind).toBe("veto")
  })

  it("leaves when the recovery target is the failing model itself (E3 regression)", () => {
    // A degraded resource still assesses available, so the admission sweep can
    // offer the just-failed model as its own "recovery". Vetoing would discard
    // the host's backoff and immediately re-prompt the resource that is
    // actively failing. Probe recoveries are exempt: the probe targets the
    // failed resource by design.
    const sameModel: RecoveryOption = { kind: "switch", model: FAILED }
    expect(decideRetry(input({ recovery: sameModel }))).toEqual({ kind: "leave" })
    const sameVariant: RecoveryOption = {
      kind: "switch",
      model: { providerID: FAILED.providerID, id: FAILED.id, variant: "default" },
    }
    expect(decideRetry(input({ recovery: sameVariant }))).toEqual({ kind: "leave" })
    // The host's "default" spelling appears on the failing side too (the
    // retry hook reports the model actually invoked, variant included).
    expect(
      decideRetry(
        input({
          recovery: { kind: "switch", model: FAILED },
          failingModel: { providerID: FAILED.providerID, id: FAILED.id, variant: "default" },
        }),
      ),
    ).toEqual({ kind: "leave" })
    // A genuinely different variant of the same model IS a different
    // resource: the veto stands.
    expect(
      decideRetry(
        input({
          recovery: {
            kind: "switch",
            model: { providerID: FAILED.providerID, id: FAILED.id, variant: "strong" },
          },
          failingModel: { providerID: FAILED.providerID, id: FAILED.id, variant: "fast" },
        }),
      ),
    ).toMatchObject({ kind: "veto" })
  })
})

describe("native-defer cases", () => {
  it("leaves the native retry when no recovery candidate exists", () => {
    const decision = decideRetry(input({ recovery: { kind: "none" } }))
    expect(decision).toEqual({ kind: "leave" })
  })

  it("leaves when the host already decided not to retry", () => {
    const native: NativeRetryDecision = { retry: false }
    expect(decideRetry(input({ native }))).toEqual({ kind: "leave" })
  })

  it("leaves on ambiguous evidence (non-definitive classification)", () => {
    const decision = decideRetry(input({ classification: classification("rate_limited", false) }))
    expect(decision).toEqual({ kind: "leave" })
  })

  it("leaves when the per-unit veto budget is exhausted", () => {
    expect(decideRetry(input({ vetoesUsed: MAX_VETOES_PER_UNIT }))).toEqual({ kind: "leave" })
    expect(decideRetry(input({ vetoesUsed: MAX_VETOES_PER_UNIT + 3 }))).toEqual({ kind: "leave" })
  })
})

describe("non-failover categories never veto", () => {
  it("leaves on user cancellation", () => {
    const decision = decideRetry(input({ classification: classification("user_cancelled", true) }))
    expect(decision).toEqual({ kind: "leave" })
  })

  it.each([
    "auth_failure",
    "invalid_model",
    "context_overflow",
    "content_policy",
    "unknown",
  ] as const)("leaves on %s", (category) => {
    const decision = decideRetry(input({ classification: classification(category, true) }))
    expect(decision).toEqual({ kind: "leave" })
  })
})

describe("forMode", () => {
  const veto: RetryCoreDecision = { kind: "veto", model: OTHER }
  const leave: RetryCoreDecision = { kind: "leave" }

  it("applies the decision unchanged in control mode", () => {
    expect(forMode(veto, "active")).toBe(veto)
    expect(forMode(leave, "active")).toBe(leave)
  })

  it("wraps the decision in observe mode without changing it", () => {
    const wrapped = forMode(veto, "observe")
    expect(wrapped).toEqual({ kind: "observe-only", would: veto })
    expect(wrapped.kind === "observe-only" && wrapped.would).toBe(veto)
  })

  it("never intervenes in off mode", () => {
    expect(forMode(veto, "off")).toEqual({ kind: "leave" })
  })

  it("is total over the operating modes", () => {
    for (const mode of OPERATING_MODES) {
      const wrapped = forMode(leave, mode)
      expect(mode === "observe" ? wrapped.kind === "observe-only" : wrapped.kind === "leave").toBe(
        true,
      )
    }
  })
})

describe("properties", () => {
  const classificationArb: fc.Arbitrary<FailureClassification> = fc
    .record({
      category: fc.constantFrom(...FAILURE_CATEGORIES),
      definitive: fc.boolean(),
    })
    .map(({ category, definitive }) => classification(category, definitive))

  const recoveryArb: fc.Arbitrary<RecoveryOption> = fc
    .option(
      fc.record({
        providerID: fc.string({ minLength: 1 }),
        id: fc.string({ minLength: 1 }),
        variant: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      }),
      { nil: undefined },
    )
    .map((model) =>
      model === undefined ? ({ kind: "none" } as const) : ({ kind: "switch", model } as const),
    )

  const nativeArb: fc.Arbitrary<NativeRetryDecision> = fc
    .option(fc.integer({ min: 0, max: 60_000 }), { nil: undefined })
    .map((delay) =>
      delay === undefined ? ({ retry: false } as const) : ({ retry: true, delay } as const),
    )

  const inputArb: fc.Arbitrary<RetryInput> = fc.record({
    classification: classificationArb,
    failingModel: fc.constant(FAILED),
    native: nativeArb,
    recovery: recoveryArb,
    vetoesUsed: fc.integer({ min: 0, max: MAX_VETOES_PER_UNIT + 2 }),
  })

  /** Independent oracle restating ADP-013/014 veto conditions. */
  function expected(i: RetryInput): RetryCoreDecision {
    const eligible = FAILOVER_ELIGIBLE.has(i.classification.category)
    if (!eligible || !i.classification.definitive) {
      return { kind: "leave" }
    }
    if (i.recovery.kind !== "switch") {
      return { kind: "leave" }
    }
    if (!i.native.retry) {
      return { kind: "leave" }
    }
    if (i.vetoesUsed >= MAX_VETOES_PER_UNIT) {
      return { kind: "leave" }
    }
    const { model, probeId } = i.recovery
    return probeId === undefined ? { kind: "veto", model } : { kind: "veto", model, probeId }
  }

  it("matches the independently written veto oracle", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        expect(decideRetry(i)).toEqual(expected(i))
      }),
      { numRuns: 300 },
    )
  })

  it("is deterministic", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        expect(decideRetry(i)).toEqual(decideRetry(i))
      }),
      { numRuns: 200 },
    )
  })

  it("never vetoes a user cancellation", () => {
    fc.assert(
      fc.property(
        nativeArb,
        recoveryArb,
        fc.integer({ min: 0, max: MAX_VETOES_PER_UNIT }),
        (native, recovery, vetoesUsed) => {
          const i: RetryInput = {
            classification: classification("user_cancelled", true),
            failingModel: FAILED,
            native,
            recovery,
            vetoesUsed,
          }
          expect(decideRetry(i)).toEqual({ kind: "leave" })
        },
      ),
      { numRuns: 200 },
    )
  })

  it("recovery chains terminate within the per-unit veto budget", () => {
    // Worst case: every failure is a definitive infrastructure failure with a
    // fresh healthy candidate and a willing native retry. Vetoes must stop at
    // the budget, after which the policy leaves the native retry.
    fc.assert(
      fc.property(
        fc.constantFrom(...FAILOVER_ELIGIBLE),
        fc.integer({ min: 1, max: 10 }),
        (category, chainLength) => {
          let vetoesUsed = 0
          for (let step = 0; step < chainLength; step++) {
            const decision = decideRetry({
              classification: classification(category, true),
              failingModel: FAILED,
              native: { retry: true, delay: 100 },
              recovery: { kind: "switch", model: { providerID: "p" + String(step), id: "m" } },
              vetoesUsed,
            })
            if (decision.kind === "leave") {
              break
            }
            vetoesUsed++
            expect(vetoesUsed).toBeLessThanOrEqual(MAX_VETOES_PER_UNIT)
          }
          const atEnd: RetryInput = {
            classification: classification(category, true),
            failingModel: FAILED,
            native: { retry: true, delay: 100 },
            recovery: { kind: "switch", model: { providerID: "p", id: "m" } },
            vetoesUsed,
          }
          expect(decideRetry(atEnd).kind).toBe(vetoesUsed >= MAX_VETOES_PER_UNIT ? "leave" : "veto")
        },
      ),
      { numRuns: 200 },
    )
  })

  it("observe and control share the same core decision", () => {
    fc.assert(
      fc.property(fc.constantFrom(...OPERATING_MODES), (mode) => {
        const decision: RetryCoreDecision = { kind: "veto", model: REF }
        expect(forMode(decision, "active")).toBe(decision)
        if (mode === "observe") {
          const wrapped = forMode(decision, "observe")
          expect(wrapped.kind === "observe-only" && wrapped.would).toBe(decision)
        }
      }),
      { numRuns: 50 },
    )
  })
})
