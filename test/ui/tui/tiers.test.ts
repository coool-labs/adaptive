// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  healthTag,
  modelMatches,
  modelPickerOptions,
  moveResource,
  moveResourceToTop,
  removeResource,
  resourceLabel,
  tierEditorOptions,
  tierMenuOptions,
  validationMessage,
  variantOptions,
  type ModelSummary,
} from "../../../src/ui/tui/tiers.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc/status.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"
import { defaultSettings, type SettingsV1 } from "../../../src/state/settings/index.js"
import type { PatchResult } from "../../../src/state/settings/types.js"

function tierResource(providerID: string, id: string): TierResourceStatus {
  return {
    ref: ref(providerID, id),
    health: "healthy",
    breaker: "closed",
    windowed: false,
    windowUntil: null,
  }
}

function ref(providerID: string, id: string, variant?: string): ModelRef {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

describe("resourceLabel", () => {
  it("formats provider/model with an @variant suffix", () => {
    expect(resourceLabel(ref("prov", "m"))).toBe("prov/m")
    expect(resourceLabel(ref("prov", "m", "high"))).toBe("prov/m@high")
  })
})

describe("healthTag", () => {
  const base: TierResourceStatus = {
    ref: ref("p", "m"),
    health: "healthy",
    breaker: "closed",
    windowed: false,
    windowUntil: null,
  }

  it("is empty for healthy closed unwindowed resources and missing status", () => {
    expect(healthTag(undefined)).toBe("")
    expect(healthTag(base)).toBe("")
  })

  it("renders health, breaker, and window tags", () => {
    expect(healthTag({ ...base, health: "unavailable" })).toBe(" [unavailable]")
    expect(healthTag({ ...base, breaker: "open" })).toBe(" [breaker-open]")
    expect(healthTag({ ...base, breaker: "half_open" })).toBe(" [half-open]")
    expect(healthTag({ ...base, windowed: true })).toBe(" [windowed]")
    expect(healthTag({ ...base, health: "degraded", breaker: "open", windowed: true })).toBe(
      " [degraded, breaker-open, windowed]",
    )
  })
})

describe("tier menus", () => {
  it("tierMenuOptions shows per-tier counts", () => {
    const status: StatusSnapshot = {
      mode: "observe",
      pin: null,
      tiers: {
        quick: [tierResource("p", "a")],
        standard: [tierResource("p", "b"), tierResource("p", "c")],
        advanced: [],
      },
      parked: 0,
      receipts: 0,
    }
    expect(tierMenuOptions(status)).toEqual([
      { title: "quick (1)", value: "quick", description: "p/a" },
      { title: "standard (2)", value: "standard", description: "p/b · p/c" },
      {
        title: "advanced (0)",
        value: "advanced",
        description: "(empty — add models to enable routing)",
      },
    ])
  })

  it("tierEditorOptions lists add, tagged resources, and back", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, standard: [ref("prov", "a"), ref("prov", "b", "v")] },
    }
    const status: StatusSnapshot = {
      mode: "observe",
      pin: null,
      tiers: {
        quick: [],
        standard: [
          {
            ref: ref("prov", "a"),
            health: "unavailable",
            breaker: "closed",
            windowed: false,
            windowUntil: null,
          },
          {
            ref: ref("prov", "b", "v"),
            health: "healthy",
            breaker: "closed",
            windowed: false,
            windowUntil: null,
          },
        ],
        advanced: [],
      },
      parked: 0,
      receipts: 0,
    }
    const options = tierEditorOptions(settings, "standard", status)
    expect(options).toHaveLength(4)
    expect(options[0]?.title).toBe("Add model…")
    expect(options[1]?.title).toBe("prov/a [unavailable]")
    expect(options[2]?.title).toBe("prov/b@v")
    expect(options[3]?.title).toBe("Back")
    expect(options[1]?.value).toEqual({ kind: "resource", index: 0 })
  })

  it("tierEditorOptions works without a status snapshot", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, quick: [ref("p", "m")] },
    }
    const options = tierEditorOptions(settings, "quick", undefined)
    expect(options[1]?.title).toBe("p/m")
  })
})

