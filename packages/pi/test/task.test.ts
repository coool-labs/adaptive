import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import {
  branchState,
  CONTINUATION_TYPE,
  escalationAfterRun,
  parseTaskState,
  pendingRecovery,
  planRoute,
  restartAfterRun,
  tierRequest,
  unitEvidence,
  type BranchEntry,
  type TaskState,
} from "../src/task.js"

const ESCALATE = "adaptive_escalate"
const quick = { providerID: "local", id: "q" }
const standard = { providerID: "local", id: "s" }
const advanced = { providerID: "local", id: "a" }
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: { quick: [quick], standard: [standard], advanced: [advanced] },
}
const state: TaskState = {
  version: 1,
  task: "t1",
  unit: "u1",
  tier: "standard",
  escalations: 0,
  restarts: 0,
  tried: [],
}

function ids(): () => string {
  let next = 0
  return () => {
    next += 1
    return `id-${String(next)}`
  }
}
function routerState(id: string, value: unknown): BranchEntry {
  return {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "adaptive", modelId: id, state: value },
  }
}
const user: BranchEntry = { type: "message", message: { role: "user" } }
function toolResult(toolName: string, details: unknown): BranchEntry {
  return { type: "message", message: { role: "toolResult", toolName, details } }
}
function failure(errorMessage?: string, extra: object = {}): BranchEntry {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider: "local",
      model: "s",
      stopReason: "error",
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...extra,
    },
  }
}
function continuation(details: unknown): BranchEntry {
  return { type: "custom_message", customType: CONTINUATION_TYPE, details }
}
const overflow = "prompt is too long: 250000 tokens > 200000 maximum"

it("parses persisted task state and names the malformed field", () => {
  expect(parseTaskState(undefined)).toBeUndefined()
  expect(parseTaskState(state)).toEqual(state)
  expect(parseTaskState({ ...state, consumed: "k" })).toEqual({ ...state, consumed: "k" })
  expect(() => parseTaskState(null)).toThrow("Adaptive task state: version must be 1")
  expect(() => parseTaskState({ ...state, version: 2 })).toThrow("version must be 1")
  expect(() => parseTaskState({ ...state, consumed: "" })).toThrow(
    "consumed must be a non-empty string",
  )
  expect(() => parseTaskState({ ...state, consumed: 3 })).toThrow("consumed")
  expect(() => parseTaskState({ ...state, task: "" })).toThrow("task must be a non-empty string")
  expect(() => parseTaskState({ ...state, unit: 1 })).toThrow("unit must be a non-empty string")
  expect(() => parseTaskState({ ...state, tier: "ultra" })).toThrow(
    "tier must be quick, standard, or advanced",
  )
  expect(() => parseTaskState({ ...state, tier: 1 })).toThrow("tier must be")
  for (const escalations of [-1, 1.5, "1"])
    expect(() => parseTaskState({ ...state, escalations })).toThrow(
      "escalations must be a non-negative integer",
    )
  expect(() => parseTaskState({ ...state, restarts: -1 })).toThrow(
    "restarts must be a non-negative integer",
  )
  expect(() => parseTaskState({ ...state, tried: undefined })).toThrow("tried must be an array")
  expect(() => parseTaskState({ ...state, tried: [{ providerID: "local" }] })).toThrow(
    "Adaptive task state: tried[0]: id must be a non-empty string",
  )
  expect(() => parseTaskState({ ...state, tried: [standard, "s"] })).toThrow(
    "tried[1]: providerID must be a non-empty string",
  )
  expect(parseTaskState({ ...state, tried: [standard] })).toEqual({ ...state, tried: [standard] })
})

it("reads the latest router state of the matching virtual model only", () => {
  const later = { ...state, unit: "u2" }
  const branch = [
    routerState("auto", state),
    routerState("quick", { ...state, tier: "quick" }),
    {
      type: "custom",
      customType: "pi.virtual-model-state",
      data: { provider: "x", modelId: "auto" },
    },
    { type: "custom", customType: "other", data: { provider: "adaptive", modelId: "auto" } },
    routerState("auto", later),
  ]
  expect(branchState(branch, "auto")).toEqual(later)
  expect(branchState(branch, "quick")?.tier).toBe("quick")
  expect(branchState(branch, "advanced")).toBeUndefined()
  expect(branchState([], "auto")).toBeUndefined()
})

