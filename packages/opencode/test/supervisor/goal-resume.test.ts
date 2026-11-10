/**
 * A limit hit pauses the host's goal (`The session failed: ...`) before
 * Adaptive recovers; an owned continuation that lands and succeeds must
 * bring the goal back, while every deliberate pause stays paused (ADP-015,
 * ADP-028).
 */
// covers: ["ADP-025"]
import { describe, expect, it } from "vitest"

import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import { DEFAULT_HEALTH_CONFIG } from "@coool/adaptive-core/health/resource-health/types"
import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import {
  FakeScheduler,
  FakeSupervisorSession,
  flush,
  KeyFailStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
} from "./helpers.js"
import type { GoalSnapshot, GoalSurface } from "../../src/supervisor/types.js"

const QUOTA_WINDOW = DEFAULT_HEALTH_CONFIG.defaultQuotaWindowMs

const CLAUDE = ref("anthropic", "claude-sonnet-4")
const CODEX = ref("openai", "codex-gpt-5")
const LADDER_INFOS = [makeInfo("anthropic", "claude-sonnet-4"), makeInfo("openai", "codex-gpt-5")]

const CONTINUE = (sessionID: string): string => `prompt:${sessionID}:${CONTINUATION_PROMPT}`

function ladderStorage(): KeyFailStorage {
  const storage = new KeyFailStorage("unused")
  seed(
    storage,
    "coool.adaptive/settings",
    settingsJSON("active", {
      standard: [wireRef("anthropic", "claude-sonnet-4"), wireRef("openai", "codex-gpt-5")],
    }),
  )
  return storage
}

/** Goal surface that records reads and resumes; the current state is scripted. */
class FakeGoal {
  readonly log: string[] = []
  state: GoalSnapshot | null = null
  failGet = false
  failResume = false

  readonly source: GoalSurface = {
    get: (sessionID: string) => {
      this.log.push(`get:${sessionID}`)
      if (this.failGet) return Promise.reject(new Error("goal rpc failed"))
      return Promise.resolve(this.state)
    },
    resume: (sessionID: string) => {
      this.log.push(`resume:${sessionID}`)
      if (this.failResume) return Promise.reject(new Error("resume failed"))
      return Promise.resolve()
    },
  }
}

interface Harness {
  clock: { now: number }
  session: FakeSupervisorSession
  goal: FakeGoal
  supervisor: ReturnType<typeof makeSupervisor>
}

function harness(options: { goal?: FakeGoal } = {}): Harness {
  const clock = { now: 1_000 }
  const session = new FakeSupervisorSession()
  const goal = options.goal ?? new FakeGoal()
  const supervisor = makeSupervisor({
    storage: ladderStorage(),
    session,
    clock: () => clock.now,
    scheduler: new FakeScheduler(),
    infos: LADDER_INFOS,
    goal: goal.source,
  })
  return { clock, session, goal, supervisor }
}

/** One fresh turn on `sessionID` that ends out of quota on `model`. */
async function runOutOfQuota(
  h: Harness,
  sessionID: string,
  model: { providerID: string; id: string },
): Promise<void> {
  await h.supervisor.handleReport({ kind: "prompt", sessionID })
  await h.supervisor.handleReport({
    kind: "model-selected",
    sessionID,
    at: h.clock.now - 1,
    model,
  })
  await h.supervisor.handleReport({ kind: "execution-started", sessionID, at: h.clock.now })
  await h.supervisor.handleReport({
    kind: "execution-failed",
    sessionID,
    at: h.clock.now,
    error: { type: "UnknownError", message: "Model quota exhausted" },
  })
  await flush()
}

/** The owned continuation's turn: admitted, runs on the recovered model, succeeds. */
async function continuationSucceeds(
  h: Harness,
  sessionID: string,
  model: { providerID: string; id: string },
): Promise<void> {
  await h.supervisor.handleReport({ kind: "prompt", sessionID })
  await h.supervisor.handleReport({
    kind: "model-selected",
    sessionID,
    at: h.clock.now,
    model,
  })
  await h.supervisor.handleReport({ kind: "execution-started", sessionID, at: h.clock.now })
  await h.supervisor.handleReport({ kind: "execution-succeeded", sessionID, at: h.clock.now })
  await flush()
}

