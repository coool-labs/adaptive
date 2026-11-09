/**
 * Goal continuity across the three-resource ladder this plugin is operated
 * with — ClaudeAgent subscription, OpenAI subscription, then the paid
 * OpenRouter fallback. A goal started without interaction must finish
 * without interaction: subscriptions are exhausted in priority order, the
 * paid fallback is only touched when both subscriptions are out, every
 * lifted limit reclaims the work at the next safe boundary, and several
 * limit changes inside one goal never strand it (ADP-005, ADP-015, ADP-016,
 * ADP-021, ADP-022, ADP-024, ADP-028, ADP-038, ADP-056).
 */
// covers: ["ADP-005", "ADP-015", "ADP-016", "ADP-021", "ADP-022", "ADP-024", "ADP-028", "ADP-038", "ADP-056"]
import { describe, expect, it } from "vitest"

import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import { WAKE_GRACE_MS } from "@coool/adaptive-core/execution/parking/wake"
import { DEFAULT_HEALTH_CONFIG } from "@coool/adaptive-core/health/resource-health/types"
import { parseParkedPayload } from "@coool/adaptive-core/state/parked-work/index"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/index"
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
  storedParked,
  storedReceipts,
} from "./helpers.js"

const QUOTA_WINDOW = DEFAULT_HEALTH_CONFIG.defaultQuotaWindowMs
const RATE_WINDOW = DEFAULT_HEALTH_CONFIG.defaultRateLimitWindowMs

const CLAUDE = ref("anthropic", "claude-sonnet-4")
const CODEX = ref("openai", "codex-gpt-5")
const GLM = ref("openrouter", "glm-flash")
const LADDER_INFOS = [
  makeInfo("anthropic", "claude-sonnet-4"),
  makeInfo("openai", "codex-gpt-5"),
  makeInfo("openrouter", "glm-flash"),
]

const CONTINUE = (sessionID: string): string => `prompt:${sessionID}:${CONTINUATION_PROMPT}`

function ladderStorage(
  tiers: Record<string, unknown[]> = {
    standard: [
      wireRef("anthropic", "claude-sonnet-4"),
      wireRef("openai", "codex-gpt-5"),
      wireRef("openrouter", "glm-flash"),
    ],
  },
  agentTiers: Record<string, string> = {},
): KeyFailStorage {
  const storage = new KeyFailStorage("unused")
  seed(storage, "coool.adaptive/settings", settingsJSON("active", tiers, null, agentTiers))
  return storage
}

interface Harness {
  clock: { now: number }
  session: FakeSupervisorSession
  storage: KeyFailStorage
  scheduler: FakeScheduler
  supervisor: ReturnType<typeof makeSupervisor>
}

function harness(options: { infos?: typeof LADDER_INFOS; storage?: KeyFailStorage } = {}): Harness {
  const clock = { now: 1_000 }
  const session = new FakeSupervisorSession()
  const storage = options.storage ?? ladderStorage()
  const scheduler = new FakeScheduler()
  const supervisor = makeSupervisor({
    storage,
    session,
    scheduler,
    clock: () => clock.now,
    infos: options.infos ?? LADDER_INFOS,
  })
  return { clock, session, storage, scheduler, supervisor }
}

/**
 * Fails the open unit on `model`. No prompt report: the turn was already
 * admitted (by the prompt hook or by an owned continuation).
 */
async function failUnit(
  h: Harness,
  sessionID: string,
  model: { providerID: string; id: string },
  message = "Model quota exhausted",
): Promise<void> {
  const { supervisor, clock } = h
  await supervisor.handleReport({
    kind: "model-selected",
    sessionID,
    at: clock.now - 1,
    model,
  })
  await supervisor.handleReport({ kind: "execution-started", sessionID, at: clock.now })
  await supervisor.handleReport({
    kind: "execution-failed",
    sessionID,
    at: clock.now,
    error: { type: "UnknownError", message },
  })
  await flush()
}

/**
 * One fresh turn on `sessionID` that ends out of quota: the prompt (hook
 * admission), then the failing unit.
 */
async function runOutOfQuota(
  h: Harness,
  sessionID: string,
  model: { providerID: string; id: string },
): Promise<void> {
  await h.supervisor.handleReport({ kind: "prompt", sessionID })
  await failUnit(h, sessionID, model)
}

/**
 * The continuation turn a recovery started: the host reports its prompt
 * (consuming the owned-continuation marker), then the unit fails.
 */