it("keeps the latest valid tier request on the branch", () => {
  expect(tierRequest([])).toBeUndefined()
  expect(
    tierRequest([
      toolResult("adaptive_tier", { tier: "advanced" }),
      toolResult("adaptive_tier", { tier: "ultra" }),
      toolResult("adaptive_tier", {}),
      toolResult("other", { tier: "quick" }),
      { type: "message", message: { role: "assistant", details: { tier: "quick" } } },
    ]),
  ).toBe("advanced")
})

it("accepts only our latest unconsumed continuation for the current task", () => {
  const recovery = {
    task: "t1",
    token: "k1",
    tier: "advanced",
    escalations: 1,
    restarts: 0,
    tried: [],
  }
  expect(pendingRecovery([continuation(recovery)], undefined)).toBeUndefined()
  expect(pendingRecovery([], state)).toBeUndefined()
  expect(pendingRecovery([continuation(recovery)], state)).toEqual(recovery)
  // A later conversation entry (user prompt, another extension) invalidates it.
  expect(pendingRecovery([continuation(recovery), user], state)).toBeUndefined()
  expect(
    pendingRecovery(
      [continuation(recovery), { type: "custom_message", customType: "other" }],
      state,
    ),
  ).toBeUndefined()
  // Non-conversation entries (router state, labels) do not.
  expect(pendingRecovery([continuation(recovery), routerState("auto", state)], state)).toEqual(
    recovery,
  )
  expect(pendingRecovery([continuation(recovery)], { ...state, task: "t2" })).toBeUndefined()
  expect(pendingRecovery([continuation(recovery)], { ...state, consumed: "k1" })).toBeUndefined()
  expect(() => pendingRecovery([continuation({ ...recovery, token: "" })], state)).toThrow(
    "Adaptive continuation: token must be a non-empty string",
  )
})

it("plans user prompts as new tasks with the base tier", () => {
  const steered = [toolResult("adaptive_tier", { tier: "advanced" })]
  expect(planRoute({ id: "auto", reason: "user", state, branch: [], newId: ids() })).toEqual({
    tier: "standard",
    sticky: false,
    exclude: [],
    state: {
      version: 1,
      task: "id-1",
      unit: "id-2",
      tier: "standard",
      escalations: 0,
      restarts: 0,
      tried: [],
    },
  })
  expect(
    planRoute({ id: "auto", reason: "user", state: undefined, branch: steered, newId: ids() }).tier,
  ).toBe("advanced")
  // A pinned virtual model is a user pin: tier requests never override it.
  expect(
    planRoute({ id: "quick", reason: "user", state: undefined, branch: steered, newId: ids() })
      .tier,
  ).toBe("quick")
})

it("keeps continuations, retries and direct calls in the current unit", () => {
  const escalated = { ...state, tier: "advanced" as const }
  const continued = planRoute({
    id: "auto",
    reason: "continuation",
    state: escalated,
    branch: [],
    newId: ids(),
  })
  expect(continued).toEqual({ tier: "advanced", sticky: true, exclude: [], state: escalated })
  expect(continued.state).toBe(escalated)
  expect(
    planRoute({ id: "quick", reason: "retry", state: undefined, branch: [], newId: ids() }),
  ).toEqual({ tier: "quick", sticky: true, exclude: [], state: undefined })
  expect(planRoute({ id: "advanced", reason: "direct", state, branch: [], newId: ids() })).toEqual({
    tier: "quick",
    sticky: false,
    exclude: [],
    state,
  })
})

it("turns an owned continuation into a new unit of the same task exactly once", () => {
  const branch = [
    continuation({
      task: "t1",
      token: "k1",
      tier: "advanced",
      escalations: 1,
      restarts: 1,
      tried: [standard],
    }),
  ]
  const plan = planRoute({ id: "auto", reason: "continuation", state, branch, newId: ids() })
  expect(plan).toEqual({
    tier: "advanced",
    sticky: false,
    exclude: [standard],
    state: {
      version: 1,
      task: "t1",
      unit: "id-1",
      tier: "advanced",
      escalations: 1,
      restarts: 1,
      tried: [standard],
      consumed: "k1",
    },
  })
  const again = planRoute({
    id: "auto",
    reason: "continuation",
    state: plan.state,
    branch,
    newId: ids(),
  })
  expect(again).toEqual({ tier: "advanced", sticky: true, exclude: [], state: plan.state })
  // A retry of the continued request never re-consumes the token.
  expect(planRoute({ id: "auto", reason: "retry", state, branch, newId: ids() }).sticky).toBe(true)
})

