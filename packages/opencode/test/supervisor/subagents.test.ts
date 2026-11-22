// covers: ["ADP-002", "ADP-005", "ADP-010", "ADP-013", "ADP-015", "ADP-016", "ADP-021", "ADP-023", "ADP-024", "ADP-025", "ADP-028", "ADP-056"]
import { afterEach, describe, expect, it } from "vitest"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import { WAKE_GRACE_MS } from "@coool/adaptive-core/execution/parking/wake"
import { MAX_PARKED_ATTEMPTS } from "@coool/adaptive-core/execution/parking/plan"
import { DEFAULT_HEALTH_CONFIG } from "@coool/adaptive-core/health/resource-health/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { parseParkedPayload } from "@coool/adaptive-core/state/parked-work/index"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/index"
import { processLedger, type ProcessLedger } from "../../src/adapters/opencode/process-ledger.js"
import type { GoalSurface, RetryHookInput } from "../../src/supervisor/types.js"
import { makeInfo } from "../adapters/opencode/helpers.js"
import {
  FakeScheduler,
  FakeSupervisorSession,
  flush,
  KeyFailStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  storedParked,
  storedReceipts,
} from "./helpers.js"

const A = ref("subscription-a", "model-a")
const B = ref("subscription-b", "model-b")
const C = ref("fallback", "model-c")
const SIBLING = ref("subscription-a", "model-a-small")
const QUOTA_WINDOW = DEFAULT_HEALTH_CONFIG.defaultQuotaWindowMs
const CONTINUE = (id: string): string => `prompt:${id}:${CONTINUATION_PROMPT}`
const supervisors: ReturnType<typeof makeSupervisor>[] = []

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.dispose()
})

function harness(
  options: {
    mode?: "active" | "observe" | "off"
    tiers?: Record<string, ModelRef[]>
    agentTiers?: Record<string, string>
    session?: FakeSupervisorSession
    storage?: KeyFailStorage
    clock?: { now: number }
    ledger?: ProcessLedger
    goal?: GoalSurface
  } = {},
) {
  const clock = options.clock ?? { now: 1_000 }
  const session = options.session ?? new FakeSupervisorSession()
  const storage = options.storage ?? new KeyFailStorage("unused")
  if (options.storage === undefined) {
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON(
        options.mode ?? "active",
        options.tiers ?? { quick: [A, B], standard: [C], advanced: [C] },
        null,
        options.agentTiers ?? { explore: "quick" },
      ),
    )
  }
  const scheduler = new FakeScheduler()
  const supervisor = makeSupervisor({
    storage,
    session,
    scheduler,
    clock: () => clock.now,
    infos: [A, B, C, SIBLING].map((model) => makeInfo(model.providerID, model.id)),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
  })
  supervisors.push(supervisor)
  return { clock, session, storage, scheduler, supervisor }
}

type Harness = ReturnType<typeof harness>

// Child sessions do not run the prompt hook. Admit through execution-started,
// not through the main-session prompt helper used by other supervisor tests.
async function start(h: Harness, id = "child", model: ModelRef = A, agent = "explore") {
  await h.supervisor.handleReport({
    kind: "model-request",
    sessionID: id,
    model,
    agent,
    requestKind: "primary",
  })
  await h.supervisor.handleReport({
    kind: "execution-started",
    sessionID: id,
    at: ++h.clock.now,
  })
}

function retry(
  id = "child",
  model: ModelRef = A,
  error: RetryHookInput["error"] = {
    type: "UnknownError",
    message: "You've hit your usage limit",
    status: 429,
  },
): RetryHookInput {
  return { sessionID: id, model, error, attempt: 1, decision: { retry: true, delay: 100 } }
}

async function terminal(h: Harness, id = "child", message = "You've hit your usage limit") {
  await h.supervisor.handleReport({
    kind: "execution-failed",
    sessionID: id,
    at: ++h.clock.now,
    error: { type: "UnknownError", message },
  })
  await flush()
}