async function continueAndFail(
  h: Harness,
  sessionID: string,
  model: { providerID: string; id: string },
  message = "Model quota exhausted",
): Promise<void> {
  await h.supervisor.handleReport({ kind: "prompt", sessionID })
  await failUnit(h, sessionID, model, message)
}

/** The host reports a non-running model's HTTP outcome (rate limit, quota, outage). */
async function observeStatus(
  h: Harness,
  model: { providerID: string; id: string },
  status: number,
  options: { retryAfter?: string; capturedHeaders?: Record<string, string> } = {},
): Promise<void> {
  await h.supervisor.handleReport({
    kind: "model-request",
    sessionID: "s9",
    model,
    requestKind: "primary",
  })
  await h.supervisor.handleReport({
    kind: "http-response",
    sessionID: "s9",
    status,
    ...(options.retryAfter === undefined ? {} : { retryAfterHeader: options.retryAfter }),
    ...(options.capturedHeaders === undefined ? {} : { capturedHeaders: options.capturedHeaders }),
  })
}

/** Advance the clock by the live timer's delay and fire it; returns the delay. */
async function wake(h: Harness): Promise<number> {
  const delay = h.scheduler.pending()[0]?.delayMs ?? 0
  h.clock.now += delay
  await h.scheduler.fire()
  return delay
}

describe("goal continuity — subscription preference", () => {
  it("starts a goal on the first subscription", async () => {
    const h = harness()
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:anthropic/claude-sonnet-4"])
  })

  it("moves to the second subscription when the first is rate limited", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429)
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openai/codex-gpt-5"])
    const [receipt] = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipt?.decision).toMatchObject({
      kind: "apply",
      model: CODEX,
      evidence: { skipped: [{ ref: CLAUDE, why: "rate-limited" }] },
    })
  })

  it("moves to the paid fallback only when both subscriptions are limited", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429)
    await observeStatus(h, CODEX, 402)
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
  })

  it("never touches the paid fallback while any subscription is ready", async () => {
    const h = harness()
    await observeStatus(h, CODEX, 402)
    await observeStatus(h, GLM, 402)
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:anthropic/claude-sonnet-4"])
  })

  it("a lifted subscription wins the next admission over the running fallback", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429)
    await observeStatus(h, CODEX, 402)
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    h.clock.now += RATE_WINDOW + 1
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "switch:s1:anthropic/claude-sonnet-4",
    ])
  })
})

describe("goal continuity — the paid fallback's credits deplete", () => {
  it("openrouter depletion does not block the subscriptions: the goal continues there", async () => {
    const h = harness()
    await observeStatus(h, GLM, 402)
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:anthropic/claude-sonnet-4"])
  })

  it("openrouter depletion mid-goal parks only when the subscriptions are also out", async () => {
    const h = harness()
    await observeStatus(h, GLM, 402)
    await runOutOfQuota(h, "s1", CLAUDE)
    await continueAndFail(h, "s1", CODEX)
    expect(h.session.log).toEqual([
      "switch:s1:anthropic/claude-sonnet-4",
      "wait:s1",
      "switch:s1:openai/codex-gpt-5",
      CONTINUE("s1"),
    ])
    // The codex continuation runs out: the recovery admission finds every
    // rung blocked (claude and codex quota windows, openrouter out of
    // credits) and parks instead of looping.
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", tier: "standard", detail: "quota exhausted" }),
    ])
    expect(h.scheduler.pending()).toHaveLength(1)
    expect(h.scheduler.pending()[0]?.delayMs).toBe(QUOTA_WINDOW + WAKE_GRACE_MS)
  })

  it("the wake delay honors the paid provider's stated reset, not just health windows", async () => {
    const h = harness()
    // Both subscriptions rate limited with stated resets; the paid fallback
    // then fails terminally on the goal itself.
    await observeStatus(h, CLAUDE, 429, { retryAfter: "600" })
    await observeStatus(h, CODEX, 429, { retryAfter: "120" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    await runOutOfQuota(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    // The earliest stated reset is codex's, at two minutes.
    expect(h.scheduler.pending()[0]?.delayMs).toBe(120_000 + WAKE_GRACE_MS)
  })

  it("an insufficient-credits reply classifies as quota and drives the same recovery", async () => {
    const h = harness()
    await runOutOfQuota(h, "s1", CLAUDE)
    await continueAndFail(h, "s1", CODEX)
    // The paid run answers "Insufficient credits": the same terminal-quota
    // recovery machinery, now with nothing left to admit.
    await continueAndFail(h, "s1", GLM, "Insufficient credits")
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", tier: "standard", detail: "quota exhausted" }),
    ])
  })

  it("credit depletion is provider-scoped: no openrouter sibling can substitute", async () => {
    const h = harness({ infos: [...LADDER_INFOS, makeInfo("openrouter", "glm-flash-mini")] })
    await observeStatus(h, ref("openrouter", "glm-flash-mini"), 402)
    await runOutOfQuota(h, "s1", CLAUDE)
    // The recovery must skip the whole openrouter provider, not just the
    // sibling the 402 named — and park when nothing else is left.
    await continueAndFail(h, "s1", CODEX)
    expect(h.session.log).not.toContain("switch:s1:openrouter/glm-flash")
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
  })
})

