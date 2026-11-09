// covers: ["ADP-004", "ADP-005", "ADP-063"]
import fc from "fast-check"
import { expect, it } from "vitest"
import { proposeTiers, type ProposalModel } from "../src/ui/proposal.js"

function model(id: string, cost: number, reasoning = false): ProposalModel {
  return {
    ref: { providerID: "configured", id },
    inputCost: cost,
    outputCost: cost,
    reasoning,
    contextWindow: 1000,
    thinkingLevels: reasoning ? ["off", "high"] : ["off"],
  }
}

it("proposes stable metadata-only thirds, with supported high thinking for advanced", () => {
  const models = [model("c", 3, true), model("a", 1), model("b", 2)]
  expect(proposeTiers(models)).toEqual({
    quick: [{ providerID: "configured", id: "a" }],
    standard: [{ providerID: "configured", id: "b" }],
    advanced: [{ providerID: "configured", id: "c", variant: "high" }],
  })
  expect(proposeTiers([...models].reverse())).toEqual(proposeTiers(models))
  expect(proposeTiers([])).toEqual({ quick: [], standard: [], advanced: [] })
  const large = Array.from({ length: 120 }, (_, index) =>
    model(String(index), index, index % 2 === 0),
  )
  expect(Object.values(proposeTiers(large)).every((tier) => tier.length === 32)).toBe(true)
  expect(proposeTiers([model("a", -1), model("b", NaN), model("c", 1)]).quick[0]?.id).toBe("c")
  expect(proposeTiers([model("b", 1), model("a", 1), model("b", 1)]).quick[0]?.id).toBe("a")
  expect(
    proposeTiers([
      model("a", 1),
      model("b", 2),
      { ...model("c", 3, true), thinkingLevels: ["off"] },
    ]).advanced[0]?.variant,
  ).toBeUndefined()
  const duplicate = [
    model("a", 1),
    { ...model("a", 1), contextWindow: 2000 },
    { ...model("a", 1), thinkingLevels: ["high"] },
    model("a", 1, true),
    model("b", 2),
    model("c", 3),
  ]
  expect(proposeTiers(duplicate)).toEqual(proposeTiers([...duplicate].reverse()))
  expect(
    proposeTiers([
      model("a", 1),
      model("b", 2),
      model("c", 3),
      model("d", 4),
      { ...model("e", 5), contextWindow: 2000 },
      model("f", 6),
    ]).advanced[0]?.id,
  ).toBe("e")
})

it("only uses supplied authenticated inventory, stays bounded, and is permutation-stable", () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { maxLength: 120 }), (ids) => {
      const models = ids.map((id) => model(String(id), id % 5, id % 2 === 0))
      const result = proposeTiers(models)
      expect(proposeTiers([...models].reverse())).toEqual(result)
      for (const tier of Object.values(result)) {
        expect(tier.length).toBeLessThanOrEqual(32)
        expect(new Set(tier.map((ref) => ref.id)).size).toBe(tier.length)
        expect(tier.every((ref) => models.some((m) => m.ref.id === ref.id))).toBe(true)
        if (models.length >= 3) expect(tier.length).toBeGreaterThan(0)
      }
    }),
    { numRuns: 200 },
  )
})