async function park(h: Harness, id = "child") {
  await start(h, id)
  await terminal(h, id)
  expect(parseParkedPayload(storedParked(h.storage))).toEqual(
    expect.arrayContaining([expect.objectContaining({ sessionID: id, tier: "quick" })]),
  )
}

async function wake(h: Harness) {
  expect(h.scheduler.pending()).toHaveLength(1)
  h.clock.now += h.scheduler.pending()[0]?.delayMs ?? 0
  await h.scheduler.fire()
}

async function continuation(h: Harness, id: string, model: ModelRef) {
  // Adaptive's owned session.prompt, unlike the initial child invocation,
  // does have a prompt-hook echo.
  await h.supervisor.handleReport({ kind: "prompt", sessionID: id })
  await h.supervisor.handleReport({
    kind: "model-selected",
    sessionID: id,
    model,
    at: ++h.clock.now,
  })
  await h.supervisor.handleReport({
    kind: "execution-started",
    sessionID: id,
    at: ++h.clock.now,
  })
}

async function succeed(h: Harness, id: string) {
  await h.supervisor.handleReport({
    kind: "execution-succeeded",
    sessionID: id,
    at: ++h.clock.now,
  })
  await flush()
}

describe("subagent routing without a prompt hook", () => {
  it.each(["child", "parallel-child-2", "nested-grandchild"])(
    "admits %s on its role tier rather than the parent's tier",
    async (id) => {
      const h = harness()
      await start(h, "parent", C, "general")
      await start(h, id)
      expect(h.session.log).toEqual([
        "switch:parent:fallback/model-c",
        `switch:${id}:subscription-a/model-a`,
      ])
      expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
        sessionID: id,
        tier: "quick",
        decision: { kind: "apply", tier: "quick", model: A },
      })
    },
  )

  it("records the agent selected at child creation before its first unit starts", async () => {
    const h = harness()
    // Real host order: the durable agent selection lands first; the child
    // fires no prompt hook and no model-request precedes its first
    // execution-started admission.
    await h.supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "child",
      agent: "explore",
    })
    await h.supervisor.handleReport({
      kind: "execution-started",
      sessionID: "child",
      at: ++h.clock.now,
    })
    expect(h.session.log).toEqual(["switch:child:subscription-a/model-a"])
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
      sessionID: "child",
      tier: "quick",
      decision: { kind: "apply", tier: "quick", model: A },
    })
  })

  it("keeps explicit tier requests local to the child", async () => {
    const h = harness()
    expect(h.supervisor.noteTierRequest("child", "advanced")).toBe(true)
    await start(h)
    await start(h, "sibling")
    expect(h.session.log).toEqual([
      "switch:child:fallback/model-c",
      "switch:sibling:subscription-a/model-a",
    ])
    expect(await h.supervisor.getTierRequest("sibling")).toBeNull()
  })

  it("honors a user pin over the child's role tier", async () => {
    const h = harness()
    expect(await h.supervisor.updateSettings({ pin: C })).toMatchObject({ ok: true })
    await start(h)
    expect(h.session.log).toEqual(["switch:child:fallback/model-c"])
  })

  it.each(["off", "observe"] as const)("%s never switches or continues a child", async (mode) => {
    const h = harness({ mode })
    await start(h)
    const input = retry()
    await h.supervisor.handleRetry(input)
    await terminal(h)
    expect(input.decision).toEqual({ retry: true, delay: 100 })
    expect(h.session.log).toEqual([])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("a child's session mode does not turn off its sibling", async () => {
    const h = harness()
    await h.supervisor.setSessionMode("child", "off")
    await start(h)
    await start(h, "sibling")
    expect(h.session.log).toEqual(["switch:sibling:subscription-a/model-a"])
  })
})

