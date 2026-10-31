import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  checkCompatibility,
  filterCompatible,
  type CandidateModel,
  type Demand,
  type IncompatibilityReason,
} from "../../../src/core/compatibility/index.js"

const GOOD: CandidateModel = {
  providerID: "anthropic",
  modelID: "claude-x",
  enabled: true,
  providerEnabled: true,
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  limit: { context: 200_000 },
}

function candidate(overrides: Partial<CandidateModel> = {}): CandidateModel {
  return { ...GOOD, ...overrides }
}

function demand(overrides: Partial<Demand> = {}): Demand {
  return { ...overrides }
}

describe("availability checks", () => {
  it("accepts a fully available model with no demand", () => {
    expect(checkCompatibility(candidate(), demand())).toEqual({ compatible: true, reasons: [] })
  })

  it("rejects a disabled model", () => {
    expect(checkCompatibility(candidate({ enabled: false }), demand()).reasons).toEqual([
      "model-unavailable",
    ])
  })

  it("rejects an unavailable provider", () => {
    expect(checkCompatibility(candidate({ providerEnabled: false }), demand()).reasons).toEqual([
      "provider-unavailable",
    ])
  })

  it("treats unknown availability conservatively", () => {
    const verdict = checkCompatibility(
      candidate({ enabled: undefined, providerEnabled: undefined }),
      demand(),
    )
    expect(verdict.compatible).toBe(false)
    expect(verdict.reasons).toEqual(["provider-unavailable", "model-unavailable"])
  })
})

describe("variant checks", () => {
  it("accepts an existing requested variant", () => {
    const verdict = checkCompatibility(
      candidate({ variant: "high", variantAvailable: true }),
      demand(),
    )
    expect(verdict.compatible).toBe(true)
  })

  it("rejects an unknown requested variant existence conservatively", () => {
    expect(
      checkCompatibility(candidate({ variant: "high", variantAvailable: undefined }), demand())
        .reasons,
    ).toEqual(["variant-unavailable"])
  })

  it("rejects a nonexistent variant", () => {
    expect(
      checkCompatibility(candidate({ variant: "high", variantAvailable: false }), demand()).reasons,
    ).toEqual(["variant-unavailable"])
  })

  it("imposes no variant requirement without one", () => {
    expect(checkCompatibility(candidate({ variantAvailable: false }), demand()).reasons).toEqual([])
  })
})

describe("tool-use checks", () => {
  it("rejects tools demand against a non-tool model", () => {
    const verdict = checkCompatibility(
      candidate({ capabilities: { tools: false } }),
      demand({ tools: true }),
    )
    expect(verdict.reasons).toEqual(["tool-use-unsupported"])
  })

  it("rejects tools demand against unknown tool support conservatively", () => {
    const verdict = checkCompatibility(
      candidate({ capabilities: undefined }),
      demand({ tools: true }),
    )
    expect(verdict.reasons).toEqual(["tool-use-unsupported"])
  })

  it("imposes no tool requirement when the demand does not state one", () => {
    expect(
      checkCompatibility(candidate({ capabilities: { tools: false } }), demand({ tools: false }))
        .compatible,
    ).toBe(true)
    expect(checkCompatibility(candidate({ capabilities: undefined }), demand()).compatible).toBe(
      true,
    )
  })
})

describe("modality checks", () => {
  it("rejects a demanded input modality the model does not accept", () => {
    const verdict = checkCompatibility(candidate(), demand({ input: ["text", "audio"] }))
    expect(verdict.reasons).toEqual(["input-modality-unsupported"])
  })

  it("rejects a demanded output modality the model does not produce", () => {
    const verdict = checkCompatibility(candidate(), demand({ output: ["image"] }))
    expect(verdict.reasons).toEqual(["output-modality-unsupported"])
  })

  it("rejects unknown modality metadata conservatively", () => {
    const verdict = checkCompatibility(
      candidate({ capabilities: undefined }),
      demand({ input: ["text"] }),
    )
    expect(verdict.reasons).toEqual(["input-modality-unsupported"])
  })

  it("an empty demand list imposes no requirement", () => {
    expect(
      checkCompatibility(candidate({ capabilities: undefined }), demand({ input: [], output: [] }))
        .compatible,
    ).toBe(true)
  })
})

describe("context-capacity checks", () => {
  it("accepts a limit that fits the demand", () => {
    expect(checkCompatibility(candidate(), demand({ contextTokens: 123_456 })).compatible).toBe(
      true,
    )
  })

  it("accepts an exact-boundary limit", () => {
    expect(checkCompatibility(candidate(), demand({ contextTokens: 200_000 })).compatible).toBe(
      true,
    )
  })

  it("rejects a limit smaller than the demand", () => {
    expect(
      checkCompatibility(candidate({ limit: { context: 1000 } }), demand({ contextTokens: 1001 }))
        .reasons,
    ).toEqual(["context-capacity-insufficient"])
  })

  it("rejects unknown limit metadata conservatively", () => {
    const noLimit = checkCompatibility(
      candidate({ limit: undefined }),
      demand({ contextTokens: 10 }),
    )
    expect(noLimit.reasons).toEqual(["context-capacity-unknown"])
    const noField = checkCompatibility(candidate({ limit: {} }), demand({ contextTokens: 10 }))
    expect(noField.reasons).toEqual(["context-capacity-unknown"])
  })

  it("skips the capacity check entirely on unknown demand", () => {
    const d = demand({ contextTokens: undefined })
    expect(checkCompatibility(candidate({ limit: undefined }), d).compatible).toBe(true)
    const invalid = demand({ contextTokens: -1 })
    expect(checkCompatibility(candidate({ limit: undefined }), invalid).compatible).toBe(true)
    const notFinite = demand({ contextTokens: Number.POSITIVE_INFINITY })
    expect(checkCompatibility(candidate({ limit: undefined }), notFinite).compatible).toBe(true)
    const nan = demand({ contextTokens: Number.NaN })
    expect(checkCompatibility(candidate({ limit: undefined }), nan).compatible).toBe(true)
  })
})

