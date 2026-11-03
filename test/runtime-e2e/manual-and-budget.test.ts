// covers: ["ADP-015", "ADP-019", "ADP-028"]
/**
 * Runtime E2E on a real OpenCode host: manual selection wins (ADP-028),
 * single-failure counting toward the circuit breaker (ADP-019), and the
 * per-task escalation budget (ADP-015).
 *
 * Manual selection is driven through the real host surface the same way the
 * plugin's own session ops drive it: `client.session.switchModel` — verified
 * to fire `session.model.selected` for manual AND plugin switches
 * (src/adapters/opencode/session-ops.ts), so a switch issued from outside the
 * plugin attributes to the user and arms manual-selection suppression.
 *
 * Script sequencing: per-model queues are immune to the per-run global reset
 * and repeat their last behavior once exhausted, so every phase installs its
 * own queues and fresh sessions' title calls are front-loaded with a benign
 * success.
 */
import { afterAll, describe, expect, it } from "vitest"

import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"
import type { Receipt } from "../../src/state/receipts/types.js"
import type {
  FakeProviderBehavior,
  FakeProviderScript,
} from "../fixtures/fake-provider/scenarios.js"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

const receipts = async (host: StartedHost): Promise<Receipt[]> =>
  (await rpc(host).receipts.list()) as Receipt[]

const settle = async (ms = 500): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll the receipt list until `predicate` holds or the deadline passes. */
const pollReceipts = async (
  host: StartedHost,
  predicate: (list: Receipt[]) => boolean,
  deadlineMs: number,
): Promise<Receipt[]> => {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const list = await receipts(host)
    if (predicate(list)) return list
    if (Date.now() > deadline) return list
    await settle(500)
  }
}

interface StatusSnapshot {
  mode: string
  parked: number
  tiers: Record<string, { breaker: string }[]>
}

const status = async (host: StartedHost): Promise<StatusSnapshot> =>
  (await rpc(host).status.get()) as StatusSnapshot

const stop = async (host: StartedHost, sessionID: string): Promise<void> => {
  try {
    await host.client.session.interrupt({ sessionID })
  } catch {
    // session already idle
  }
}

const reply = (text: string): FakeProviderScript => ({
  behaviors: [
    {
      body: JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "fake-model",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    },
  ],
})

/** The model id a provider call carried (parsed from its request body). */
const callModel = (call: { body: string }): string => {
  try {
    return (JSON.parse(call.body) as { model?: string }).model ?? "?"
  } catch {
    return "?"
  }
}

const models = {
  "fake-model": { name: "Fake Model" },
  "fake-model-2": { name: "Fake Model 2" },
  "fake-model-3": { name: "Fake Model 3" },
}