describe("subagent horizontal recovery", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "shared health subset %i selects only the first available provider",
    async (mask) => {
      const h = harness({ tiers: { quick: [A, B, C] } })
      const available = []
      for (const [index, model] of [A, B, C].entries()) {
        if ((mask & (1 << index)) === 0) {
          available.push(model)
          continue
        }
        await h.supervisor.handleReport({
          kind: "model-request",
          sessionID: "parent",
          model,
          requestKind: "primary",
        })
        await h.supervisor.handleReport({ kind: "http-response", sessionID: "parent", status: 402 })
      }
      await start(h)
      const selected = available[0]
      if (selected === undefined) {
        expect(h.session.log).toEqual([])
        expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
          sessionID: "child",
          decision: { kind: "park", reason: "all-blocked" },
        })
      } else {
        expect(h.session.log).toEqual([`switch:child:${selected.providerID}/${selected.id}`])
      }
    },
  )

  it.each([
    { type: "UnknownError", message: "rate limit", status: 429 },
    { type: "UnknownError", message: "You've hit your usage limit", status: 429 },
    { type: "UnknownError", message: "out of credits", status: 402 },
  ])("fails over after $status / $message without escalating", async (error) => {
    const h = harness()
    await start(h)
    const input = retry("child", A, error)
    await h.supervisor.handleRetry(input)
    await flush()
    expect(input.decision).toEqual({ retry: false })
    expect(h.session.log).toEqual([
      "switch:child:subscription-a/model-a",
      "wait:child",
      "switch:child:subscription-b/model-b",
      CONTINUE("child"),
    ])
    const receipts = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipts.some((entry) => entry.decision.kind === "escalate")).toBe(false)
    expect(receipts.at(-1)).toMatchObject({ tier: "quick" })
  })

  it("skips same-provider siblings on shared subscription exhaustion", async () => {
    const h = harness({ tiers: { quick: [A, SIBLING, B] } })
    await start(h)
    await h.supervisor.handleRetry(retry())
    await flush()
    expect(h.session.log).toContain("switch:child:subscription-b/model-b")
    expect(h.session.log).not.toContain("switch:child:subscription-a/model-a-small")
  })

  it("allows a same-provider sibling on a model-specific quota", async () => {
    const h = harness({ tiers: { quick: [A, SIBLING, B] } })
    await start(h)
    await h.supervisor.handleRetry(
      retry("child", A, { type: "UnknownError", message: "Model quota exhausted", status: 429 }),
    )
    await flush()
    expect(h.session.log).toContain("switch:child:subscription-a/model-a-small")
    expect(h.session.log).not.toContain("switch:child:subscription-b/model-b")
  })

  it("two already exhausted providers are skipped when the child itself fails", async () => {
    const h = harness({ tiers: { quick: [A, B, C] } })
    for (const model of [A, B]) {
      await h.supervisor.handleReport({
        kind: "model-request",
        sessionID: "parent",
        model,
        requestKind: "primary",
      })
      await h.supervisor.handleReport({
        kind: "http-response",
        sessionID: "parent",
        status: 402,
      })
    }
    await start(h, "child", A)
    expect(h.session.log).toEqual(["switch:child:fallback/model-c"])
    const input = retry()
    await h.supervisor.handleRetry(input)
    await flush()
    expect(input.decision).toEqual({ retry: false })
    expect(h.session.log.slice(-3)).toEqual([
      "wait:child",
      "switch:child:fallback/model-c",
      CONTINUE("child"),
    ])
  })

  it.each([
    { type: "UnauthorizedError", message: "bad key", status: 401 },
    { type: "ForbiddenError", message: "forbidden", status: 403 },
    { type: "ModelNotFoundError", message: "missing", status: 404 },
    { type: "UnknownError", message: "unrecognized failure" },
    { type: "UnknownError", message: "You've hit your usage limit" },
  ])("leaves native handling intact for $type / $message", async (error) => {
    const h = harness()
    await start(h)
    const input = retry("child", A, error)
    await h.supervisor.handleRetry(input)
    await flush()
    expect(input.decision).toEqual({ retry: true, delay: 100 })
    expect(h.session.log).toEqual(["switch:child:subscription-a/model-a"])
  })

  it("does not start a retry recovery when the host already decided not to retry", async () => {
    const h = harness()
    await start(h)
    const input = retry()
    input.decision = { retry: false }
    await h.supervisor.handleRetry(input)
    await flush()
    expect(h.session.log).toEqual(["switch:child:subscription-a/model-a"])
  })

  it("recovers terminal quota errors that have no HTTP status or retry hook", async () => {
    const h = harness()
    await start(h)
    await terminal(h)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:child",
      "switch:child:subscription-b/model-b",
      CONTINUE("child"),
    ])
  })

  it("does not pull a productive child back when a preferred model recovers", async () => {
    const h = harness()
    await start(h)
    await terminal(h)
    await continuation(h, "child", B)
    const before = [...h.session.log]
    h.clock.now += QUOTA_WINDOW + 1
    await h.supervisor.handleReport({ kind: "idle", sessionID: "child" })
    expect(h.session.log).toEqual(before)
    await succeed(h, "child")
    await start(h, "child", B)
    expect(h.session.log.at(-1)).toBe("switch:child:subscription-a/model-a")
  })
})

