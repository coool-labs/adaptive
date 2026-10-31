import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  AUXILIARY_KINDS,
  AUXILIARY_TIER,
  DEFAULT_TIER,
  isAuxiliary,
  nextTier,
  type RoutingInput,
  type RoutingDecision,
  type RoutingSource,
  type TierName,
  resolveRouting,
  TIERS,
  normalizeTierList,
} from "../../../src/core/tier-policy/index.js"
import { sameModelRef, type ModelRef } from "../../../src/core/work-unit/types.js"

const PIN: ModelRef = { providerID: "anthropic", id: "claude-x", variant: "high" }
const ALL_TIERS: readonly TierName[] = [...TIERS]

function input(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return { configuredTiers: ALL_TIERS, ...overrides }
}

describe("resolveRouting — pin level (ADP-002)", () => {
  it("wins over every lower level, including an explicit tier request", () => {
    const decision = resolveRouting(
      input({
        pin: PIN,
        tierRequest: { tier: "advanced", via: "manual-command" },
        agent: "build",
        requestKind: "title",
      }),
    )
    expect(decision).toEqual({ kind: "pin", model: PIN })
  })

  it("holds even when nothing is configured", () => {
    const decision = resolveRouting(input({ pin: PIN, configuredTiers: [] }))
    expect(decision).toEqual({ kind: "pin", model: PIN })
  })

  it("preserves a variantless pin as a distinct reference", () => {
    const bare: ModelRef = { providerID: "openai", id: "gpt-y" }
    expect(resolveRouting(input({ pin: bare }))).toEqual({ kind: "pin", model: bare })
  })
})

describe("resolveRouting — explicit tier request level", () => {
  it("resolves to the requested tier when configured", () => {
    for (const via of ["manual-command", "session-setting"] as const) {
      expect(resolveRouting(input({ tierRequest: { tier: "advanced", via } }))).toEqual({
        kind: "tier",
        tier: "advanced",
        source: "tier-request",
      })
    }
  })

  it("defers instead of borrowing when the requested tier has no resources", () => {
    const decision = resolveRouting(
      input({
        tierRequest: { tier: "standard", via: "manual-command" },
        configuredTiers: ["quick"],
      }),
    )
    expect(decision).toEqual({ kind: "defer", tier: "standard", reason: "tier-not-configured" })
  })

  it("an unhonorable request defers rather than falling through to lower levels", () => {
    const decision = resolveRouting(
      input({
        tierRequest: { tier: "advanced", via: "session-setting" },
        agent: "build",
        agentTiers: { build: "quick" },
        requestKind: "title",
        configuredTiers: ["quick", "standard"],
      }),
    )
    expect(decision).toEqual({ kind: "defer", tier: "advanced", reason: "tier-not-configured" })
  })
})

describe("resolveRouting — agent role hint level", () => {
  it("resolves a configured agent mapping to its tier", () => {
    expect(resolveRouting(input({ agent: "review", agentTiers: { review: "advanced" } }))).toEqual({
      kind: "tier",
      tier: "advanced",
      source: "agent-role",
    })
  })

  it("an unmapped agent is not a hint and falls to the default", () => {
    expect(resolveRouting(input({ agent: "build", agentTiers: { review: "advanced" } }))).toEqual({
      kind: "tier",
      tier: DEFAULT_TIER,
      source: "default",
    })
  })

  it("an empty agent name carries no hint", () => {
    expect(resolveRouting(input({ agent: "", agentTiers: { "": "advanced" } }))).toEqual({
      kind: "tier",
      tier: DEFAULT_TIER,
      source: "default",
    })
  })

  it("defers when the hinted tier has no resources", () => {
    const decision = resolveRouting(
      input({ agent: "build", agentTiers: { build: "quick" }, configuredTiers: ["standard"] }),
    )
    expect(decision).toEqual({ kind: "defer", tier: "quick", reason: "tier-not-configured" })
  })
})

describe("resolveRouting — deterministic auxiliary evidence level", () => {
  it("routes every auxiliary request kind to quick", () => {
    for (const kind of AUXILIARY_KINDS) {
      expect(resolveRouting(input({ requestKind: kind }))).toEqual({
        kind: "tier",
        tier: AUXILIARY_TIER,
        source: "auxiliary-request",
      })
    }
  })

  it("a primary request is not auxiliary evidence", () => {
    expect(resolveRouting(input({ requestKind: "primary" }))).toEqual({
      kind: "tier",
      tier: DEFAULT_TIER,
      source: "default",
    })
  })

  it("defers when quick has no resources instead of borrowing standard", () => {
    expect(resolveRouting(input({ requestKind: "title", configuredTiers: ["standard"] }))).toEqual({
      kind: "defer",
      tier: "quick",
      reason: "tier-not-configured",
    })
  })
})