it("collects escalation requests of the current unit only", () => {
  const request = { reason: "too hard", evidence: "tests fail" }
  expect(
    unitEvidence(
      [
        toolResult(ESCALATE, { reason: "old", evidence: "earlier unit" }),
        user,
        toolResult(ESCALATE, request),
        toolResult(ESCALATE, { reason: "" }),
      ],
      ESCALATE,
    ),
  ).toEqual([{ kind: "agent-request", detail: "too hard: tests fail" }])
  expect(
    unitEvidence([toolResult(ESCALATE, request), continuation({}), failure(overflow)], ESCALATE),
  ).toEqual([])
})

function escalation(
  branch: readonly BranchEntry[],
  overrides: Partial<Parameters<typeof escalationAfterRun>[0]> = {},
) {
  return escalationAfterRun({
    id: "auto",
    settings,
    branch,
    available: [quick, standard, advanced],
    tool: ESCALATE,
    newId: ids(),
    ...overrides,
  })
}

it("escalates a capability failure one tier up within the per-task budget", () => {
  const branch = [routerState("auto", state), user, failure(overflow)]
  expect(escalation(branch)).toEqual({
    task: "t1",
    token: "id-1",
    tier: "advanced",
    escalations: 1,
    restarts: 0,
    tried: [],
  })
  const quickTask = [routerState("auto", { ...state, tier: "quick" }), user, failure(overflow)]
  expect(escalation(quickTask)?.tier).toBe("standard")
  // Missing provider metadata still classifies on the error text.
  expect(
    escalation([
      routerState("auto", { ...state, tier: "quick" }),
      user,
      failure(overflow, { provider: undefined, model: undefined }),
    ])?.tier,
  ).toBe("standard")
})

it("never escalates without capability evidence, budget, ceiling room or candidates", () => {
  const failing = [routerState("auto", state), user, failure(overflow)]
  expect(escalation(failing, { id: "standard" })).toBeUndefined()
  expect(escalation(failing, { settings: { ...settings, mode: "observe" } })).toBeUndefined()
  expect(escalation(failing, { settings: { ...settings, pin: standard } })).toBeUndefined()
  expect(escalation([user, failure(overflow)])).toBeUndefined()
  expect(escalation([routerState("auto", state), user])).toBeUndefined()
  const succeeded = {
    type: "message",
    message: { role: "assistant", stopReason: "stop" },
  }
  expect(
    escalation([
      routerState("auto", state),
      user,
      toolResult(ESCALATE, { reason: "hard", evidence: "x" }),
      succeeded,
    ]),
  ).toBeUndefined()
  expect(
    escalation([routerState("auto", state), user, failure("503 Service Unavailable")]),
  ).toBeUndefined()
  expect(escalation([routerState("auto", state), user, failure()])).toBeUndefined()
  expect(
    escalation([routerState("auto", { ...state, escalations: 2 }), user, failure(overflow)]),
  ).toBeUndefined()
  expect(
    escalation([routerState("auto", { ...state, tier: "advanced" }), user, failure(overflow)]),
  ).toBeUndefined()
  expect(escalation(failing, { available: [standard] })).toBeUndefined()
})

const OUTAGE = "503 status code (no body)"
const QUOTA = "429 You exceeded your current quota, please check your plan and billing details."
function failedMessage(errorMessage: string) {
  return { stopReason: "error", errorMessage }
}

