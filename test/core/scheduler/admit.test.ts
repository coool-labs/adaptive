/**
 * Unit scenarios for admission routing, one per decision kind and reason
 * (TASKS T-09). Fixtures in ./helpers.js.
 */
// covers: ["ADP-002", "ADP-003", "ADP-005", "ADP-016", "ADP-019", "ADP-021", "ADP-022", "ADP-028"]
import { describe, expect, it } from "vitest"
import { admit, schedulerHealthKey } from "../../../src/core/scheduler/index.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"
import type { Assessment } from "../../../src/health/resource-health/types.js"
import { candidateOf, inputOf, keyOf, ref } from "./helpers.js"

describe("admit — routing defer passes through", () => {
  it("defers with the routing reason as detail", () => {
    const decision = admit(
      inputOf({ routing: { kind: "defer", tier: "standard", reason: "tier-not-configured" } }),
    )
    expect(decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "tier-not-configured",
    })
  })
})

describe("admit — pin routing", () => {
  it("applies the pinned model even when tier candidates would rank others first", () => {
    const pin = ref("p", "pinned")
    const tierCandidate = ref("p", "other")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin), candidateOf(tierCandidate)],
        tierCandidates: [tierCandidate],
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: pin,
      reason: "pin",
      evidence: { skipped: [] },
    })
  })

  it("defers when the pin is not in the inventory (unverifiable)", () => {
    const decision = admit(inputOf({ routing: { kind: "pin", model: ref("p", "ghost") } }))
    expect(decision).toEqual({ kind: "defer", reason: "pin-unverifiable" })
  })

  it("defers when the pin cannot execute the work, with gate reasons as detail", () => {
    const pin = ref("p", "pinned")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin, { capabilities: { tools: false } })],
        demand: { tools: true },
      }),
    )
    expect(decision).toEqual({
      kind: "defer",
      reason: "pin-incompatible",
      detail: "tool-use-unsupported",
    })
  })

  it("parks when the pinned model is health-blocked, with the blocker as detail", () => {
    const pin = ref("p", "pinned")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin)],
        health: {
          [schedulerHealthKey(pin)]: {
            kind: "blocked",
            reason: "rate-limited",
            key: keyOf(pin),
            retryAtMs: 1_000,
          },
        },
      }),
    )
    expect(decision).toEqual({ kind: "park", reason: "pin-blocked", detail: "rate-limited" })
  })

  it("parks when the pinned model's capacity is exhausted", () => {
    const pin = ref("p", "pinned")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin)],
        capacity: { [schedulerHealthKey(pin)]: { exhausted: true, draining: false } },
      }),
    )
    expect(decision).toEqual({ kind: "park", reason: "pin-blocked", detail: "capacity-exhausted" })
  })

  it("applies a pinned model whose breaker is half-open, carrying the probe id", () => {
    const pin = ref("p", "pinned")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin)],
        health: {
          [schedulerHealthKey(pin)]: {
            kind: "probe",
            ticket: { id: "probe-1", key: keyOf(pin) },
          },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: pin,
      reason: "pin",
      evidence: { skipped: [], probeId: "probe-1" },
    })
  })

  it("applies a pinned draining model — manual intent wins", () => {
    const pin = ref("p", "pinned")
    const decision = admit(
      inputOf({
        routing: { kind: "pin", model: pin },
        inventory: [candidateOf(pin)],
        health: {
          [schedulerHealthKey(pin)]: {
            kind: "blocked",
            reason: "draining",
            key: keyOf(pin),
          },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: pin,
      reason: "pin",
      evidence: { skipped: [] },
    })
  })
})