describe("resolveRouting — ambiguity within a level (ADP-002)", () => {
  it("conflicting agent hint and auxiliary evidence resolves to standard", () => {
    const decision = resolveRouting(
      input({ agent: "build", agentTiers: { build: "advanced" }, requestKind: "title" }),
    )
    expect(decision).toEqual({ kind: "tier", tier: DEFAULT_TIER, source: "ambiguity" })
  })

  it("ambiguity still defers when standard is unconfigured", () => {
    const decision = resolveRouting(
      input({
        agent: "build",
        agentTiers: { build: "advanced" },
        requestKind: "title",
        configuredTiers: ["quick"],
      }),
    )
    expect(decision).toEqual({ kind: "defer", tier: DEFAULT_TIER, reason: "tier-not-configured" })
  })

  it("agreeing signals keep the tier with the more specific agent-role source", () => {
    const decision = resolveRouting(
      input({ agent: "build", agentTiers: { build: "quick" }, requestKind: "title" }),
    )
    expect(decision).toEqual({ kind: "tier", tier: "quick", source: "agent-role" })
  })
})

describe("resolveRouting — default level", () => {
  it("no signals resolves to standard", () => {
    expect(resolveRouting(input())).toEqual({
      kind: "tier",
      tier: DEFAULT_TIER,
      source: "default",
    })
  })

  it("defers on a fresh configuration with no resources anywhere", () => {
    expect(resolveRouting(input({ configuredTiers: [] }))).toEqual({
      kind: "defer",
      tier: DEFAULT_TIER,
      reason: "tier-not-configured",
    })
  })
})

describe("tier semantics", () => {
  it("escalation ladder is quick → standard → advanced with no next after advanced", () => {
    expect(nextTier("quick")).toBe("standard")
    expect(nextTier("standard")).toBe("advanced")
    expect(nextTier("advanced")).toBeUndefined()
  })

  it("auxiliary classification is exact", () => {
    expect(isAuxiliary("primary")).toBe(false)
    for (const kind of AUXILIARY_KINDS) {
      expect(isAuxiliary(kind)).toBe(true)
    }
  })
})

describe("resolveRouting — properties (fast-check)", () => {
  const tierArb = fc.constantFrom(...TIERS)
  const modelRefArb = fc.record({
    providerID: fc.constantFrom("anthropic", "openai"),
    id: fc.constantFrom("claude-x", "gpt-y"),
    variant: fc.option(fc.constantFrom("low", "high"), { nil: undefined }),
  })
  const inputArb = fc.record({
    pin: fc.option(modelRefArb, { nil: undefined }),
    tierRequest: fc.option(
      fc.record({ tier: tierArb, via: fc.constantFrom("manual-command", "session-setting") }),
      { nil: undefined },
    ),
    agent: fc.option(fc.constantFrom("build", "review"), { nil: undefined }),
    requestKind: fc.option(fc.constantFrom("primary", ...AUXILIARY_KINDS), { nil: undefined }),
    agentTiers: fc.option(fc.dictionary(fc.constantFrom("build", "review"), tierArb), {
      nil: undefined,
    }),
    configuredTiers: fc.array(tierArb),
  })

  // Oracle written from ADP-002/003 requirements, independent of resolve.ts.
  function expectedRouting(r: RoutingInput): RoutingDecision {
    if (r.pin !== undefined) {
      return { kind: "pin", model: r.pin }
    }
    const configured = (tier: TierName): boolean => r.configuredTiers.includes(tier)
    const asTier = (tier: TierName, source: RoutingSource): RoutingDecision =>
      configured(tier)
        ? { kind: "tier", tier, source }
        : { kind: "defer", tier, reason: "tier-not-configured" }
    if (r.tierRequest !== undefined) {
      return asTier(r.tierRequest.tier, "tier-request")
    }
    const agentTier =
      r.agent !== undefined && r.agent.length > 0 ? r.agentTiers?.[r.agent] : undefined
    const auxTier =
      r.requestKind !== undefined && r.requestKind !== "primary" ? AUXILIARY_TIER : undefined
    if (agentTier !== undefined && auxTier !== undefined && agentTier !== auxTier) {
      return asTier(DEFAULT_TIER, "ambiguity")
    }
    if (agentTier !== undefined) {
      return asTier(agentTier, "agent-role")
    }
    if (auxTier !== undefined) {
      return asTier(auxTier, "auxiliary-request")
    }
    return asTier(DEFAULT_TIER, "default")
  }

  it("matches the priority-ladder oracle for every input", () => {
    fc.assert(
      fc.property(inputArb, (r) => {
        expect(resolveRouting(r)).toEqual(expectedRouting(r))
      }),
    )
  })

  it("is total and deterministic", () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 0, max: 5 }), (r, seed) => {
        const first = resolveRouting(r)
        const again = seed >= 0 ? resolveRouting(r) : first
        expect(again).toEqual(first)
        expect(["pin", "tier", "defer"]).toContain(first.kind)
      }),
    )
  })

  it("tier decisions are always backed by configuration; defer never is", () => {
    fc.assert(
      fc.property(inputArb, (r) => {
        const decision = resolveRouting(r)
        if (decision.kind === "tier") {
          expect(r.configuredTiers).toContain(decision.tier)
        }
        if (decision.kind === "defer") {
          expect(r.configuredTiers).not.toContain(decision.tier)
        }
      }),
    )
  })
})