describe("subagent concurrency and parent isolation", () => {
  it("only one sibling probes a half-open backend; success restores it for the next child", async () => {
    const h = harness()
    for (let index = 0; index < DEFAULT_HEALTH_CONFIG.breaker.failureThreshold; index += 1) {
      await h.supervisor.handleReport({
        kind: "model-request",
        sessionID: "parent",
        model: A,
        requestKind: "primary",
      })
      await h.supervisor.handleReport({ kind: "http-response", sessionID: "parent", status: 503 })
    }
    h.clock.now += DEFAULT_HEALTH_CONFIG.breaker.baseOpenMs + 1
    await Promise.all([start(h, "probe"), start(h, "sibling")])
    const switchedToA = h.session.log.filter((line) => line.endsWith(":subscription-a/model-a"))
    const switchedToB = h.session.log.filter((line) => line.endsWith(":subscription-b/model-b"))
    expect(switchedToA).toHaveLength(1)
    expect(switchedToB).toHaveLength(1)
    const probingID = switchedToA[0]?.split(":")[1]
    expect(probingID).toBeDefined()
    if (probingID === undefined) throw new Error("missing probe session")
    await succeed(h, probingID)
    await start(h, "next")
    expect(h.session.log.at(-1)).toBe("switch:next:subscription-a/model-a")
  })

  it("capability escalation is local to the child and does not change its sibling's tier", async () => {
    const h = harness({ tiers: { quick: [A], standard: [B], advanced: [C] } })
    await start(h)
    expect(h.supervisor.noteEscalationRequest("child", "larger context", "413 at 200k")).toBe(true)
    await h.supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "child",
      at: ++h.clock.now,
      error: { type: "UnknownError", message: "context length exceeded", status: 413 },
    })
    await flush()
    const escalation = parseReceiptsPayload(storedReceipts(h.storage)).find(
      (receipt) => receipt.decision.kind === "escalate",
    )
    expect(escalation).toMatchObject({
      sessionID: "child",
      decision: { kind: "escalate", tier: "standard", target: B },
    })
    expect(h.session.log).toContain(CONTINUE("child"))
    await start(h, "sibling")
    expect(h.session.log.at(-1)).toBe("switch:sibling:subscription-a/model-a")
  })

  it("simultaneous sibling failures each get exactly one local continuation", async () => {
    const h = harness()
    await start(h, "parent", C, "general")
    await start(h, "child-1")
    await start(h, "child-2")
    const inputs = [retry("child-1"), retry("child-2")]
    await Promise.all(inputs.map((input) => h.supervisor.handleRetry(input)))
    await flush()
    expect(inputs.map((input) => input.decision)).toEqual([{ retry: false }, { retry: false }])
    for (const id of ["child-1", "child-2"]) {
      expect(h.session.log.filter((entry) => entry === CONTINUE(id))).toHaveLength(1)
      expect(h.session.log).toContain(`switch:${id}:subscription-b/model-b`)
    }
    expect(h.session.log.filter((entry) => entry.includes(":parent"))).toEqual([
      "switch:parent:fallback/model-c",
    ])
  })

  it("a failing child quarantines its provider for future siblings", async () => {
    const h = harness()
    await start(h, "child-1")
    await terminal(h, "child-1")
    await start(h, "child-2")
    expect(h.session.log.at(-1)).toBe("switch:child-2:subscription-b/model-b")
  })

  it("a retry burst on one child does not duplicate its continuation", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    const h = harness({ session })
    await start(h)
    const inputs = [retry(), retry(), retry()]
    for (const input of inputs) await h.supervisor.handleRetry(input)
    await flush()
    expect(h.session.log.filter((entry) => entry === "wait:child")).toHaveLength(1)
    expect(inputs.every((input) => !input.decision.retry)).toBe(true)
    session.releaseWait()
    await flush()
    expect(h.session.log.filter((entry) => entry === CONTINUE("child"))).toHaveLength(1)
  })

  it.each(["execution-interrupted", "model-selected"] as const)(
    "%s during settle cancels only that child's pending recovery",
    async (kind) => {
      const session = new FakeSupervisorSession({ holdWait: true })
      const h = harness({ session })
      await start(h)
      await h.supervisor.handleRetry(retry())
      await flush()
      if (kind === "execution-interrupted") {
        await h.supervisor.handleReport({
          kind,
          sessionID: "child",
          at: ++h.clock.now,
          reason: "user",
        })
      } else {
        await h.supervisor.handleReport({
          kind,
          sessionID: "child",
          at: ++h.clock.now,
          model: C,
        })
      }
      session.releaseWait()
      await flush()
      expect(h.session.log).toEqual(["switch:child:subscription-a/model-a", "wait:child"])
      expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
      await start(h, "sibling")
      expect(h.session.log.at(-1)).toBe("switch:sibling:subscription-b/model-b")
    },
  )
})