describe("admit — tier routing", () => {
  it("applies the first candidate in user order when all are ready", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: a,
      tier: "standard",
      reason: "preferred",
      evidence: { skipped: [] },
    })
  })

  it("falls back past a health-blocked candidate and records it as skipped", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "blocked", reason: "rate-limited", key: keyOf(a) },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "rate-limited" }] },
    })
  })

  it("skips candidates missing from the inventory (inventory gate)", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(inputOf({ inventory: [candidateOf(b)], tierCandidates: [a, b] }))
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "not-in-inventory" }] },
    })
  })

  it("skips gate-incompatible candidates with the first gate reason", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        demand: { tools: true },
        inventory: [candidateOf(a, { capabilities: { tools: false } }), candidateOf(b)],
        tierCandidates: [a, b],
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "tool-use-unsupported" }] },
    })
  })

  it("skips capacity-exhausted candidates before health is even consulted", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        capacity: { [schedulerHealthKey(a)]: { exhausted: true, draining: false } },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "capacity-exhausted" }] },
    })
  })

  it("prefers a ready candidate over an earlier draining one (ADP-021)", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "blocked", reason: "draining", key: keyOf(a) },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "draining" }] },
    })
  })

  it("prefers a ready candidate over an earlier capacity-draining signal", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        capacity: { [schedulerHealthKey(a)]: { exhausted: false, draining: true } },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "draining" }] },
    })
  })

  it("treats an available assessment with no capacity signal as ready", () => {
    const a = ref("p", "a")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a)],
        tierCandidates: [a],
        health: { [schedulerHealthKey(a)]: { kind: "available" } },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: a,
      tier: "standard",
      reason: "preferred",
      evidence: { skipped: [] },
    })
  })

  it("marks an available candidate with a draining capacity signal as draining", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: { [schedulerHealthKey(a)]: { kind: "available" } },
        capacity: { [schedulerHealthKey(a)]: { exhausted: false, draining: true } },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "draining" }] },
    })
  })

  it("applies a draining candidate only when nothing better exists", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "blocked", reason: "rate-limited", key: keyOf(a) },
          [schedulerHealthKey(b)]: { kind: "blocked", reason: "draining", key: keyOf(b) },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "draining",
      evidence: { skipped: [{ ref: a, why: "rate-limited" }] },
    })
  })

  it("applies a probe candidate before draining ones", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "probe", ticket: { id: "probe-7", key: keyOf(a) } },
          [schedulerHealthKey(b)]: { kind: "blocked", reason: "draining", key: keyOf(b) },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: a,
      tier: "standard",
      reason: "probe",
      evidence: { skipped: [], probeId: "probe-7" },
    })
  })

  it("prefers a ready candidate over an earlier probe offering, recorded as evidence", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "probe", ticket: { id: "probe-7", key: keyOf(a) } },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "apply",
      model: b,
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: a, why: "probe-in-flight" }] },
    })
  })

  it("parks when the breaker probe candidate is capacity-exhausted", () => {
    const a = ref("p", "a")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a)],
        tierCandidates: [a],
        health: {
          [schedulerHealthKey(a)]: { kind: "probe", ticket: { id: "probe-7", key: keyOf(a) } },
        },
        capacity: { [schedulerHealthKey(a)]: { exhausted: true, draining: false } },
      }),
    )
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "capacity-exhausted",
    })
  })

  it("parks with all-blocked when every candidate is health-blocked", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        inventory: [candidateOf(a), candidateOf(b)],
        tierCandidates: [a, b],
        health: {
          [schedulerHealthKey(a)]: { kind: "blocked", reason: "rate-limited", key: keyOf(a) },
          [schedulerHealthKey(b)]: { kind: "blocked", reason: "breaker-open", key: keyOf(b) },
        },
      }),
    )
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "rate-limited,breaker-open",
    })
  })

  it("parks with no-compatible-resource when every candidate fails gate or inventory", () => {
    const a = ref("p", "a")
    const b = ref("p", "b")
    const decision = admit(
      inputOf({
        demand: { tools: true },
        inventory: [candidateOf(a, { capabilities: { tools: false } })],
        tierCandidates: [a, b],
      }),
    )
    expect(decision).toEqual({
      kind: "park",
      reason: "no-compatible-resource",
      detail: "tool-use-unsupported,not-in-inventory",
    })
  })

  it("parks with no-candidates when the configured tier has an empty list", () => {
    const decision = admit(inputOf({ tierCandidates: [] }))
    expect(decision).toEqual({ kind: "park", reason: "no-candidates" })
  })

  it("treats an absent health entry as ready (registry default)", () => {
    const a = ref("p", "a")
    const decision = admit(inputOf({ inventory: [candidateOf(a)], tierCandidates: [a] }))
    expect(decision).toEqual({
      kind: "apply",
      model: a,
      tier: "standard",
      reason: "preferred",
      evidence: { skipped: [] },
    })
  })

  it("bounds the skipped evidence list", () => {
    const many: ModelRef[] = []
    const inventory: ReturnType<typeof candidateOf>[] = []
    const health: Record<string, Assessment> = {}
    for (let index = 0; index < 10; index += 1) {
      const r = ref("p", `m${String(index)}`)
      many.push(r)
      inventory.push(candidateOf(r))
      health[schedulerHealthKey(r)] = { kind: "blocked", reason: "rate-limited", key: keyOf(r) }
    }
    const last = ref("p", "ready")
    inventory.push(candidateOf(last))
    const decision = admit(inputOf({ inventory, tierCandidates: [...many, last], health }))
    expect(decision.kind).toBe("apply")
    if (decision.kind !== "apply") {
      throw new Error("unreachable")
    }
    expect(decision.model).toEqual(last)
    expect(decision.evidence.skipped).toHaveLength(8)
    expect(decision.evidence.skipped[0]?.ref).toEqual(many[0])
    expect(decision.evidence.skipped[7]?.ref).toEqual(many[7])
  })

  it("bounds the park detail summary to three reasons", () => {
    const refs: ModelRef[] = []
    const inventory: ReturnType<typeof candidateOf>[] = []
    const health: Record<string, Assessment> = {}
    const reasons = ["rate-limited", "breaker-open", "unavailable", "quota-exhausted"] as const
    for (const [index, reason] of reasons.entries()) {
      const r = ref("p", `m${String(index)}`)
      refs.push(r)
      inventory.push(candidateOf(r))
      health[schedulerHealthKey(r)] = { kind: "blocked", reason, key: keyOf(r) }
    }
    const decision = admit(inputOf({ inventory, tierCandidates: refs, health }))
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "rate-limited,breaker-open,unavailable",
    })
  })
})

describe("schedulerHealthKey", () => {
  it("matches the resource-health key of the derived resource key", () => {
    expect(schedulerHealthKey(ref("p", "m"))).toBe(JSON.stringify(["p", null, "m", null]))
    expect(schedulerHealthKey(ref("p", "m", "high"))).toBe(JSON.stringify(["p", null, "m", "high"]))
  })
})