describe("goal continuity — limits lift while the goal runs on the paid fallback", () => {
  it("a lifted subscription reclaims the goal without a user prompt", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 402, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    h.clock.now += 61_000
    // The paid run fails; the recovery walks the ladder from the top and
    // finds claude's window lifted.
    await failUnit(h, "s1", GLM)
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("the earliest subscription reset reclaims first", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "600" })
    await observeStatus(h, CODEX, 429, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    h.clock.now += 61_000
    await failUnit(h, "s1", GLM)
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "wait:s1",
      "switch:s1:openai/codex-gpt-5",
      CONTINUE("s1"),
    ])
  })

  it("both subscriptions lifting while on paid: the top of the ladder wins", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 429, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    h.clock.now += 61_000
    await failUnit(h, "s1", GLM)
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
  })

  it("a subscription that re-limits while on paid does not trap the goal", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 402, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    h.clock.now += 61_000
    // Claude lifted — and immediately re-limited by usage.
    await observeStatus(h, CLAUDE, 429)
    await failUnit(h, "s1", GLM)
    // The recovery finds claude blocked again but codex's window lapsed.
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "wait:s1",
      "switch:s1:openai/codex-gpt-5",
      CONTINUE("s1"),
    ])
  })

  it("no mid-unit pull-away: a lifted subscription waits for the boundary", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 402, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: h.clock.now - 1,
      model: GLM,
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    // Both subscriptions recover while the paid unit is still productive.
    h.clock.now += 61_000
    await flush()
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    // At the next boundary the recovery moves the goal back up the ladder.
    await h.supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: h.clock.now,
      error: { type: "UnknownError", message: "Model quota exhausted" },
    })
    await flush()
    expect(h.session.log).toEqual([
      "switch:s1:openrouter/glm-flash",
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
  })
})

describe("goal continuity — several limit changes inside one goal", () => {
  it("exhausting the whole ladder twice still ends parked, bounded, and resumable", async () => {
    const h = harness()
    await runOutOfQuota(h, "s1", CLAUDE)
    await runOutOfQuota(h, "s1", CODEX)
    await runOutOfQuota(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", tier: "standard", detail: "quota exhausted" }),
    ])
    const delay = await wake(h)
    expect(delay).toBe(QUOTA_WINDOW + WAKE_GRACE_MS)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
    // The resumed goal burns through the ladder a second time: the wake
    // budget was refreshed, so the same bounded dance repeats and parks
    // again with one recorded resume attempt.
    await runOutOfQuota(h, "s1", CLAUDE)
    await runOutOfQuota(h, "s1", CODEX)
    await runOutOfQuota(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", tier: "standard", attempts: 1 }),
    ])
    expect(h.session.log.filter((entry) => entry === CONTINUE("s1"))).toHaveLength(5)
  })

  it("alternating limits never strand the goal: every fallthrough ends on a subscription", async () => {
    const h = harness()
    // Cycle 1: claude rate limited for a minute, codex burns out terminally.
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openai/codex-gpt-5"])
    await failUnit(h, "s1", CODEX)
    // The recovery reaches the paid fallback while claude's window holds.
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:openrouter/glm-flash",
      CONTINUE("s1"),
    ])
    // Cycle 2: claude's limit lifted; the paid continuation fails and the
    // recovery reclaims the top of the ladder.
    h.clock.now += 61_000
    await continueAndFail(h, "s1", GLM)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.session.log.filter((entry) => entry === CONTINUE("s1"))).toHaveLength(2)
  })
})