it("redirects a native retry after an infra failure within the tier, avoiding tried models", () => {
  const first = planRoute({
    id: "auto",
    reason: "retry",
    state,
    branch: [],
    failed: { model: standard, message: failedMessage(OUTAGE) },
    newId: ids(),
  })
  expect(first).toEqual({
    tier: "standard",
    sticky: false,
    exclude: [standard],
    state: { ...state, tried: [standard] },
  })
  // The same model failing again in this unit is recorded once.
  const again = planRoute({
    id: "auto",
    reason: "retry",
    state: first.state,
    branch: [],
    failed: { model: standard, message: failedMessage(OUTAGE) },
    newId: ids(),
  })
  expect(again.exclude).toEqual([standard])
  expect(again.state?.tried).toEqual([standard])
  const other = { providerID: "other", id: "s" }
  expect(
    planRoute({
      id: "auto",
      reason: "retry",
      state: first.state,
      branch: [],
      failed: { model: other, message: failedMessage(OUTAGE) },
      newId: ids(),
    }).exclude,
  ).toEqual([standard, other])
})

it("keeps a retry sticky when the failure is not infra or nothing is known", () => {
  for (const failed of [
    { model: standard, message: failedMessage(overflow) },
    { model: standard, message: { stopReason: "aborted" } },
    undefined,
  ])
    expect(
      planRoute({ id: "auto", reason: "retry", state, branch: [], failed, newId: ids() }),
    ).toEqual({ tier: "standard", sticky: true, exclude: [], state })
  expect(
    planRoute({
      id: "quick",
      reason: "retry",
      state: undefined,
      branch: [],
      failed: { model: quick, message: failedMessage(OUTAGE) },
      newId: ids(),
    }),
  ).toEqual({ tier: "quick", sticky: true, exclude: [], state: undefined })
})

function restart(
  branch: readonly BranchEntry[],
  overrides: Partial<Parameters<typeof restartAfterRun>[0]> = {},
) {
  return restartAfterRun({
    id: "standard",
    settings,
    branch,
    available: [quick, standard, advanced],
    tool: ESCALATE,
    newId: ids(),
    ...overrides,
  })
}

it("restarts a run that ended on an infra failure on the same tier, at most twice per task", () => {
  const quota = [routerState("standard", state), user, failure(QUOTA)]
  expect(restart(quota)).toEqual({
    task: "t1",
    token: "id-1",
    tier: "standard",
    escalations: 0,
    restarts: 1,
    tried: [standard],
  })
  expect(
    restart([routerState("auto", { ...state, restarts: 1 }), user, failure(OUTAGE)], {
      id: "auto",
    }),
  ).toMatchObject({ restarts: 2, tier: "standard" })
  expect(
    restart([routerState("standard", { ...state, restarts: 2 }), user, failure(QUOTA)]),
  ).toBeUndefined()
  // Without provider metadata there is no model to avoid, and the
  // continuation must still parse.
  for (const extra of [{ provider: undefined }, { model: undefined }]) {
    const unnamed = restart([routerState("standard", state), user, failure(QUOTA, extra)])
    expect(unnamed?.tried).toEqual([])
    expect(pendingRecovery([continuation(unnamed)], state)?.token).toBe("id-1")
  }
})

it("never restarts an aborted, capability, successful, pinned or observed run", () => {
  const quota = [routerState("standard", state), user, failure(QUOTA)]
  expect(
    restart([
      routerState("standard", state),
      user,
      { type: "message", message: { role: "assistant", stopReason: "aborted" } },
    ]),
  ).toBeUndefined()
  expect(restart([routerState("standard", state), user, failure(overflow)])).toBeUndefined()
  expect(
    restart([
      routerState("standard", state),
      user,
      failure("401 Incorrect API key provided: sk-***."),
    ]),
  ).toBeUndefined()
  expect(
    restart([
      routerState("standard", state),
      user,
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ]),
  ).toBeUndefined()
  // Adaptive's own routing failure is not provider evidence.
  expect(
    restart([
      routerState("standard", state),
      user,
      failure("Adaptive unavailable: all-blocked. Check your tier settings.", {
        provider: "adaptive",
        model: "standard",
      }),
    ]),
  ).toBeUndefined()
  expect(
    restart([
      routerState("standard", state),
      user,
      failure(OUTAGE, { provider: "adaptive", model: "standard" }),
    ]),
  ).toBeUndefined()
  expect(restart(quota, { settings: { ...settings, pin: standard } })).toBeUndefined()
  expect(restart(quota, { settings: { ...settings, mode: "observe" } })).toBeUndefined()
  // Infra evidence is never capability evidence (ADP-013).
  expect(escalation([routerState("auto", state), user, failure(QUOTA)])).toBeUndefined()
})