describe("subagent durable park and resume", () => {
  it("repeated quota failures eventually spend the child's wake budget, not its sibling's", async () => {
    const h = harness({ tiers: { quick: [A] } })
    await park(h)
    for (let attempt = 0; attempt < MAX_PARKED_ATTEMPTS; attempt += 1) {
      await wake(h)
      await continuation(h, "child", A)
      await terminal(h)
    }
    expect(h.session.log.filter((line) => line === CONTINUE("child"))).toHaveLength(
      MAX_PARKED_ATTEMPTS,
    )
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
      sessionID: "child",
      decision: {
        kind: "park",
        detail: `gave up after ${String(MAX_PARKED_ATTEMPTS)} resume attempts`,
      },
    })
    await park(h, "sibling")
    await wake(h)
    expect(h.session.log.filter((line) => line === CONTINUE("sibling"))).toHaveLength(1)
  })

  it("parks without cross-tier borrowing and wakes through successful completion", async () => {
    const h = harness({ tiers: { quick: [A], standard: [C], advanced: [B] } })
    await park(h)
    expect(h.session.log).toEqual(["switch:child:subscription-a/model-a"])
    expect((await h.supervisor.status()).waiting).toEqual([
      {
        sessionID: "child",
        tier: "quick",
        resumeAt: h.clock.now + QUOTA_WINDOW + WAKE_GRACE_MS,
      },
    ])
    await wake(h)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:child",
      "switch:child:subscription-a/model-a",
      CONTINUE("child"),
    ])
    await continuation(h, "child", A)
    await succeed(h, "child")
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
      sessionID: "child",
      tier: "quick",
      outcome: { status: "succeeded" },
    })
  })

  it("both parked siblings wake once, without continuing their parent", async () => {
    const h = harness({ tiers: { quick: [A], standard: [C] } })
    await start(h, "parent", C, "general")
    await park(h, "child-1")
    await park(h, "child-2")
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(2)
    await wake(h)
    for (const id of ["child-1", "child-2"]) {
      expect(h.session.log.filter((entry) => entry === CONTINUE(id))).toHaveLength(1)
    }
    expect(h.session.log).not.toContain(CONTINUE("parent"))
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("a fresh supervisor restores the child's parked tier and wake from storage", async () => {
    const h = harness({ tiers: { quick: [A], standard: [C] } })
    await park(h)
    h.supervisor.dispose()
    const restarted = harness({ storage: h.storage, clock: h.clock })
    await restarted.supervisor.settings()
    await flush()
    await wake(restarted)
    expect(restarted.session.log).toEqual([
      "wait:child",
      "switch:child:subscription-a/model-a",
      CONTINUE("child"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("two plugin instances share a child resume claim", async () => {
    const holder = {}
    const h = harness({
      tiers: { quick: [A], standard: [C] },
      ledger: processLedger(holder),
    })
    await park(h)
    const other = harness({
      storage: h.storage,
      clock: h.clock,
      ledger: processLedger(holder),
      session: h.session,
    })
    await other.supervisor.settings()
    await flush()
    await wake(h)
    await other.scheduler.fire()
    expect(h.session.log.filter((entry) => entry === CONTINUE("child"))).toHaveLength(1)
  })

  it("cancelling one parked child leaves the sibling wake intact", async () => {
    const h = harness({ tiers: { quick: [A] } })
    await park(h, "child-1")
    await park(h, "child-2")
    expect(await h.supervisor.cancelParked("child-1")).toBe("cancelled")
    await wake(h)
    expect(h.session.log).not.toContain(CONTINUE("child-1"))
    expect(h.session.log.filter((entry) => entry === CONTINUE("child-2"))).toHaveLength(1)
  })

  it("OFF retains a parked child without waking it, then Active re-arms it", async () => {
    const h = harness({ tiers: { quick: [A] } })
    await park(h)
    await h.supervisor.setSessionMode("child", "off")
    expect(h.scheduler.pending()).toEqual([])
    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    await h.supervisor.setSessionMode("child", "active")
    await wake(h)
    expect(h.session.log.filter((entry) => entry === CONTINUE("child"))).toHaveLength(1)
  })

  it("manual resume before the reset stays waiting; after reset resumes once", async () => {
    const h = harness({ tiers: { quick: [A] } })
    await park(h)
    expect(await h.supervisor.resumeParked("child")).toBe("waiting")
    expect(h.session.log).not.toContain(CONTINUE("child"))
    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS
    expect(await h.supervisor.resumeParked("child")).toBe("resumed")
    expect(await h.supervisor.resumeParked("child")).toBe("not-parked")
    expect(h.session.log.filter((entry) => entry === CONTINUE("child"))).toHaveLength(1)
  })

  it("a deleted child is dropped instead of retried forever", async () => {
    const h = harness({
      tiers: { quick: [A] },
      session: new FakeSupervisorSession({ failGet: true }),
    })
    await park(h)
    await wake(h)
    expect(h.session.log).not.toContain(CONTINUE("child"))
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
  })

  it("child recovery never reads or resumes the parent's paused goal", async () => {
    const calls: string[] = []
    const h = harness({
      tiers: { quick: [A] },
      goal: {
        get: (id) => {
          calls.push(`get:${id}`)
          return Promise.resolve(
            id === "parent"
              ? { status: "paused", reason: "The session failed: quota exhausted" }
              : null,
          )
        },
        resume: (id) => {
          calls.push(`resume:${id}`)
          return Promise.resolve()
        },
      },
    })
    await park(h)
    await wake(h)
    await continuation(h, "child", A)
    await succeed(h, "child")
    expect(calls).toEqual(["get:child"])
  })
})
