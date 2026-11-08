// covers: ["ADP-052", "ADP-053"]
import { describe, expect, it } from "vitest"
import { admit, schedulerHealthKey } from "../../../src/routing/scheduler/index.js"
import type { SchedulerInput } from "../../../src/routing/scheduler/index.js"
import type { CandidateModel } from "../../../src/routing/compatibility/types.js"
import type { ModelRef } from "../../../src/routing/work-unit/types.js"
import type { Assessment } from "../../../src/health/resource-health/types.js"
import type { CapacitySignals } from "../../../src/health/capacity/types.js"
import { candidateOf, inputOf, keyOf, ref } from "./helpers.js"

const TIERS = ["quick", "standard", "advanced"] as const
const MODEL_NAMES = ["alpha", "beta", "gamma"] as const

/**
 * A representative admission input: three configured tiers with three
 * resources each, mixed health states (blocked, half-open probe, ready) and
 * capacity signals, a tools+context demand, and default standard routing —
 * the shape every real admission decision evaluates.
 */
function representativeInput(): SchedulerInput {
  const inventory: CandidateModel[] = []
  const health: Record<string, Assessment> = {}
  const capacity: Record<string, CapacitySignals> = {}
  const tierLists = new Map<string, ModelRef[]>()
  for (const [tierIndex, tier] of TIERS.entries()) {
    const refs: ModelRef[] = []
    for (const [modelIndex, name] of MODEL_NAMES.entries()) {
      const model = ref("prov", `${tier}-${name}`)
      inventory.push(
        candidateOf(model, {
          limit: { context: 200_000 - tierIndex * 10_000 },
        }),
      )
      refs.push(model)
      // Rotate health states so the admission scan walks blocked and probe
      // candidates before reaching the ready one.
      const bucket = (tierIndex + modelIndex) % 3
      if (bucket === 0) {
        health[schedulerHealthKey(model)] = {
          kind: "blocked",
          reason: "rate-limited",
          key: keyOf(model),
        }
      } else if (bucket === 1) {
        health[schedulerHealthKey(model)] = {
          kind: "probe",
          ticket: {
            id: `probe-${String(tierIndex)}-${String(modelIndex)}`,
            key: keyOf(model),
          },
        }
      }
      if (modelIndex === MODEL_NAMES.length - 1) {
        capacity[schedulerHealthKey(model)] = { draining: true, exhausted: false }
      }
    }
    tierLists.set(tier, refs)
  }
  const standard = tierLists.get("standard") ?? []
  return inputOf({
    routing: { kind: "tier", tier: "standard", source: "default" },
    demand: { tools: true, contextTokens: 12_000 },
    inventory,
    tierCandidates: standard,
    health,
    capacity,
  })
}

describe("scheduler cost (ADP-052/ADP-053)", () => {
  it("runs hundreds of sequential admissions far under the pathological bound", () => {
    const input = representativeInput()
    const runs = 400
    const started = Date.now()
    let applied = 0
    for (let i = 0; i < runs; i++) {
      const decision = admit(input)
      if (decision.kind === "apply") applied++
    }
    const elapsedMs = Date.now() - started
    // Sanity: the fixture actually reaches an apply decision on every run
    // (the standard tier's second candidate is ready), so the loop measures
    // real routing work.
    expect(applied).toBe(runs)
    // Generous bound on purpose: this catches pathological overhead (an LLM
    // call, a large routing prompt, an accidental quadratic scan), not
    // nanoseconds (ADP-053 wording).
    expect(elapsedMs).toBeLessThan(2000)
  })
})