describe("reason accumulation", () => {
  it("collects all failures in the fixed check order", () => {
    const verdict = checkCompatibility(
      candidate({
        providerEnabled: false,
        enabled: false,
        variant: "high",
        variantAvailable: false,
        capabilities: { tools: false, input: [], output: [] },
        limit: { context: 5 },
      }),
      demand({ tools: true, input: ["text"], output: ["text"], contextTokens: 100 }),
    )
    expect(verdict.reasons).toEqual([
      "provider-unavailable",
      "model-unavailable",
      "variant-unavailable",
      "tool-use-unsupported",
      "input-modality-unsupported",
      "output-modality-unsupported",
      "context-capacity-insufficient",
    ])
  })

  it("is compatible exactly when no reason applies", () => {
    const verdict = checkCompatibility(
      candidate(),
      demand({ tools: true, input: ["image"], output: ["text"] }),
    )
    expect(verdict).toEqual({ compatible: true, reasons: [] })
  })
})

describe("filterCompatible", () => {
  it("keeps order and drops incompatible candidates", () => {
    const a = candidate({ modelID: "a" })
    const b = candidate({ modelID: "b", enabled: false })
    const c = candidate({ modelID: "c" })
    expect(filterCompatible([a, b, c], demand())).toEqual([a, c])
  })

  it("returns empty for an empty candidate list", () => {
    expect(filterCompatible([], demand({ tools: true }))).toEqual([])
  })
})

describe("properties (fast-check)", () => {
  const candidateArb: fc.Arbitrary<CandidateModel> = fc.record({
    providerID: fc.constantFrom("anthropic", "openai"),
    modelID: fc.constantFrom("claude-x", "gpt-y"),
    variant: fc.option(fc.constantFrom("low", "high"), { nil: undefined }),
    enabled: fc.option(fc.boolean(), { nil: undefined }),
    providerEnabled: fc.option(fc.boolean(), { nil: undefined }),
    variantAvailable: fc.option(fc.boolean(), { nil: undefined }),
    capabilities: fc.option(
      fc.record({
        tools: fc.option(fc.boolean(), { nil: undefined }),
        input: fc.option(fc.array(fc.constantFrom("text", "image", "audio")), { nil: undefined }),
        output: fc.option(fc.array(fc.constantFrom("text", "image")), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    limit: fc.option(
      fc.record({ context: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }) }),
      { nil: undefined },
    ),
  })
  const demandArb: fc.Arbitrary<Demand> = fc.record({
    tools: fc.option(fc.boolean(), { nil: undefined }),
    input: fc.option(fc.array(fc.constantFrom("text", "image", "audio")), { nil: undefined }),
    output: fc.option(fc.array(fc.constantFrom("text", "image")), { nil: undefined }),
    contextTokens: fc.option(fc.integer({ min: -1, max: 1_000_000 }), { nil: undefined }),
  })

  it("is total and deterministic", () => {
    fc.assert(
      fc.property(candidateArb, demandArb, (c, d) => {
        expect(checkCompatibility(c, d)).toEqual(checkCompatibility(c, d))
        expect(typeof checkCompatibility(c, d).compatible).toBe("boolean")
      }),
    )
  })

  it("never mutates its inputs", () => {
    fc.assert(
      fc.property(candidateArb, demandArb, (c, d) => {
        const cSnapshot = structuredClone(c)
        const dSnapshot = structuredClone(d)
        checkCompatibility(c, d)
        expect(c).toEqual(cSnapshot)
        expect(d).toEqual(dSnapshot)
      }),
    )
  })

  it("conservative rule: fully unknown metadata never satisfies a stated requirement", () => {
    const unknown: CandidateModel = { providerID: "p", modelID: "m" }
    fc.assert(
      fc.property(demandArb, (d) => {
        // Availability metadata is unknown, so the candidate is rejected for
        // every demand — stated requirements or not.
        expect(checkCompatibility(unknown, d).compatible).toBe(false)
      }),
    )
  })

  it("monotonicity: compatible under a demand stays compatible under a weaker demand", () => {
    fc.assert(
      fc.property(candidateArb, demandArb, (c, d) => {
        if (checkCompatibility(c, d).compatible) {
          const weaker: Demand = {
            tools: d.tools === true ? undefined : d.tools,
            input: d.input === undefined ? undefined : [],
            output: d.output === undefined ? undefined : [],
            contextTokens: undefined,
          }
          expect(checkCompatibility(c, weaker).compatible).toBe(true)
        }
      }),
    )
  })

  it("reasons are always drawn from the fixed vocabulary and sorted by check order", () => {
    fc.assert(
      fc.property(candidateArb, demandArb, (c, d) => {
        const verdict = checkCompatibility(c, d)
        expect(new Set(verdict.reasons).size).toBe(verdict.reasons.length)
        const order: IncompatibilityReason[] = [
          "provider-unavailable",
          "model-unavailable",
          "variant-unavailable",
          "tool-use-unsupported",
          "input-modality-unsupported",
          "output-modality-unsupported",
          "context-capacity-insufficient",
          "context-capacity-unknown",
        ]
        const positions = verdict.reasons.map((reason) => order.indexOf(reason))
        expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      }),
    )
  })
})
