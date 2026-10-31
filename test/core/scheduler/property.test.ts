/**
 * Scheduler property suite (ADP-038): the scheduling invariants hold over
 * arbitrary inputs. Oracles come from ./helpers.js, written independently
 * from the implementation.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { checkCompatibility } from "../../../src/core/compatibility/gate.js"
import type { CandidateModel } from "../../../src/core/compatibility/types.js"
import { nextTier, TIERS } from "../../../src/core/tier-policy/types.js"
import {
  admit,
  ESCALATION_EVIDENCE_KINDS,
  forMode,
  planEscalation,
  schedulerHealthKey,
} from "../../../src/core/scheduler/index.js"
import type {
  Decision,
  EscalationInput,
  SchedulerInput,
} from "../../../src/core/scheduler/index.js"
import { sameModelRef, type ModelRef } from "../../../src/core/work-unit/types.js"
import type { Assessment } from "../../../src/health/resource-health/types.js"
import type { CapacitySignals } from "../../../src/health/capacity/types.js"
import {
  generatedCandidateArb,
  demandArb,
  inputOf,
  modelRefArb,
  oracleBucket,
  refIdentity,
  type GeneratedCandidate,
} from "./helpers.js"

function entryFor(
  inventory: readonly CandidateModel[],
  model: ModelRef,
): CandidateModel | undefined {
  return inventory.find((candidate) =>
    sameModelRef(model, {
      providerID: candidate.providerID,
      id: candidate.modelID,
      variant: candidate.variant,
    }),
  )
}

function inputFrom(
  pool: readonly GeneratedCandidate[],
  overrides: Partial<SchedulerInput>,
): SchedulerInput {
  const health: Record<string, Assessment> = {}
  const capacity: Record<string, CapacitySignals> = {}
  for (const g of pool) {
    if (g.assessment !== undefined) {
      health[schedulerHealthKey(g.ref)] = g.assessment
    }
    if (g.signals !== undefined) {
      capacity[schedulerHealthKey(g.ref)] = g.signals
    }
  }
  return inputOf({
    inventory: pool.map((g) => g.candidate),
    tierCandidates: pool.map((g) => g.ref),
    health,
    capacity,
    ...overrides,
  })
}

/** Shared invariant checks over any admission decision. */
function checkInvariants(input: SchedulerInput, decision: Decision, routing: "tier" | "pin"): void {
  // Availability failures never escalate capability: admission never escalates.
  expect(decision.kind).not.toBe("escalate")
  if (decision.kind === "apply") {
    const entry = entryFor(input.inventory, decision.model)
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(checkCompatibility(entry, input.demand).compatible).toBe(true)
    }
    const key = schedulerHealthKey(decision.model)
    const bucket = oracleBucket(input.health[key], input.capacity[key])
    expect(["ready", "probe", "draining"]).toContain(bucket)
    if (routing === "tier") {
      // No silent downward capability shift: the applied model belongs to the
      // required tier's configured list.
      expect(input.tierCandidates.some((r) => sameModelRef(r, decision.model))).toBe(true)
      // Draining is never chosen while an equivalent healthy resource exists.
      if (decision.reason === "draining") {
        const anyReady = input.tierCandidates.some(
          (r) =>
            oracleBucket(
              input.health[schedulerHealthKey(r)],
              input.capacity[schedulerHealthKey(r)],
            ) === "ready",
        )
        expect(anyReady).toBe(false)
      }
    } else {
      // User pin wins: an applied pin decision is exactly the pin.
      expect(input.routing.kind).toBe("pin")
      if (input.routing.kind === "pin") {
        expect(sameModelRef(decision.model, input.routing.model)).toBe(true)
      }
    }
  }
  if (decision.kind === "park" && routing === "tier" && input.tierCandidates.length > 0) {
    // Parking means nothing usable — every candidate is unverifiable,
    // incompatible, or hard-skipped.
    for (const r of input.tierCandidates) {
      const entry = entryFor(input.inventory, r)
      if (entry === undefined) {
        continue
      }
      if (!checkCompatibility(entry, input.demand).compatible) {
        continue
      }
      const bucket = oracleBucket(
        input.health[schedulerHealthKey(r)],
        input.capacity[schedulerHealthKey(r)],
      )
      expect(bucket.startsWith("skip:")).toBe(true)
    }
  }
  // Determinism.
  expect(admit(input)).toEqual(decision)
  // Observe and Control produce identical decisions (ADP-038).
  expect(forMode(decision, "control")).toBe(decision)
  const observed = forMode(decision, "observe")
  expect(observed.kind).toBe("observe-only")
  if (observed.kind === "observe-only") {
    expect(observed.would).toBe(decision)
  }
}

describe("admit properties — tier routing", () => {
  it("holds every scheduling invariant over arbitrary tier inputs", () => {
    const prop = fc.property(
      fc.uniqueArray(generatedCandidateArb, {
        minLength: 0,
        maxLength: 4,
        selector: (g) => refIdentity(g.ref),
      }),
      demandArb,
      fc.constantFrom(...TIERS),
      fc.boolean(),
      (pool, demand, tier, withDefer) => {
        const routing = withDefer
          ? ({ kind: "defer", tier, reason: "tier-not-configured" } as const)
          : ({ kind: "tier", tier, source: "default" } as const)
        const input = inputFrom(pool, { routing, demand })
        checkInvariants(input, admit(input), "tier")
      },
    )
    expect(fc.check(prop, { numRuns: 300 }).failed).toBe(false)
  })
})