describe("normalizeTierList (ADP-005/006)", () => {
  it("preserves user order exactly", () => {
    const list: ModelRef[] = [
      { providerID: "openai", id: "gpt-y" },
      { providerID: "anthropic", id: "claude-x" },
    ]
    expect(normalizeTierList(list)).toEqual(list)
  })

  it("drops exact duplicates, keeping the first occurrence", () => {
    const first: ModelRef = { providerID: "openai", id: "gpt-y" }
    expect(normalizeTierList([first, { ...first }, first])).toEqual([first])
  })

  it("keeps provider-scoped look-alikes distinct (ADP-006)", () => {
    const a: ModelRef = { providerID: "openai", id: "gpt-y" }
    const b: ModelRef = { providerID: "other", id: "gpt-y" }
    const variant: ModelRef = { providerID: "openai", id: "gpt-y", variant: "high" }
    expect(normalizeTierList([a, b, variant])).toEqual([a, b, variant])
  })

  it("drops unusable entries without reordering the rest", () => {
    const keep: ModelRef = { providerID: "openai", id: "gpt-y" }
    expect(
      normalizeTierList([
        { providerID: "", id: "x" },
        keep,
        { providerID: "openai", id: "" },
        keep,
      ]),
    ).toEqual([keep])
  })

  it("normalizes an empty list to empty", () => {
    expect(normalizeTierList([])).toEqual([])
  })

  it("never mutates the input", () => {
    const list = [
      { providerID: "openai", id: "gpt-y" },
      { providerID: "openai", id: "gpt-y" },
    ]
    const snapshot = structuredClone(list)
    normalizeTierList(list)
    expect(list).toEqual(snapshot)
  })
})

describe("normalizeTierList — properties (fast-check)", () => {
  const refArb = fc.record({
    providerID: fc.oneof(fc.constant(""), fc.constantFrom("anthropic", "openai")),
    id: fc.oneof(fc.constant(""), fc.constantFrom("claude-x", "gpt-y")),
    variant: fc.option(fc.constantFrom("low", "high"), { nil: undefined }),
  })

  it("output is an order-preserving subsequence with no duplicates or unusable entries", () => {
    fc.assert(
      fc.property(fc.array(refArb), (list) => {
        const result = normalizeTierList(list)
        expect(result.length).toBeLessThanOrEqual(list.length)
        let cursor = 0
        for (const entry of result) {
          expect(entry.providerID.length).toBeGreaterThan(0)
          expect(entry.id.length).toBeGreaterThan(0)
          let found = -1
          for (let i = cursor; i < list.length; i += 1) {
            if (sameModelRef(list[i] as ModelRef, entry)) {
              found = i
              break
            }
          }
          expect(found).toBeGreaterThanOrEqual(0)
          cursor = found + 1
          expect(result.filter((other) => sameModelRef(other, entry))).toHaveLength(1)
        }
      }),
    )
  })

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.array(refArb), (list) => {
        expect(normalizeTierList(normalizeTierList(list))).toEqual(normalizeTierList(list))
      }),
    )
  })
})