describe("goal continuity — every resource exhausted at once", () => {
  it("parks with a wake planned for the earliest lifting limit", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 429, { retryAfter: "120" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    await failUnit(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    expect(h.scheduler.pending()[0]?.delayMs).toBe(60_000 + WAKE_GRACE_MS)
    const status = await h.supervisor.status()
    expect(status.waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: h.clock.now + 60_000 + WAKE_GRACE_MS },
    ])
  })

  it("the goal resumes on whichever limit lifts first", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 429, { retryAfter: "120" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await failUnit(h, "s1", GLM)
    const delay = await wake(h)
    expect(delay).toBe(60_000 + WAKE_GRACE_MS)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("when the paid reset is earliest, the resume returns to the paid fallback", async () => {
    const h = harness()
    await observeStatus(h, GLM, 429, { retryAfter: "60" })
    await runOutOfQuota(h, "s1", CLAUDE)
    await continueAndFail(h, "s1", CODEX)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    const delay = await wake(h)
    expect(delay).toBe(60_000 + WAKE_GRACE_MS)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:openrouter/glm-flash",
      CONTINUE("s1"),
    ])
  })

  it("a parked goal keeps waiting while other sessions work through the outage", async () => {
    const h = harness()
    await observeStatus(h, CLAUDE, 429, { retryAfter: "60" })
    await observeStatus(h, CODEX, 429, { retryAfter: "120" })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await failUnit(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    // Claude's window ends: a different session with its own goal routes
    // there right away, while the parked goal keeps waiting for its wake.
    h.clock.now += 61_000
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s2" })
    expect(h.session.log).toContain("switch:s2:anthropic/claude-sonnet-4")
    expect(h.session.log.filter((entry) => entry.startsWith("switch:s1:"))).toEqual([
      "switch:s1:openrouter/glm-flash",
    ])
    expect(h.scheduler.pending()).toHaveLength(1)
  })
})

