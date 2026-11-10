// covers: ["ADP-010", "ADP-011", "ADP-013", "ADP-015", "ADP-061", "ADP-065"]
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
import { FAILURE_CATEGORIES } from "@coool/adaptive-core/health/classifier/types"
import {
  CAPABILITY_FAILURE_CATEGORIES,
  MAX_ESCALATIONS_PER_TASK,
} from "@coool/adaptive-core/execution/escalation/index"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import { failureEvidence } from "../src/evidence.js"
import {
  CONTINUATION_TYPE,
  escalationAfterRun,
  MAX_RESTARTS_PER_TASK,
  parkingAfterRun,
  planRoute,
  restartAfterRun,
  type BranchEntry,
  type TaskState,
} from "../src/task.js"

interface CorpusEntry {
  readonly stopReason: string
  readonly errorMessage?: string
}

const corpus = JSON.parse(
  readFileSync(new URL("fixtures/pi-errors/1.5.0.json", import.meta.url), "utf8"),
) as readonly CorpusEntry[]

const ESCALATE = "adaptive_escalate"
const models = [
  { providerID: "local", id: "q" },
  { providerID: "local", id: "s" },
  { providerID: "local", id: "a" },
]
const [quick, standard, advanced] = models
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: {
    quick: quick ? [quick] : [],
    standard: standard ? [standard] : [],
    advanced: advanced ? [advanced] : [],
  },
}
const initial: TaskState = {
  version: 1,
  task: "task",
  unit: "unit",
  tier: "quick",
  escalations: 0,
  restarts: 0,
  tried: [],
}

function ids(): () => string {
  let next = 0
  return () => `id-${String(++next)}`
}

function routerState(state: TaskState): BranchEntry {
  return {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "adaptive", modelId: "auto", state },
  }
}

/** The branch Pi holds when a run settles on `entry`, served by the state's tier model. */
function settled(state: TaskState, entry: CorpusEntry): BranchEntry[] {
  const model = models[TIERS.indexOf(state.tier)]
  return [
    routerState(state),
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        ...(model === undefined ? {} : { provider: model.providerID, model: model.id }),
        stopReason: entry.stopReason,
        ...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
      },
    },
  ]
}

function afterRunInput(branch: BranchEntry[], newId: () => string) {
  return {
    id: "auto" as const,
    escalateFromPinned: false,
    settings,
    branch,
    available: models,
    tool: ESCALATE,
    newId,
  }
}

function decisions(state: TaskState, entry: CorpusEntry) {
  const input = afterRunInput(settled(state, entry), ids())
  return {
    escalation: escalationAfterRun(input),
    restart: restartAfterRun(input),
    parking: parkingAfterRun(input),
  }
}

function classified(entry: CorpusEntry) {
  return classifyFailure(failureEvidence(entry))
}

it("derives every recovery decision from the labelled Pi error corpus, never mixing the two kinds", () => {
  const seen = new Set<string>()
  const none = { escalation: undefined, restart: undefined, parking: undefined }
  for (const entry of corpus) {
    const classification = classified(entry)
    seen.add(classification.category)
    const label = `${classification.category}: ${entry.errorMessage ?? entry.stopReason}`
    const fresh = decisions(initial, entry)
    const spent = decisions({ ...initial, restarts: MAX_RESTARTS_PER_TASK }, entry)
    // Only stopReason "error" is evidence of anything: a user abort is not a failure.
    const failed = entry.stopReason === "error"
    const capability = failed && CAPABILITY_FAILURE_CATEGORIES.includes(classification.category)
    const infra = failed && classification.failoverEligible

    expect(fresh.escalation !== undefined, label).toBe(capability)
    expect(fresh.restart !== undefined, label).toBe(infra)
    // Parking only follows a spent restart budget, never a fresh task.
    expect(fresh.parking, label).toBeUndefined()
    expect(spent.parking !== undefined, label).toBe(infra)
    expect(spent.restart, label).toBeUndefined()
    if (!(capability || infra)) {
      expect(fresh, label).toEqual(none)
      expect(spent, label).toEqual(none)
    }
    // ADP-013: infrastructure evidence never changes the tier of the work.
    for (const recovery of [fresh.restart, spent.parking])
      if (recovery !== undefined) expect(recovery.tier, label).toBe(initial.tier)
    // Capability evidence moves exactly one tier up.
    if (fresh.escalation !== undefined) expect(fresh.escalation.tier, label).toBe("standard")

    const retry = planRoute({
      id: "auto",
      reason: "retry",
      state: initial,
      branch: [],
      failed: { model: quick ?? { providerID: "local", id: "q" }, message: entry },
      newId: ids(),
    })
    // A native retry re-admits within the tier only after infrastructure failure.
    expect(retry.tier, label).toBe(initial.tier)
    expect(retry.sticky, label).toBe(!infra)
    expect(retry.exclude.length, label).toBe(infra ? 1 : 0)
  }
  // The corpus must keep exercising every category the policy distinguishes.
  expect([...seen].sort()).toEqual([...FAILURE_CATEGORIES].sort())
})

