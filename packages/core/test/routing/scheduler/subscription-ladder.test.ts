/**
 * Admission matrix for the three-resource subscription ladder this plugin is
 * operated with: a primary subscription (Anthropic Claude), a secondary
 * subscription (OpenAI Codex) and a paid per-credit fallback (OpenRouter
 * GLM). Every block-state permutation of the ladder is exercised so a goal
 * started on the ladder is routed to the highest resource that can still run
 * it — and parked, never misrouted, when none can (ADP-005, ADP-016,
 * ADP-019, ADP-021, ADP-022, ADP-038).
 */
// covers: ["ADP-005", "ADP-016", "ADP-019", "ADP-021", "ADP-022", "ADP-028", "ADP-038"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { Assessment } from "../../../src/health/resource-health/types.js"
import type { CapacitySignals } from "../../../src/health/capacity/types.js"
import { classifyFailure } from "../../../src/health/classifier/classify.js"
import { failureEvent } from "../../../src/health/index.js"
import { ResourceHealthRegistry } from "../../../src/health/resource-health/registry.js"
import { admit, forMode, schedulerHealthKey } from "../../../src/routing/scheduler/index.js"
import type { SchedulerInput } from "../../../src/routing/scheduler/types.js"
import type { ModelRef } from "../../../src/routing/work-unit/types.js"
import { candidateOf, inputOf, keyOf, ref } from "./helpers.js"

/** Top of the ladder: the first subscription (per-usage window resets). */
const SUB1 = ref("anthropic", "claude-sonnet-4")
/** Second subscription: consulted only while SUB1 is unavailable. */
const SUB2 = ref("openai", "codex-gpt-5")
/** Paid fallback: used only after both subscriptions are exhausted. */
const PAID = ref("openrouter", "glm-flash")
const LADDER = [SUB1, SUB2, PAID]

const RESET_SUB1 = 900_000
const RESET_SUB2 = 600_000
const RESET_PAID = 300_000

type Block = "ready" | "limited" | "spent" | "down" | "probe" | "drained"