describe("goal continuity — subagents on their own tier", () => {
  function subagentStorage(): KeyFailStorage {
    return ladderStorage(
      {
        standard: [
          wireRef("anthropic", "claude-sonnet-4"),
          wireRef("openai", "codex-gpt-5"),
          wireRef("openrouter", "glm-flash"),
        ],
        quick: [wireRef("openrouter", "glm-flash")],
      },
      { explore: "quick" },
    )
  }

  function sharedTierStorage(): KeyFailStorage {
    return ladderStorage(
      {
        standard: [
          wireRef("anthropic", "claude-sonnet-4"),
          wireRef("openai", "codex-gpt-5"),
          wireRef("openrouter", "glm-flash"),
        ],
        quick: [wireRef("anthropic", "claude-sonnet-4"), wireRef("openai", "codex-gpt-5")],
      },
      { explore: "quick" },
    )
  }

  async function startSubagent(h: Harness, agent = "explore"): Promise<void> {
    await h.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s-sub",
      agent,
      model: GLM,
      requestKind: "primary",
    })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s-sub" })
  }

  it("a subagent runs its own tier while the main session runs the ladder", async () => {
    const h = harness({ storage: subagentStorage() })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:anthropic/claude-sonnet-4"])
    await startSubagent(h)
    expect(h.session.log).toEqual([
      "switch:s1:anthropic/claude-sonnet-4",
      "switch:s-sub:openrouter/glm-flash",
    ])
  })

  it("a subagent skips the subscription its parent exhausted (shared health)", async () => {
    const h = harness({ storage: sharedTierStorage() })
    await runOutOfQuota(h, "s1", CLAUDE)
    await startSubagent(h)
    expect(h.session.log).toContain("switch:s-sub:openai/codex-gpt-5")
    expect(h.session.log).not.toContain("switch:s-sub:anthropic/claude-sonnet-4")
  })

  it("a subagent parks when its tier is out and resumes when a model returns", async () => {
    const h = harness({ storage: subagentStorage() })
    await observeStatus(h, GLM, 402)
    await startSubagent(h)
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s-sub",
      at: h.clock.now - 1,
      model: GLM,
    })
    await h.supervisor.handleReport({
      kind: "execution-started",
      sessionID: "s-sub",
      at: h.clock.now,
    })
    await h.supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s-sub",
      at: h.clock.now,
      error: { type: "UnknownError", message: "Model quota exhausted" },
    })
    await flush()
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s-sub", tier: "quick" }),
    ])
    // The parked subagent wakes on its own and continues when credits return.
    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS
    await h.scheduler.fire()
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s-sub",
      "switch:s-sub:openrouter/glm-flash",
      CONTINUE("s-sub"),
    ])
  })

  it("the main session is unaffected while its subagent waits", async () => {
    const h = harness({ storage: subagentStorage() })
    await observeStatus(h, GLM, 402)
    await startSubagent(h)
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s-sub",
      at: h.clock.now - 1,
      model: GLM,
    })
    await h.supervisor.handleReport({
      kind: "execution-started",
      sessionID: "s-sub",
      at: h.clock.now,
    })
    await h.supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s-sub",
      at: h.clock.now,
      error: { type: "UnknownError", message: "Model quota exhausted" },
    })
    await flush()
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toContain("switch:s1:anthropic/claude-sonnet-4")
    expect(parseParkedPayload(storedParked(h.storage)).map((record) => record.sessionID)).toEqual([
      "s-sub",
    ])
  })

  it("the main goal parks while the subagent's tier still has room", async () => {
    const h = harness({
      storage: ladderStorage(
        {
          standard: [wireRef("anthropic", "claude-sonnet-4")],
          quick: [wireRef("openrouter", "glm-flash")],
        },
        { explore: "quick" },
      ),
    })
    await runOutOfQuota(h, "s1", CLAUDE)
    expect(parseParkedPayload(storedParked(h.storage)).map((record) => record.sessionID)).toEqual([
      "s1",
    ])
    await startSubagent(h)
    expect(h.session.log).toContain("switch:s-sub:openrouter/glm-flash")
    // The main goal's wake fires and resumes it on the (single) ladder rung.
    const delay = await wake(h)
    expect(delay).toBe(QUOTA_WINDOW + WAKE_GRACE_MS)
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
  })

  it("no cross-tier borrowing: an empty subagent tier defers and the main goal continues", async () => {
    const h = harness({
      storage: ladderStorage(
        {
          standard: [wireRef("anthropic", "claude-sonnet-4")],
          advanced: [],
        },
        { explore: "advanced" },
      ),
    })
    await startSubagent(h)
    const receipts = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "defer", reason: "routing-defer" })
    expect(h.session.log).toEqual([])
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:anthropic/claude-sonnet-4"])
  })

  it("an interrupted subagent unit triggers no failover", async () => {
    const h = harness({ storage: subagentStorage() })
    await startSubagent(h)
    expect(h.session.log).toEqual(["switch:s-sub:openrouter/glm-flash"])
    await h.supervisor.handleReport({
      kind: "execution-started",
      sessionID: "s-sub",
      at: h.clock.now,
    })
    await h.supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s-sub",
      at: h.clock.now,
      reason: "user",
    })
    await flush()
    expect(h.session.log).toEqual(["switch:s-sub:openrouter/glm-flash"])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })
})