/**
 * Simulates Pi settling runs one after another on whatever the corpus throws
 * at a single task, applying exactly the recovery chain `afterRun` applies
 * (escalate, else restart, else park) and the continuation that follows.
 */
function chain(entries: readonly CorpusEntry[]) {
  let state = initial
  const next = ids()
  const trace = { escalations: 0, restarts: 0, parks: 0, tiers: [state.tier] }
  for (const entry of entries) {
    const branch = settled(state, entry)
    const input = afterRunInput(branch, next)
    const escalation = escalationAfterRun(input)
    const recovery = escalation ?? restartAfterRun(input)
    if (recovery === undefined) {
      // Parking waits for a reset and ends the immediate chain; so does everything else.
      if (parkingAfterRun(input) !== undefined) trace.parks += 1
      break
    }
    if (escalation === undefined) trace.restarts += 1
    else trace.escalations += 1
    const continuation: BranchEntry = {
      type: "custom_message",
      customType: CONTINUATION_TYPE,
      details: recovery,
    }
    const unit = planRoute({
      id: "auto",
      reason: "continuation",
      state,
      branch: [...branch, continuation],
      newId: next,
    })
    if (unit.state === undefined) throw new Error("an owned continuation must start a unit")
    // A new unit may only move up a tier through a capability failure.
    if (escalation === undefined) expect(unit.state.tier).toBe(state.tier)
    expect(unit.state.task).toBe(state.task)
    state = unit.state
    trace.tiers.push(state.tier)
  }
  return trace
}

it("bounds immediate recovery per task and never lowers capability, whatever fails", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...corpus), { maxLength: 40 }), (entries) => {
      const trace = chain(entries)
      expect(trace.restarts).toBeLessThanOrEqual(MAX_RESTARTS_PER_TASK)
      expect(trace.escalations).toBeLessThanOrEqual(MAX_ESCALATIONS_PER_TASK)
      expect(trace.parks).toBeLessThanOrEqual(1)
      const ranks = trace.tiers.map((tier) => TIERS.indexOf(tier))
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
    }),
    { numRuns: 300 },
  )
})

it("never escalates a task whose every failure is infrastructure, however long it keeps failing", () => {
  const infrastructure = corpus.filter(
    (entry) => entry.stopReason === "error" && classified(entry).failoverEligible,
  )
  expect(infrastructure.length).toBeGreaterThan(3)
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...infrastructure), { minLength: 1, maxLength: 40 }),
      (entries) => {
        const trace = chain(entries)
        expect(trace.escalations).toBe(0)
        expect(new Set(trace.tiers)).toEqual(new Set(["quick"]))
        // Two restarts, then the chain ends on a park: nothing else is ever attempted.
        expect(trace.restarts).toBe(Math.min(entries.length, MAX_RESTARTS_PER_TASK))
      },
    ),
  )
})