describe("admit properties — pin routing", () => {
  it("holds every scheduling invariant over arbitrary pin inputs", () => {
    const prop = fc.property(
      fc.uniqueArray(generatedCandidateArb, {
        minLength: 0,
        maxLength: 4,
        selector: (g) => refIdentity(g.ref),
      }),
      modelRefArb,
      demandArb,
      fc.boolean(),
      (pool, arbitraryPin, demand, usePool) => {
        const first = pool[0]
        const pin = usePool && first !== undefined ? first.ref : arbitraryPin
        const input = inputFrom(pool, { routing: { kind: "pin", model: pin }, demand })
        const decision = admit(input)
        if (decision.kind === "apply") {
          // Pin wins: an applied pin decision is exactly the pin.
          expect(sameModelRef(decision.model, pin)).toBe(true)
        } else {
          const entry = entryFor(input.inventory, pin)
          if (entry === undefined) {
            expect(decision).toEqual({ kind: "defer", reason: "pin-unverifiable" })
          } else if (!checkCompatibility(entry, input.demand).compatible) {
            expect(decision.kind).toBe("defer")
            expect(decision.reason).toBe("pin-incompatible")
          } else {
            expect(decision.kind).toBe("park")
            expect(decision.reason).toBe("pin-blocked")
          }
        }
        checkInvariants(input, decision, "pin")
      },
    )
    expect(fc.check(prop, { numRuns: 300 }).failed).toBe(false)
  })
})

describe("planEscalation properties", () => {
  const ladderArb = fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 4 })

  function escalationArb(): fc.Arbitrary<EscalationInput> {
    return ladderArb.chain((ladder) =>
      fc
        .record({
          variantPos: fc.option(fc.nat(Math.max(0, ladder.length - 1)), { nil: undefined }),
          tier: fc.constantFrom(...TIERS),
          budgetMax: fc.nat(6),
          kind: fc.constantFrom(...ESCALATION_EVIDENCE_KINDS),
          nextResources: fc.array(modelRefArb, { maxLength: 3 }),
        })
        .map(({ variantPos, tier, budgetMax, kind, nextResources }): EscalationInput => ({
          currentModel:
            ladder.length > 0 && variantPos !== undefined
              ? { providerID: "p", id: "m", variant: ladder[variantPos] }
              : { providerID: "p", id: "m" },
          currentTier: tier,
          variantLadder: ladder,
          nextTierResources: nextResources,
          evidence: [{ kind, detail: "structured evidence" }],
          budget: { used: 0, max: budgetMax },
        })),
    )
  }

  it("only escalates strictly upward with bounded evidence and budget", () => {
    const prop = fc.property(escalationArb(), (input) => {
      const decision = planEscalation(input)
      if (decision.kind !== "escalate") {
        expect(decision.kind).toBe("defer")
        return
      }
      expect(decision.evidence.length).toBeLessThanOrEqual(4)
      expect(decision.budgetRemaining).toBe(input.budget.max - input.budget.used - 1)
      expect(decision.budgetRemaining).toBeGreaterThanOrEqual(0)
      const currentTierIndex = TIERS.indexOf(input.currentTier)
      const targetTierIndex = TIERS.indexOf(decision.tier)
      expect(targetTierIndex).toBeGreaterThanOrEqual(currentTierIndex)
      if (decision.step === "variant") {
        // Same model, strictly stronger variant on the ladder.
        expect(decision.tier).toBe(input.currentTier)
        expect(decision.target.providerID).toBe(input.currentModel.providerID)
        expect(decision.target.id).toBe(input.currentModel.id)
        const current = input.currentModel.variant
        expect(current).toBeDefined()
        const ladder = input.variantLadder ?? []
        if (current !== undefined) {
          const next = ladder[ladder.indexOf(current) + 1]
          expect(decision.target.variant).toBe(next)
          expect(ladder.indexOf(decision.target.variant ?? "")).toBeGreaterThan(
            ladder.indexOf(current),
          )
        }
      } else {
        // Next tier, first configured resource in user order.
        expect(decision.tier).toBe(nextTier(input.currentTier))
        expect(input.currentTier).not.toBe("advanced")
        const first = input.nextTierResources[0]
        expect(first).toBeDefined()
        expect(decision.target).toEqual(first)
      }
    })
    expect(fc.check(prop, { numRuns: 300 }).failed).toBe(false)
  })

  it("terminates within the budget and the structural ladder bound", () => {
    const prop = fc.property(escalationArb(), (start) => {
      let used = 0
      let tier = start.currentTier
      let model = start.currentModel
      let ladder: readonly string[] | undefined = start.variantLadder
      let steps = 0
      for (;;) {
        const decision = planEscalation({
          currentModel: model,
          currentTier: tier,
          variantLadder: ladder,
          nextTierResources: [{ providerID: "next", id: "resource" }],
          evidence: [{ kind: "repeated-failure", detail: "structured" }],
          budget: { used, max: start.budget.max },
        })
        if (decision.kind !== "escalate") {
          break
        }
        steps += 1
        used += 1
        if (decision.step === "tier") {
          tier = decision.tier
          ladder = undefined
        }
        model = decision.target
        expect(used).toBeLessThanOrEqual(start.budget.max)
        expect(steps).toBeLessThanOrEqual(Math.max(1, start.variantLadder?.length ?? 0) + 2)
      }
      expect(steps).toBeLessThanOrEqual(start.budget.max)
    })
    expect(fc.check(prop, { numRuns: 300 }).failed).toBe(false)
  })
})