describe("model search", () => {
  const gpt: ModelSummary = {
    providerID: "openai",
    modelID: "gpt-5",
    name: "GPT-5",
    variants: ["high", "low"],
  }
  const claude: ModelSummary = {
    providerID: "anthropic",
    modelID: "claude-x",
    name: "Claude X",
    variants: [],
  }
  const models: ModelSummary[] = [gpt, claude]

  it("matches provider, model id, or name case-insensitively; empty query matches all", () => {
    expect(modelMatches(gpt, "")).toBe(true)
    expect(modelMatches(gpt, "  ")).toBe(true)
    expect(modelMatches(gpt, "OPENAI")).toBe(true)
    expect(modelMatches(gpt, "gpt")).toBe(true)
    expect(modelMatches(gpt, "gpt-5")).toBe(true)
    expect(modelMatches(claude, "claude x")).toBe(true)
    expect(modelMatches(claude, "gpt")).toBe(false)
  })

  it("modelPickerOptions filters and maps to picks with names", () => {
    expect(modelPickerOptions(models, "anthro")).toEqual([
      {
        title: "anthropic/claude-x",
        description: "Claude X",
        value: { providerID: "anthropic", modelID: "claude-x" },
      },
    ])
    expect(modelPickerOptions(models, "")).toHaveLength(2)
    expect(modelPickerOptions(models, "zzz")).toEqual([])
  })

  it("search is total over arbitrary queries and model lists", () => {
    const arb = fc.array(
      fc.record({
        providerID: fc.string({ minLength: 1, maxLength: 6 }),
        modelID: fc.string({ minLength: 1, maxLength: 6 }),
        name: fc.string({ maxLength: 8 }),
        variants: fc.constant([]),
      }),
      { maxLength: 6 },
    )
    fc.assert(
      fc.property(arb, fc.string({ maxLength: 8 }), (list, query) => {
        const options = modelPickerOptions(list, query)
        const expected = list.filter((m) => modelMatches(m, query)).length
        expect(options).toHaveLength(expected)
        for (const option of options) {
          expect(typeof option.value.providerID).toBe("string")
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe("variantOptions", () => {
  it("offers the model default first, then every variant", () => {
    const options = variantOptions(["high", "low"])
    expect(options).toHaveLength(3)
    expect(options[0]).toEqual({ title: "(model default)", value: { variant: undefined } })
    expect(options[1]).toEqual({ title: "@high", value: { variant: "high" } })
    expect(options[2]).toEqual({ title: "@low", value: { variant: "low" } })
  })
})

describe("reorder and remove", () => {
  const list = [ref("p", "a"), ref("p", "b"), ref("p", "c")]

  it("moveResource swaps with the neighbour and no-ops at the edges", () => {
    expect(moveResource(list, 0, -1)).toEqual(list)
    expect(moveResource(list, 2, 1)).toEqual(list)
    expect(moveResource(list, 0, 1)).toEqual([ref("p", "b"), ref("p", "a"), ref("p", "c")])
    expect(moveResource(list, 1, -1)).toEqual([ref("p", "b"), ref("p", "a"), ref("p", "c")])
    expect(moveResource(list, -1, 1)).toEqual(list)
    expect(moveResource(list, 99, 1)).toEqual(list)
  })

  it("removeResource drops by index and no-ops out of bounds", () => {
    expect(removeResource(list, 1)).toEqual([ref("p", "a"), ref("p", "c")])
    expect(removeResource(list, -1)).toEqual(list)
    expect(removeResource(list, 3)).toEqual(list)
  })

  it("never mutates the input and preserves order otherwise", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ providerID: fc.string({ minLength: 1 }), id: fc.string({ minLength: 1 }) }),
          { maxLength: 5 },
        ),
        fc.nat(6),
        (refs, rawIndex) => {
          const index = rawIndex - 1
          const frozen = [...refs]
          const moved = moveResource(frozen, index, 1)
          expect(frozen).toEqual(refs)
          if (index >= 0 && index < refs.length - 1) {
            expect(moved[index + 1]).toEqual(refs[index])
          } else {
            expect(moved).toEqual(refs)
          }
          const removed = removeResource(frozen, index)
          expect(frozen).toEqual(refs)
          expect(removed).toHaveLength(
            index >= 0 && index < refs.length ? refs.length - 1 : refs.length,
          )
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe("moveResourceToTop", () => {
  it("moves the picked resource to the front and keeps the rest in order", () => {
    const refs = [ref("p", "a"), ref("p", "b"), ref("p", "c")]
    expect(moveResourceToTop(refs, 2)).toEqual([ref("p", "c"), ref("p", "a"), ref("p", "b")])
  })

  it("is a no-op copy for an out-of-bounds index", () => {
    const refs = [ref("p", "a"), ref("p", "b")]
    expect(moveResourceToTop(refs, 5)).toEqual(refs)
    expect(moveResourceToTop(refs, -1)).toEqual(refs)
  })
})

describe("validationMessage", () => {
  it("is undefined for a valid result and joins errors otherwise", () => {
    const ok: PatchResult = { ok: true, settings: defaultSettings() }
    expect(validationMessage(ok)).toBeUndefined()
    const bad: PatchResult = { ok: false, errors: ["invalid mode", "invalid pin"] }
    expect(validationMessage(bad)).toBe("invalid mode; invalid pin")
  })
})