function label(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

/**
 * Builds a scheduler input from a per-slot state. Limited/spent entries
 * carry their reset time (the slot's window end); an absent reset means an
 * indefinite block (an outage without a stated recovery).
 */
function ladderInput(states: {
  sub1: Block
  sub2: Block
  paid: Block
  sub1Reset?: number
  sub2Reset?: number
  paidReset?: number
}): SchedulerInput {
  const entries: [ModelRef, Block, number | undefined][] = [
    [SUB1, states.sub1, states.sub1Reset],
    [SUB2, states.sub2, states.sub2Reset],
    [PAID, states.paid, states.paidReset],
  ]
  const health: Record<string, Assessment> = {}
  const capacity: Record<string, CapacitySignals> = {}
  for (const [model, block, reset] of entries) {
    const slot = schedulerHealthKey(model)
    const key = keyOf(model)
    switch (block) {
      case "ready":
        health[slot] = { kind: "available" }
        break
      case "limited":
        health[slot] = {
          kind: "blocked",
          reason: "rate-limited",
          key,
          ...(reset !== undefined ? { retryAtMs: reset } : {}),
        }
        break
      case "spent":
        health[slot] = {
          kind: "blocked",
          reason: "quota-exhausted",
          key,
          ...(reset !== undefined ? { retryAtMs: reset } : {}),
        }
        break
      case "down":
        health[slot] = { kind: "blocked", reason: "unavailable", key }
        break
      case "probe":
        health[slot] = { kind: "probe", ticket: { id: `probe-${model.id}`, key } }
        break
      case "drained":
        capacity[slot] = { exhausted: true, draining: false }
        health[slot] = { kind: "available" }
        break
    }
  }
  return inputOf({
    inventory: LADDER.map((model) => candidateOf(model)),
    tierCandidates: LADDER,
    health,
    capacity,
  })
}

function applyModel(decision: ReturnType<typeof admit>): string {
  if (decision.kind !== "apply") return decision.kind
  return label(decision.model)
}

describe("subscription ladder — which resource runs while limits shift", () => {
  it("runs a fresh goal on the first subscription", () => {
    expect(applyModel(admit(ladderInput({ sub1: "ready", sub2: "ready", paid: "ready" })))).toBe(
      label(SUB1),
    )
  })

  it("keeps the second subscription ahead of the paid fallback", () => {
    expect(
      applyModel(
        admit(
          ladderInput({
            sub1: "spent",
            sub2: "ready",
            paid: "ready",
            sub1Reset: RESET_SUB1,
          }),
        ),
      ),
    ).toBe(label(SUB2))
  })

  it("uses the paid fallback only after both subscriptions are exhausted", () => {
    expect(
      applyModel(
        admit(
          ladderInput({
            sub1: "spent",
            sub2: "spent",
            paid: "ready",
            sub1Reset: RESET_SUB1,
            sub2Reset: RESET_SUB2,
          }),
        ),
      ),
    ).toBe(label(PAID))
  })

  it("returns to a subscription as soon as its limit lifted, ahead of paid", () => {
    expect(
      applyModel(
        admit(ladderInput({ sub1: "ready", sub2: "spent", paid: "ready", sub2Reset: RESET_SUB2 })),
      ),
    ).toBe(label(SUB1))
  })

  it("parks when every rung of the ladder is blocked", () => {
    const decision = admit(
      ladderInput({
        sub1: "spent",
        sub2: "spent",
        paid: "spent",
        sub1Reset: RESET_SUB1,
        sub2Reset: RESET_SUB2,
        paidReset: RESET_PAID,
      }),
    )
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "quota-exhausted,quota-exhausted,quota-exhausted",
    })
  })

  it.each([
    ["only sub2 is limited", "ready", "limited", "ready", "anthropic/claude-sonnet-4"],
    ["only paid is limited", "ready", "ready", "limited", "anthropic/claude-sonnet-4"],
    ["sub1 and sub2 limited", "limited", "limited", "ready", "openrouter/glm-flash"],
    ["sub1 and paid limited", "limited", "ready", "limited", "openai/codex-gpt-5"],
    ["sub2 and paid limited", "ready", "limited", "limited", "anthropic/claude-sonnet-4"],
  ] as const)("%s: skips straight to the highest ready rung", (_label, s1, s2, paid, expected) => {
    expect(applyModel(admit(ladderInput({ sub1: s1, sub2: s2, paid })))).toBe(expected)
  })

  it("a lapsed limit window counts as lifted: the subscription is re-admitted", () => {
    // Window expiry is the health registry's job (it sweeps before assess);
    // the scheduler consumes the already-swept assessment.
    const clock = { now: 1_000 }
    const registry = new ResourceHealthRegistry(() => clock.now)
    registry.observe(
      failureEvent(keyOf(SUB1), classifyFailure({ status: 429, headers: { "retry-after": "60" } })),
    )
    registry.observe(
      failureEvent(
        keyOf(SUB2),
        classifyFailure({ status: 402, headers: { "retry-after": "120" } }),
      ),
    )
    clock.now += 61_000
    const admission = (registry2: ResourceHealthRegistry) =>
      admit(
        inputOf({
          inventory: LADDER.map((model) => candidateOf(model)),
          tierCandidates: LADDER,
          health: {
            [schedulerHealthKey(SUB1)]: registry2.assess(keyOf(SUB1)),
            [schedulerHealthKey(SUB2)]: registry2.assess(keyOf(SUB2)),
          },
        }),
      )
    // The short rate-limit window has ended: the ladder returns to SUB1
    // while the credit window still holds SUB2 out.
    expect(admission(registry)).toMatchObject({ kind: "apply", model: SUB1 })
    clock.now += 59_000
    expect(admission(registry)).toMatchObject({ kind: "apply", model: SUB1 })
  })

  it("an outage without a reset window blocks a rung without a return date", () => {
    const decision = admit(ladderInput({ sub1: "down", sub2: "ready", paid: "ready" }))
    expect(decision).toMatchObject({ kind: "apply", model: SUB2, reason: "fallback" })
    if (decision.kind === "apply") {
      expect(decision.evidence.skipped).toContainEqual({
        ref: SUB1,
        why: "unavailable",
      })
    }
  })

  it("a subscription's due probe outranks the paid fallback", () => {
    // The subscription is mid-recovery (half-open): its single probe is the
    // next admission on the ladder, ahead of a healthy paid resource.
    expect(applyModel(admit(ladderInput({ sub1: "probe", sub2: "spent", paid: "ready" })))).toBe(
      label(SUB1),
    )
  })

  it("a probe offered while a later rung is ready still prefers the ladder order", () => {
    // The half-open rung comes first in the user's order, so the probe
    // outranks the ready fallback behind it.
    const decision = admit(ladderInput({ sub1: "probe", sub2: "ready", paid: "ready" }))
    expect(decision).toMatchObject({ kind: "apply", model: SUB1, reason: "probe" })
  })

  it("capacity exhaustion removes a rung without touching health", () => {
    expect(applyModel(admit(ladderInput({ sub1: "ready", sub2: "drained", paid: "ready" })))).toBe(
      label(SUB1),
    )
    expect(applyModel(admit(ladderInput({ sub1: "spent", sub2: "drained", paid: "ready" })))).toBe(
      label(PAID),
    )
  })

  it("every rung drained parks the goal rather than misrouting", () => {
    const decision = admit(ladderInput({ sub1: "drained", sub2: "drained", paid: "drained" }))
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "capacity-exhausted,capacity-exhausted,capacity-exhausted",
    })
  })

  it("draining is a last resort, ranked behind any ready rung", () => {
    const input = ladderInput({ sub1: "ready", sub2: "ready", paid: "ready" })
    const capacity: Record<string, CapacitySignals> = {
      [schedulerHealthKey(SUB1)]: { exhausted: false, draining: true },
      [schedulerHealthKey(SUB2)]: { exhausted: false, draining: true },
      [schedulerHealthKey(PAID)]: { exhausted: false, draining: true },
    }
    expect(admit({ ...input, capacity })).toMatchObject({
      kind: "apply",
      model: SUB1,
      reason: "draining",
    })
  })

  it("a rung missing from the inventory is unverifiable and never selected", () => {
    const decision = admit(
      inputOf({
        inventory: [candidateOf(SUB1), candidateOf(SUB2)],
        tierCandidates: LADDER,
        health: {
          [schedulerHealthKey(SUB1)]: {
            kind: "blocked",
            reason: "quota-exhausted",
            key: keyOf(SUB1),
            retryAtMs: RESET_SUB1,
          },
          [schedulerHealthKey(SUB2)]: {
            kind: "blocked",
            reason: "quota-exhausted",
            key: keyOf(SUB2),
            retryAtMs: RESET_SUB2,
          },
        },
      }),
    )
    // Paid cannot be verified to run the work: park, do not apply it blind.
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "quota-exhausted,quota-exhausted,not-in-inventory",
    })
  })

  it("a disabled paid variant never leaks in front of a ready subscription", () => {
    const decision = admit(
      inputOf({
        inventory: [
          candidateOf(SUB1, { enabled: false }),
          candidateOf(SUB2),
          candidateOf(PAID, { variantAvailable: false }),
        ],
        tierCandidates: LADDER,
      }),
    )
    expect(decision).toMatchObject({ kind: "apply", model: SUB2 })
  })

  it("a work demand the paid model cannot serve keeps the goal on the subscription", () => {
    const decision = admit(
      inputOf({
        demand: { contextTokens: 400_000 },
        inventory: [
          candidateOf(SUB1, { limit: { context: 400_000 } }),
          candidateOf(SUB2, { limit: { context: 400_000 } }),
          candidateOf(PAID, { limit: { context: 128_000 } }),
        ],
        tierCandidates: LADDER,
      }),
    )
    expect(decision).toMatchObject({ kind: "apply", model: SUB1 })
  })

  describe("pins — manual intent outranks the ladder", () => {
    it("a pinned paid fallback runs even while subscriptions are ready", () => {
      const decision = admit(
        inputOf({
          routing: { kind: "pin", model: PAID },
          inventory: LADDER.map((model) => candidateOf(model)),
          tierCandidates: LADDER,
        }),
      )
      expect(decision).toEqual({
        kind: "apply",
        model: PAID,
        tier: undefined,
        reason: "pin",
        evidence: { skipped: [] },
      })
    })

    it("a pinned resource out of credits parks the goal instead of borrowing a rung", () => {
      const decision = admit(
        inputOf({
          routing: { kind: "pin", model: PAID },
          inventory: LADDER.map((model) => candidateOf(model)),
          tierCandidates: LADDER,
          health: {
            [schedulerHealthKey(PAID)]: {
              kind: "blocked",
              reason: "quota-exhausted",
              key: keyOf(PAID),
            },
          },
        }),
      )
      expect(decision).toEqual({
        kind: "park",
        reason: "pin-blocked",
        detail: "quota-exhausted",
      })
    })

    it("a pinned draining resource still runs (manual intent wins)", () => {
      const decision = admit(
        inputOf({
          routing: { kind: "pin", model: PAID },
          inventory: LADDER.map((model) => candidateOf(model)),
          tierCandidates: LADDER,
          capacity: { [schedulerHealthKey(PAID)]: { exhausted: false, draining: true } },
        }),
      )
      expect(decision).toMatchObject({ kind: "apply", model: PAID, reason: "pin" })
    })
  })

  describe("modes — decisions the host must not act on", () => {
    it("OBSERVE records the identical ladder decision without applying it", () => {
      const decision = forMode(
        admit(ladderInput({ sub1: "spent", sub2: "ready", paid: "ready" })),
        "observe",
      )
      expect(decision).toMatchObject({
        kind: "observe-only",
        would: { kind: "apply", model: SUB2 },
      })
    })

    it("OFF defers regardless of the ladder state", () => {
      const decision = forMode(
        admit(ladderInput({ sub1: "ready", sub2: "ready", paid: "ready" })),
        "off",
      )
      expect(decision).toEqual({ kind: "defer", reason: "adaptive-off" })
    })
  })

  describe("property — the ladder never applies a blocked rung", () => {
    it("for every block-state combination the applied model is a usable one", () => {
      const blockArb = fc.constantFrom<Block>("ready", "limited", "spent", "down")
      const statesArb = fc
        .tuple(blockArb, blockArb, blockArb)
        .filter(([s1, s2, paid]) => s1 !== "ready" || s2 !== "ready" || paid !== "ready")
      fc.assert(
        fc.property(statesArb, ([s1, s2, paid]) => {
          const decision = admit(ladderInput({ sub1: s1, sub2: s2, paid }))
          if (decision.kind !== "apply") {
            expect(["park", "defer", "observe-only"]).toContain(decision.kind)
            return
          }
          const states = new Map([
            [label(SUB1), s1],
            [label(SUB2), s2],
            [label(PAID), paid],
          ])
          const block = states.get(label(decision.model))
          // Applied rungs are ready (or draining-as-last-resort, which the
          // input above never combines with ready rungs elsewhere).
          expect(block === "ready" || decision.reason === "draining").toBe(true)
          // Ladder fidelity: no lower rung is applied while a higher one is usable.
          const rank = new Map([
            [label(SUB1), 0],
            [label(SUB2), 1],
            [label(PAID), 2],
          ])
          const chosenRank = rank.get(label(decision.model))
          if (chosenRank === undefined || decision.reason === "draining") return
          const higher = [...states.entries()].filter(
            ([name]) => (rank.get(name) ?? 99) < chosenRank,
          )
          expect(higher.every(([, block]) => block !== "ready")).toBe(true)
        }),
      )
    })
  })
})