describe("goal resume after an owned continuation", () => {
  it("resumes a goal the limit hit paused once the continuation succeeds", async () => {
    const h = harness()
    h.goal.state = {
      status: "paused",
      reason: "The session failed: Model API quota exceeded across all providers",
    }
    await runOutOfQuota(h, "s1", CLAUDE)
    expect(h.session.log).toContain(`switch:s1:openai/codex-gpt-5`)
    expect(h.session.log).toContain(CONTINUE("s1"))

    await continuationSucceeds(h, "s1", CODEX)
    expect(h.goal.log).toEqual([`get:s1`, `resume:s1`])
  })

  it("leaves a deliberately paused goal paused", async () => {
    const h = harness()
    h.goal.state = { status: "paused", reason: "Paused by the user" }
    await runOutOfQuota(h, "s1", CLAUDE)
    await continuationSucceeds(h, "s1", CODEX)
    expect(h.goal.log).toEqual([`get:s1`])
  })

  it("does nothing when the goal is active or absent", async () => {
    const h = harness()
    h.goal.state = { status: "active" }
    await runOutOfQuota(h, "s1", CLAUDE)
    await continuationSucceeds(h, "s1", CODEX)
    expect(h.goal.log).toEqual([`get:s1`])
  })

  it("does not resume when the continuation's unit failed again", async () => {
    const h = harness()
    h.goal.state = {
      status: "paused",
      reason: "The session failed: Model API quota exceeded across all providers",
    }
    await runOutOfQuota(h, "s1", CLAUDE)
    expect(h.session.log).toContain(CONTINUE("s1"))
    // The continuation unit runs and fails on the second model too: the
    // ladder is spent, work parks, nothing continued — the goal stays paused.
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: h.clock.now,
      model: CODEX,
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    await h.supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: h.clock.now,
      error: { type: "UnknownError", message: "Model quota exhausted" },
    })
    await flush()
    // The parked wake never delivers: no resume while the work did not continue.
    expect(h.goal.log).toEqual([])
    // A later unrelated success on the session does not resurrect the goal either.
    h.clock.now += QUOTA_WINDOW + 1
    await continuationSucceeds(h, "s1", CLAUDE)
    expect(h.goal.log).toEqual([])
  })

  it("does not resume after the user interrupted the recovered turn", async () => {
    const h = harness()
    h.goal.state = {
      status: "paused",
      reason: "The session failed: Model API quota exceeded across all providers",
    }
    await runOutOfQuota(h, "s1", CLAUDE)
    expect(h.session.log).toContain(CONTINUE("s1"))
    await h.supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: h.clock.now,
      reason: "user",
    })
    await continuationSucceeds(h, "s1", CODEX)
    expect(h.goal.log).toEqual([])
  })

  it("survives a failing goal surface without disturbing the recovery", async () => {
    const h = harness()
    h.goal.failGet = true
    h.goal.state = { status: "paused", reason: "The session failed: quota" }
    await runOutOfQuota(h, "s1", CLAUDE)
    await expect(continuationSucceeds(h, "s1", CODEX)).resolves.toBeUndefined()
    expect(h.goal.log).toEqual([`get:s1`])

    const h2 = harness()
    h2.goal.failResume = true
    h2.goal.state = { status: "paused", reason: "The session failed: quota" }
    await runOutOfQuota(h2, "s1", CLAUDE)
    await expect(continuationSucceeds(h2, "s1", CODEX)).resolves.toBeUndefined()
    expect(h2.goal.log).toEqual([`get:s1`, `resume:s1`])
  })

  it("runs without a goal surface", async () => {
    const clock = { now: 1_000 }
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({
      storage: ladderStorage(),
      session,
      clock: () => clock.now,
      scheduler: new FakeScheduler(),
      infos: LADDER_INFOS,
    })
    await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: clock.now - 1,
      model: CLAUDE,
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: clock.now })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: clock.now,
      error: { type: "UnknownError", message: "Model quota exhausted" },
    })
    await flush()
    expect(session.log).toContain(`prompt:s1:${CONTINUATION_PROMPT}`)
  })
})