describe("goal continuity — the goal finishes without interaction", () => {
  it("full journey: exhaustion, park, wake, resume, completion", async () => {
    const h = harness()
    await runOutOfQuota(h, "s1", CLAUDE)
    await continueAndFail(h, "s1", CODEX)
    await continueAndFail(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    await wake(h)
    // The resumed continuation runs to completion on the first subscription.
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: h.clock.now - 1,
      model: CLAUDE,
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    await h.supervisor.handleReport({
      kind: "execution-succeeded",
      sessionID: "s1",
      at: h.clock.now,
    })
    await flush()
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
    // No user prompt was ever needed after the first one: every prompt echo
    // in the log is the machine's own continuation.
    const prompts = h.session.log.filter((entry) => entry.startsWith("prompt:s1:"))
    expect(prompts.every((entry) => entry === CONTINUE("s1"))).toBe(true)
    const receipts = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      model: CLAUDE,
      reason: "preferred",
    })
  })

  it("the user interrupting the paid run stops the machine politely", async () => {
    const h = harness()
    await runOutOfQuota(h, "s1", CLAUDE)
    await continueAndFail(h, "s1", CODEX)
    // The paid continuation turn starts, and the user interrupts it.
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: h.clock.now - 1,
      model: GLM,
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    await h.supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: h.clock.now,
      reason: "user",
    })
    await flush()
    // No failover, no park, no continuation: the user owns the session now.
    expect(h.session.log).toEqual([
      "switch:s1:anthropic/claude-sonnet-4",
      "wait:s1",
      "switch:s1:openai/codex-gpt-5",
      CONTINUE("s1"),
      "wait:s1",
      "switch:s1:openrouter/glm-flash",
      CONTINUE("s1"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("OBSERVE runs the whole journey without touching the session", async () => {
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("observe", {
        standard: [
          wireRef("anthropic", "claude-sonnet-4"),
          wireRef("openai", "codex-gpt-5"),
          wireRef("openrouter", "glm-flash"),
        ],
      }),
    )
    const h = harness({ storage })
    const observeTurn = async (model: { providerID: string; id: string }): Promise<void> => {
      // The host echoes its model via model-request: in OBSERVE the prompt
      // hook never switched, so a model-selected echo would read as a user
      // pick and rightly defer to it.
      await h.supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model,
        requestKind: "primary",
      })
      await h.supervisor.handleReport({
        kind: "execution-started",
        sessionID: "s1",
        at: h.clock.now,
      })
      await h.supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: h.clock.now,
        error: { type: "UnknownError", message: "Model quota exhausted" },
      })
      await flush()
    }
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await observeTurn(CLAUDE)
    await observeTurn(CODEX)
    expect(h.session.log).toEqual([])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipts.length).toBeGreaterThanOrEqual(2)
    expect(receipts.every((receipt) => receipt.decision.kind === "observe-only")).toBe(true)
  })

  it("a manual pin on the paid fallback: its depletion neither borrows nor strands others", async () => {
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON(
        "active",
        {
          standard: [
            wireRef("anthropic", "claude-sonnet-4"),
            wireRef("openai", "codex-gpt-5"),
            wireRef("openrouter", "glm-flash"),
          ],
        },
        { providerID: "openrouter", id: "glm-flash" },
      ),
    )
    const h = harness({ storage })
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    await failUnit(h, "s1", GLM)
    // Manual intent wins: no silent borrow, and no parked record either.
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
    // The pin is global, and it is blocked: a second session parked on the
    // same pin gets the pin-blocked park receipt, never a borrowed rung.
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s2" })
    const receipts = parseReceiptsPayload(storedReceipts(h.storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "park", reason: "pin-blocked" })
    expect(h.session.log).toEqual(["switch:s1:openrouter/glm-flash"])
  })

  it("codex capacity exhaustion (usage headers) routes around the middle rung", async () => {
    const h = harness()
    await observeStatus(h, CODEX, 200, {
      capturedHeaders: { "x-codex-primary-used-percent": "100" },
    })
    await runOutOfQuota(h, "s1", CLAUDE)
    // The recovery skips the capacity-drained middle rung straight to paid.
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:openrouter/glm-flash",
      CONTINUE("s1"),
    ])
  })
})

describe("goal continuity — parked goal survives idle wake cycles", () => {
  it("still-blocked wake cycles never burn the resume budget, and a later lift resumes", async () => {
    const h = harness()
    await runOutOfQuota(h, "s1", CLAUDE)
    await runOutOfQuota(h, "s1", CODEX)
    await runOutOfQuota(h, "s1", GLM)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", detail: "quota exhausted" }),
    ])
    // More wake cycles than the give-up budget, every one finding all three
    // models still out (each window is renewed just before its wake falls
    // due): each cycle re-parks without consuming an attempt.
    const continuesBeforePark = h.session.log.filter((entry) => entry === CONTINUE("s1")).length
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const delayMs = h.scheduler.pending()[0]?.delayMs ?? 0
      h.clock.now += delayMs - WAKE_GRACE_MS
      await observeStatus(h, CLAUDE, 402)
      await observeStatus(h, CODEX, 402)
      await observeStatus(h, GLM, 402)
      h.clock.now += WAKE_GRACE_MS
      await h.scheduler.fire()
      const [record] = parseParkedPayload(storedParked(h.storage))
      expect(record).toMatchObject({ sessionID: "s1", tier: "standard" })
      expect(record?.attempts).toBeUndefined()
    }
    expect(h.session.log.filter((entry) => entry === CONTINUE("s1"))).toHaveLength(
      continuesBeforePark,
    )
    // When the subscriptions finally recover, the very next wake resumes the goal.
    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS
    await h.scheduler.fire()
    expect(h.session.log.slice(-3)).toEqual([
      "wait:s1",
      "switch:s1:anthropic/claude-sonnet-4",
      CONTINUE("s1"),
    ])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })
})
