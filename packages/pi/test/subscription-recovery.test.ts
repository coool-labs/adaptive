/**
 * Subscription-first recovery in Pi: with a Claude subscription, an OpenAI
 * subscription, and a paid OpenRouter model configured in one tier, every
 * admission drains the subscriptions before the paid rung, keeps an in-unit
 * request stuck to its physical model, resumes at the top when a limit is
 * lifted, and shares one health picture across Pi processes so a limit hit in
 * one session steers the next admission in another.
 */

// covers: ["ADP-002", "ADP-005", "ADP-009", "ADP-010", "ADP-011", "ADP-013", "ADP-017", "ADP-019", "ADP-022", "ADP-057", "ADP-059"]

import { describe, expect, it } from "vitest"
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
import type { Assessment } from "@coool/adaptive-core/health/resource-health/types"
import type { BlockedReason } from "@coool/adaptive-core/health/resource-health/types"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { assessCandidates, observeOutcome, releaseUnselected, withHealth } from "../src/health.js"
import { routeAdmission, type RouteInput } from "../src/router.js"
import { memoryFile } from "./memory-file.js"

const claude: ModelRef = { providerID: "anthropic", id: "claude-sonnet-4" }
const codex: ModelRef = { providerID: "openai", id: "codex-gpt-5" }
const glm: ModelRef = { providerID: "openrouter", id: "glm-flash" }
const glmMini: ModelRef = { providerID: "openrouter", id: "glm-flash-mini" }

const TIER: readonly ModelRef[] = [claude, codex, glm]

const refOf = (r: ModelRef) => ({
  providerID: r.providerID,
  modelID: r.id,
  enabled: true,
  providerEnabled: true,
  variantAvailable: true,
})

function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  const settings = {
    ...defaultSettings(),
    mode: "active" as const,
    tiers: { quick: [], standard: TIER, advanced: [] },
  }
  return {
    tier: "standard",
    sticky: false,
    previous: undefined,
    settings,
    inventory: TIER.map(refOf),
    demand: {},
    health: {},
    capacity: {},
    exclude: [],
    ...overrides,
  }
}

const blockedOn = (ref: ModelRef, reason: BlockedReason = "quota-exhausted"): Assessment => ({
  kind: "blocked",
  reason,
  key: { providerID: ref.providerID, modelID: ref.id },
})

const quota = (ref: ModelRef): Record<string, Assessment> => ({
  [schedulerHealthKey(ref)]: blockedOn(ref),
})

/** Two processes over one shared health file, with independent clocks/ids. */
function sharedProcesses() {
  let now = 1000
  let probes = 0
  const shared = {
    file: memoryFile(),
    clock: () => now,
    newId: () => {
      probes += 1
      return `probe-${String(probes)}`
    },
  }
  const advance = (ms: number) => {
    now += ms
  }
  return {
    shared,
    get now() {
      return now
    },
    advance,
  }
}

describe("routeAdmission — subscription-first three-provider ladder", () => {
  it("opens a fresh goal on the top subscription", () => {
    expect(routeAdmission(routeInput())).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "preferred",
    })
  })

  it("walks down to the second subscription when the first is out of quota, naming the skip", () => {
    const decision = routeAdmission(routeInput({ health: quota(claude) }))
    expect(decision).toMatchObject({ kind: "apply", model: codex, reason: "fallback" })
    if (decision.kind !== "apply") return
    expect(decision.evidence.skipped).toEqual([{ ref: claude, why: "quota-exhausted" }])
  })

  it("walks to the paid OpenRouter rung only after both subscriptions are out", () => {
    const decision = routeAdmission(routeInput({ health: { ...quota(claude), ...quota(codex) } }))
    expect(decision).toMatchObject({ kind: "apply", model: glm, reason: "fallback" })
    if (decision.kind !== "apply") return
    expect(decision.evidence.skipped.map((skip) => skip.ref)).toEqual([claude, codex])
  })

  it("never spends the paid rung while a subscription can take the work", () => {
    const health = {
      [schedulerHealthKey(codex)]: blockedOn(codex, "rate-limited"),
      [schedulerHealthKey(glm)]: blockedOn(glm),
    }
    expect(routeAdmission(routeInput({ health }))).toMatchObject({
      kind: "apply",
      model: claude,
    })
  })

  it("blocks on every rung with the mixed reasons that put them there", () => {
    const health = {
      [schedulerHealthKey(claude)]: blockedOn(claude, "rate-limited"),
      [schedulerHealthKey(codex)]: blockedOn(codex, "unavailable"),
      [schedulerHealthKey(glm)]: blockedOn(glm, "breaker-open"),
    }
    expect(routeAdmission(routeInput({ health }))).toMatchObject({
      kind: "park",
      reason: "all-blocked",
      detail: "rate-limited,unavailable,breaker-open",
    })
  })

  it("returns to the top subscription on the next admission once its limit lifts", () => {
    // Mid-goal both subscriptions were out and the goal ran on the paid rung;
    // the lifted window simply disappears from the health map.
    expect(routeAdmission(routeInput({ health: quota(codex) }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "preferred",
    })
  })

  it("routes around a capacity-drained subscription without health evidence", () => {
    const decision = routeAdmission(
      routeInput({
        capacity: { [schedulerHealthKey(claude)]: { exhausted: true, draining: false } },
      }),
    )
    expect(decision).toMatchObject({ kind: "apply", model: codex, reason: "fallback" })
    if (decision.kind !== "apply") return
    expect(decision.evidence.skipped).toEqual([{ ref: claude, why: "capacity-exhausted" }])
  })
})

