// covers: ["ADP-014", "ADP-023"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { planContinuation } from "../../../src/execution/continuation/plan.js"
import type { RecoveryOption } from "../../../src/execution/retry/types.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"

function ref(providerID = "prov", id = "model", variant?: string): ModelRef {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

function switchRecovery(model: ModelRef): RecoveryOption {
  return { kind: "switch", model }
}

describe("planContinuation", () => {
  it("allows native recovery when Adaptive holds no recovery option", () => {
    expect(
      planContinuation({
        recovery: { kind: "none" },
        continuationPossible: true,
      }),
    ).toEqual({
      kind: "allow-native",
    })
  })

  it("keeps native recovery even when the in-session path is impossible", () => {
    expect(
      planContinuation({
        recovery: { kind: "none" },
        continuationPossible: false,
      }),
    ).toEqual({
      kind: "allow-native",
    })
  })

  it("plans an in-session continuation for owned recovery with a possible path", () => {
    const model = ref("p", "m", "high")
    expect(
      planContinuation({
        recovery: switchRecovery(model),
        continuationPossible: true,
      }),
    ).toEqual({ kind: "in-session", model })
  })

  it("never carries a probe id in the in-session plan (the supervisor owns tickets)", () => {
    const model = ref("p", "m")
    const planned = planContinuation({
      recovery: { kind: "switch", model, probeId: "probe-1" },
      continuationPossible: true,
    })
    expect(planned).toEqual({ kind: "in-session", model })
    expect("probeId" in planned).toBe(false)
  })

  it("plans a clean continuation when the in-session path is impossible", () => {
    const model = ref("p", "m")
    expect(
      planContinuation({
        recovery: switchRecovery(model),
        continuationPossible: false,
      }),
    ).toEqual({ kind: "clean-continuation" })
  })

  it("is deterministic", () => {
    const input = { recovery: switchRecovery(ref()), continuationPossible: true }
    expect(planContinuation(input)).toEqual(planContinuation(input))
  })
})

describe("planContinuation properties", () => {
  const recoveryArb: fc.Arbitrary<RecoveryOption> = fc
    .option(
      fc.record({
        providerID: fc.string({ minLength: 1 }),
        id: fc.string({ minLength: 1 }),
        variant: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      }),
      { nil: undefined },
    )
    .map((r) =>
      r === undefined
        ? { kind: "none" }
        : switchRecovery({ providerID: r.providerID, id: r.id, variant: r.variant }),
    )

  const inputArb = fc.record({
    recovery: recoveryArb,
    continuationPossible: fc.boolean(),
  })

  it("matches an independent oracle of the ADP-023 rules", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = planContinuation(input)
        if (input.recovery.kind === "none") {
          expect(action).toEqual({ kind: "allow-native" })
          return
        }
        if (input.continuationPossible) {
          expect(action).toEqual(
            input.recovery.probeId === undefined
              ? { kind: "in-session", model: input.recovery.model }
              : {
                  kind: "in-session",
                  model: input.recovery.model,
                  probeId: input.recovery.probeId,
                },
          )
          return
        }
        expect(action).toEqual({ kind: "clean-continuation" })
      }),
      { numRuns: 300 },
    )
  })

  it("never plans an owned continuation without a switch recovery", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const action = planContinuation(input)
        expect(action.kind === "allow-native").toBe(input.recovery.kind === "none")
        if (input.recovery.kind === "none") return
        expect(["in-session", "clean-continuation"]).toContain(action.kind)
        if (action.kind === "in-session") {
          expect(action.model).toEqual(input.recovery.model)
        }
      }),
      { numRuns: 300 },
    )
  })

  it("is total and deterministic", () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 1, max: 3 }), (input, repeats) => {
        const first = planContinuation(input)
        for (let i = 0; i < repeats; i++) expect(planContinuation(input)).toEqual(first)
      }),
      { numRuns: 200 },
    )
  })
})