describe("runtime e2e: manual selection, breaker counting, escalation budget", () => {
  it(
    "defers admission with manual-selection after an external model switch and re-enables on a tier request or mode change",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({ models })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: {
          quick: [],
          standard: [{ providerID: "fake", id: "fake-model" }],
          advanced: [{ providerID: "fake", id: "fake-model-2" }],
        },
      })
      // Per-model queues: fake-model serves titles and re-enabled turns,
      // fake-model-2 serves the user's picked session.
      host.provider.setModelScripts({
        "fake-model": { behaviors: scenarioScript("success").behaviors },
        "fake-model-2": { behaviors: reply("user pick").behaviors },
      })

      // The user picks a model on the session from OUTSIDE the plugin: the
      // same host session API the TUI uses. The resulting
      // `session.model.selected` attributes to the user (no pending
      // own-switch note), arming manual-selection suppression.
      const session = await host.client.session.create()
      await host.client.session.switchModel({
        sessionID: session.id,
        model: { providerID: "fake", id: "fake-model-2" },
      })
      // The selection event reaches the plugin through the async event pump;
      // give it time to land before the admission that must observe it.
      await settle(2_000)

      const pickedCalls = host.provider.calls.filter(
        (call) => callModel(call) === "fake-model-2",
      ).length
      const run = await host.run({ text: "on the user's pick", sessionID: session.id })

      // The next prompt admission defers with detail "manual-selection".
      const list = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "defer" &&
              r.decision.reason === "routing-defer" &&
              r.decision.detail === "manual-selection",
          ),
        30_000,
      )
      expect(
        list.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "defer" &&
            r.decision.reason === "routing-defer" &&
            r.decision.detail === "manual-selection",
        ),
      ).toBe(true)

      // The user's model is used: Adaptive applied nothing for this session,
      // and the turn executed on fake-model-2.
      expect(list.some((r) => r.sessionID === session.id && r.decision.kind === "apply")).toBe(
        false,
      )
      const afterPick = host.provider.calls.filter(
        (call) => callModel(call) === "fake-model-2",
      ).length
      expect(afterPick).toBeGreaterThan(pickedCalls)
      await stop(host, run.sessionID)

      // A tier request is the user/agent steering Adaptive back (ADP-028):
      // suppression lifts and the next admission routes the standard tier.
      await rpc(host).tierRequest.set(session.id, "standard")
      const steered = await host.run({ text: "route again", sessionID: session.id })
      const steeredList = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model",
          ),
        30_000,
      )
      const applied = steeredList.find(
        (r) =>
          r.sessionID === session.id &&
          r.decision.kind === "apply" &&
          r.decision.model.id === "fake-model",
      )
      expect(applied).toBeDefined()
      if (applied?.decision.kind === "apply") expect(applied.decision.reason).toBe("preferred")
      expect(steered).toBeDefined()
      await stop(host, session.id)

      // A session-mode change is the user steering Adaptive explicitly too.
      const second = await host.client.session.create()
      await host.client.session.switchModel({
        sessionID: second.id,
        model: { providerID: "fake", id: "fake-model-2" },
      })
      await settle(2_000)
      const suppressed = await host.run({ text: "still picked", sessionID: second.id })
      const suppressedList = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === second.id &&
              r.decision.kind === "defer" &&
              r.decision.reason === "routing-defer" &&
              r.decision.detail === "manual-selection",
          ),
        30_000,
      )
      expect(
        suppressedList.some(
          (r) =>
            r.sessionID === second.id &&
            r.decision.kind === "defer" &&
            r.decision.reason === "routing-defer" &&
            r.decision.detail === "manual-selection",
        ),
      ).toBe(true)
      await rpc(host).sessionMode.set(second.id, "active")
      await host.run({ text: "mode change re-enables", sessionID: second.id })
      const reEnabled = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === second.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model",
          ),
        30_000,
      )
      expect(
        reEnabled.some(
          (r) =>
            r.sessionID === second.id &&
            r.decision.kind === "apply" &&
            r.decision.model.id === "fake-model",
        ),
      ).toBe(true)
      await stop(host, suppressed.sessionID)
    },
  )

  it(
    "counts one failed attempt once toward the breaker: the breaker opens only at the threshold-th countable attempt",
    { timeout: 180_000 },
    async () => {
      // Default breaker threshold is 5 consecutive countable failures
      // (DEFAULT_BREAKER_CONFIG.failureThreshold). Countable here is outage
      // (503): context-overflow/content-policy evidence is request-level and
      // deliberately never breaker-counted.
      const outageFast: FakeProviderBehavior = {
        ...scenarioScript("outage").behaviors[0],
        headers: { "retry-after": "1" },
      }
      const host = await startHost({ models })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: {
          quick: [],
          standard: [
            { providerID: "fake", id: "fake-model" },
            { providerID: "fake", id: "fake-model-2" },
          ],
          advanced: [],
        },
      })
      host.provider.setModelScripts({
        "fake-model": { behaviors: scenarioScript("success").behaviors },
        "fake-model-2": { behaviors: scenarioScript("success").behaviors },
      })

      const breaker = (snap: StatusSnapshot): string =>
        snap.tiers["standard"]?.[0]?.breaker ?? "closed"

      // One session for every turn: the fresh-session title is consumed by
      // the warmup turn, so no auxiliary title call can pollute the count.
      const session = await host.client.session.create()
      await host.run({ text: "warmup turn", sessionID: session.id })
      const warmList = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.outcome?.status === "succeeded",
          ),
        60_000,
      )
      expect(
        warmList.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "apply" &&
            r.outcome?.status === "succeeded",
        ),
      ).toBe(true)

      // Every main call on the preferred resource now fails with a definitive
      // outage; the tier sibling stays healthy for the owned recovery.
      host.provider.setModelScripts({
        "fake-model": { behaviors: [outageFast] },
        "fake-model-2": { behaviors: scenarioScript("success").behaviors },
      })

      // The host natively retries a 503 (v2 caps retries with a ~1s
      // Retry-After honored), so one user turn carries several attempts —
      // each must count ONCE (the ADP-019 dedup across the http-response
      // signal, the retry hook, and the terminal). Drive one failing turn
      // and sample (outage attempts, breaker state) concurrently: the
      // breaker must first read open only at the 5th attempt. Double
      // counting trips it at attempt 3.
      const samples: { attempts: number; breaker: string }[] = []
      const promptPromise = host.client.session
        .prompt({ sessionID: session.id, text: "tripping turn" })
        .catch(() => undefined)
      const samplingDeadline = Date.now() + 90_000
      for (;;) {
        const snap = await status(host)
        const attempts =
          // The warmup turn consumed exactly two fake-model calls (the
          // session's title and its main completion) before the outage
          // queue was installed; the difference is the outage attempts.
          host.provider.calls.filter((call) => callModel(call) === "fake-model").length - 2
        samples.push({ attempts, breaker: breaker(snap) })
        if (breaker(snap) === "open" || attempts > 8 || Date.now() > samplingDeadline) break
        await settle(250)
      }
      await promptPromise
      await host.client.session.wait({ sessionID: session.id }).catch(() => undefined)
      await stop(host, session.id)
      const firstOpen = samples.findIndex((sample) => sample.breaker === "open")
      expect(firstOpen).toBeGreaterThan(-1)
      expect(samples[firstOpen]?.attempts).toBeGreaterThanOrEqual(5)
    },
  )

  it(
    "escalates at most twice per user prompt and resets the budget on a fresh prompt",
    { timeout: 240_000 },
    async () => {
      // quick → standard → advanced, one resource each, every one of them
      // failing with a definitive context rejection (capability evidence).
      // One prompt escalates quick→standard (budgetRemaining 1), then
      // standard→advanced (budgetRemaining 0); the third failure finds the
      // budget exhausted and defers. A fresh user prompt gets a new budget
      // and escalates again.
      const host = await startHost({ models })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: {
          quick: [{ providerID: "fake", id: "fake-model" }],
          standard: [{ providerID: "fake", id: "fake-model-2" }],
          advanced: [{ providerID: "fake", id: "fake-model-3" }],
        },
      })
      const ctx = scenarioScript("context-rejection").behaviors[0]
      host.provider.setModelScripts({
        "fake-model": { behaviors: [scenarioScript("success").behaviors[0], ctx] },
        "fake-model-2": { behaviors: [ctx] },
        "fake-model-3": { behaviors: [ctx] },
      })

      const session = await host.client.session.create()
      // Pin the task to the quick tier through the control surface: the
      // sticky request routes this prompt's admission into the quick tier,
      // whose failure starts the escalation ladder.
      await rpc(host).tierRequest.set(session.id, "quick")

      await host.run({ text: "escalate the corpus", sessionID: session.id })

      // First budget: one escalation onto standard (1 left), one onto
      // advanced (0 left), then the exhausted defer.
      const firstList = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "defer" &&
              r.decision.reason === "escalation-budget-exhausted",
          ),
        120_000,
      )
      const escalations = firstList.filter(
        (r) => r.sessionID === session.id && r.decision.kind === "escalate",
      )
      const toStandard = escalations.filter(
        (r) =>
          r.decision.kind === "escalate" &&
          r.decision.tier === "standard" &&
          r.decision.target.id === "fake-model-2" &&
          r.decision.budgetRemaining === 1,
      )
      const toAdvanced = escalations.filter(
        (r) =>
          r.decision.kind === "escalate" &&
          r.decision.tier === "advanced" &&
          r.decision.target.id === "fake-model-3" &&
          r.decision.budgetRemaining === 0,
      )
      expect(toStandard.length).toBe(1)
      expect(toAdvanced.length).toBe(1)
      expect(
        firstList.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "defer" &&
            r.decision.reason === "escalation-budget-exhausted",
        ),
      ).toBe(true)
      await stop(host, session.id)

      // A fresh user prompt resets the budget: the same sticky quick request
      // re-admits the failing quick resource and the ladder escalates again
      // (a second budgetRemaining-1 escalation appears).
      const before = firstList.filter(
        (r) =>
          r.sessionID === session.id &&
          r.decision.kind === "escalate" &&
          r.decision.budgetRemaining === 1,
      ).length
      const again = await host.run({ text: "fresh prompt, fresh budget", sessionID: session.id })
      const secondList = await pollReceipts(
        host,
        (all) =>
          all.filter(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "escalate" &&
              r.decision.budgetRemaining === 1,
          ).length > before,
        120_000,
      )
      expect(
        secondList.filter(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "escalate" &&
            r.decision.budgetRemaining === 1,
        ).length,
      ).toBeGreaterThan(before)
      await stop(host, again.sessionID)
    },
  )
})