describe("routeAdmission — same-tier recovery excludes the models this unit already failed on", () => {
  it("skips an excluded but recovered subscription in favour of the next rung", () => {
    expect(routeAdmission(routeInput({ exclude: [claude] }))).toMatchObject({
      kind: "apply",
      model: codex,
    })
    expect(routeAdmission(routeInput({ exclude: [claude, codex] }))).toMatchObject({
      kind: "apply",
      model: glm,
    })
  })

  it("hands a fully-excluded unit back to Pi's own backoff via the failed model", () => {
    // Nothing untried is left, so the failed model stays eligible — Pi's
    // retry decides, not the health map.
    expect(routeAdmission(routeInput({ exclude: TIER }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "preferred",
    })
  })

  it("still refuses an excluded model that health keeps blocking", () => {
    const health = { ...quota(claude), ...quota(codex), ...quota(glm) }
    expect(routeAdmission(routeInput({ exclude: [claude], health }))).toMatchObject({
      kind: "park",
      reason: "all-blocked",
      detail: "quota-exhausted,quota-exhausted,quota-exhausted",
    })
  })
})

describe("routeAdmission — in-unit stickiness", () => {
  it("keeps a request on the paid rung it started on, even though subscriptions recovered", () => {
    // No mid-unit pull-away: the goal began on glm when both subs were out;
    // a tool continuation afterwards must not be repriced onto claude.
    expect(routeAdmission(routeInput({ sticky: true, previous: glm }))).toMatchObject({
      kind: "apply",
      model: glm,
      reason: "pin",
    })
  })

  it("keeps a request on its subscription through later rung failures", () => {
    expect(routeAdmission(routeInput({ sticky: true, previous: claude }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "pin",
    })
  })

  it("parks an in-unit request whose physical model just went out", () => {
    expect(
      routeAdmission(routeInput({ sticky: true, previous: claude, health: quota(claude) })),
    ).toMatchObject({ kind: "park", reason: "pin-blocked", detail: "quota-exhausted" })
  })

  it("stays on tier routing when the unit has no previous model yet", () => {
    expect(routeAdmission(routeInput({ sticky: true }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "preferred",
    })
  })
})

describe("shared health across Pi processes — one session's limit steers another's admission", () => {
  it("carries a 429 from the process that suffered it into the next admission", async () => {
    const { shared } = sharedProcesses()
    await withHealth(shared, (registry) => {
      observeOutcome(registry, claude, {
        stopReason: "error",
        errorMessage: "429 Too Many Requests",
      })
    })
    const { health } = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(health[schedulerHealthKey(claude)]).toMatchObject({
      kind: "blocked",
      reason: "rate-limited",
    })
    expect(routeAdmission(routeInput({ health }))).toMatchObject({
      kind: "apply",
      model: codex,
      reason: "fallback",
    })
  })

  it("widens an OpenRouter credit depletion to every OpenRouter model", async () => {
    const { shared } = sharedProcesses()
    await withHealth(shared, (registry) => {
      observeOutcome(registry, glm, {
        stopReason: "error",
        errorMessage: "Insufficient credits",
      })
    })
    const wider: readonly ModelRef[] = [claude, codex, glm, glmMini]
    const { health } = await withHealth(shared, (registry) => assessCandidates(registry, wider))
    expect(health[schedulerHealthKey(glm)]).toMatchObject({
      kind: "blocked",
      reason: "quota-exhausted",
    })
    // The sibling never failed itself: provider-scoped evidence blocks it too.
    expect(health[schedulerHealthKey(glmMini)]).toMatchObject({
      kind: "blocked",
      reason: "quota-exhausted",
    })
    expect(routeAdmission(routeInput({ health, inventory: wider.map(refOf) }))).toMatchObject({
      kind: "apply",
      model: claude,
    })
    // With the subscriptions out too, the goal parks rather than touching
    // either OpenRouter rung.
    expect(
      routeAdmission(
        routeInput({
          health: { ...health, ...quota(claude), ...quota(codex) },
          inventory: wider.map(refOf),
        }),
      ),
    ).toMatchObject({ kind: "park", reason: "all-blocked" })
  })

  it("admits exactly one probe across processes and keeps the rest out", async () => {
    const { shared, advance } = sharedProcesses()
    await withHealth(shared, (registry) => {
      for (let i = 0; i < 5; i++)
        observeOutcome(registry, claude, {
          stopReason: "error",
          errorMessage: "503 Service Unavailable",
        })
    })
    advance(31_000)
    // Process B trips the due breaker and holds the single probe ticket…
    const second = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(second.tickets).toHaveLength(1)
    expect(second.health[schedulerHealthKey(claude)]).toMatchObject({ kind: "probe" })
    expect(routeAdmission(routeInput({ health: second.health }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "probe",
    })
    // …while process C, assessing the same file, sees the probe in flight.
    const third = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(third.tickets).toHaveLength(0)
    expect(third.health[schedulerHealthKey(claude)]).toMatchObject({
      kind: "blocked",
      reason: "probe-in-flight",
    })
  })

  it("returns an undispatched probe so the next process can try again", async () => {
    const { shared, advance } = sharedProcesses()
    await withHealth(shared, (registry) => {
      for (let i = 0; i < 5; i++)
        observeOutcome(registry, claude, {
          stopReason: "error",
          errorMessage: "503 Service Unavailable",
        })
    })
    advance(31_000)
    await withHealth(shared, (registry) => {
      const { tickets } = assessCandidates(registry, TIER)
      const first = tickets[0]
      releaseUnselected(registry, tickets, codex)
      return first?.id
    })
    const after = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(after.tickets).toHaveLength(1)
  })

  it("treats a successful outcome as evidence from any breaker state", async () => {
    const { shared } = sharedProcesses()
    await withHealth(shared, (registry) => {
      for (let i = 0; i < 5; i++)
        observeOutcome(registry, claude, {
          stopReason: "error",
          errorMessage: "503 Service Unavailable",
        })
    })
    const classification = await withHealth(shared, (registry) => {
      const outcome = observeOutcome(registry, claude, { stopReason: "stop" })
      return {
        outcome,
        record: registry.recordFor({ providerID: claude.providerID, modelID: claude.id }),
      }
    })
    expect(classification.outcome).toBeUndefined()
    expect(classification.record).toMatchObject({ health: "healthy" })
  })

  it("never records the user's abort as provider evidence", async () => {
    const { shared } = sharedProcesses()
    const outcome = await withHealth(shared, (registry) =>
      observeOutcome(registry, claude, { stopReason: "aborted" }),
    )
    expect(outcome).toBeUndefined()
    const { health } = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(health[schedulerHealthKey(claude)]).toEqual({ kind: "available" })
  })

  it("reads an out-of-credits reply as a provider-wide quota exhaustion", async () => {
    const { shared } = sharedProcesses()
    const outcome = await withHealth(shared, (registry) =>
      observeOutcome(registry, glm, {
        stopReason: "error",
        errorMessage: "Out of credits",
      }),
    )
    expect(outcome).toMatchObject({ category: "quota_exhausted", quotaScope: "provider" })
  })

  it("chains three processes down the ladder and parks when everyone is out", async () => {
    const { shared, advance } = sharedProcesses()
    // Session A exhausts the top subscription.
    await withHealth(shared, (registry) => {
      observeOutcome(registry, claude, {
        stopReason: "error",
        errorMessage: "Out of credits",
      })
    })
    // Session B is steered to the second subscription, then exhausts it too.
    const second = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(routeAdmission(routeInput({ health: second.health }))).toMatchObject({
      model: codex,
    })
    await withHealth(shared, (registry) => {
      observeOutcome(registry, codex, {
        stopReason: "error",
        errorMessage: "Model quota exhausted",
      })
    })
    // Session C falls to the paid rung, then exhausts it as well.
    const third = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(routeAdmission(routeInput({ health: third.health }))).toMatchObject({
      model: glm,
    })
    await withHealth(shared, (registry) => {
      observeOutcome(registry, glm, {
        stopReason: "error",
        errorMessage: "Insufficient credits",
      })
    })
    const fourth = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(routeAdmission(routeInput({ health: fourth.health }))).toMatchObject({
      kind: "park",
      reason: "all-blocked",
    })
    // The windows lapse; the top subscription is admitted again with no
    // operator involvement.
    advance(900_001)
    const fifth = await withHealth(shared, (registry) => assessCandidates(registry, TIER))
    expect(routeAdmission(routeInput({ health: fifth.health }))).toMatchObject({
      kind: "apply",
      model: claude,
      reason: "preferred",
    })
  })
})

describe("classification feeding the shared picture", () => {
  it("maps an HTTP 429 without Retry-After to the default rate-limit window", () => {
    expect(classifyFailure({ status: 429, headers: {} })).toMatchObject({
      category: "rate_limited",
    })
  })

  it("maps HTTP 402 to a provider-scoped quota exhaustion", () => {
    expect(classifyFailure({ status: 402 })).toMatchObject({
      category: "quota_exhausted",
      quotaScope: "provider",
    })
  })

  it("maps HTTP 401 to a window-less authentication refusal", () => {
    expect(classifyFailure({ status: 401 })).toMatchObject({ category: "auth_failure" })
  })

  it("lets the registry, not the classifier, apply the default 429 window", async () => {
    const { shared } = sharedProcesses()
    await withHealth(shared, (registry) => {
      observeOutcome(registry, claude, {
        stopReason: "error",
        errorMessage: "429 Too Many Requests",
      })
      const record = registry.recordFor({ providerID: claude.providerID, modelID: claude.id })
      expect(record?.window).toEqual({ kind: "rate-limit", until: 31_000 })
    })
  })
})
