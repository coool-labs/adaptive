/**
 * Runtime E2E: supervision lifecycle on a real OpenCode host (ADP-041).
 * Covers: tier escalation on capability evidence, quota exhaustion
 * classification, circuit breaker half-open probe + preferred recovery,
 * parked-work persistence across restart, durable tool side effects through
 * owned recovery, and native /goal supervision.
 *
 * Script sequencing: the fake provider repeats its last behavior once the
 * script is exhausted, and fresh sessions consume one benign title behavior
 * first (prepended by startHost). Per-model queues (setModelScripts) are
 * immune to that reset and are used whenever a phase must not leak success
 * behaviors into a later phase.
 */
// covers: ["ADP-008", "ADP-009", "ADP-013", "ADP-014", "ADP-015", "ADP-016", "ADP-018", "ADP-019", "ADP-022", "ADP-023", "ADP-024", "ADP-025", "ADP-026", "ADP-041"]
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const receipts = async (host: StartedHost): Promise<Receipt[]> => {
  const list = await rpc(host).receipts.list()
  return list as Receipt[]
}

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

const stop = async (host: StartedHost, sessionID: string): Promise<void> => {
  try {
    await host.client.session.interrupt({ sessionID })
  } catch {
    // session already idle
  }
}

const status = async (
  host: StartedHost,
): Promise<{ mode: string; parked: number; tiers: Record<string, { breaker: string }[]> }> =>
  (await rpc(host).status.get()) as {
    mode: string
    parked: number
    tiers: Record<string, { breaker: string }[]>
  }

const overflow413: FakeProviderScript = {
  behaviors: [
    { status: 413, body: JSON.stringify({ error: { message: "context length exceeded" } }) },
    scenarioScript("success").behaviors[0],
  ],
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

const quotaBehavior: FakeProviderBehavior = {
  status: 429,
  headers: {
    "retry-after": "60",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-requests": "1m",
    "x-ratelimit-reset-tokens": "1m",
  },
  body: JSON.stringify({
    error: { message: "quota exceeded for this billing period", type: "fake_error", code: null },
  }),
}

const rateLimited1: FakeProviderBehavior = {
  status: 429,
  headers: { "retry-after": "1" },
  body: JSON.stringify({ error: { message: "rate limited", type: "fake_error", code: null } }),
}

const breakerStatus = async (host: StartedHost): Promise<string> => {
  const snap = await status(host)
  return snap.tiers["standard"]?.[0]?.breaker ?? "closed"
}

describe("runtime e2e: supervision lifecycle", () => {
  it(
    "escalates the tier on context overflow and continues on the escalated resource",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({
        script: overflow413,
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
        tiers: {
          quick: [],
          standard: [{ providerID: "fake", id: "fake-model" }],
          advanced: [{ providerID: "fake", id: "fake-model-2" }],
        },
      })

      // Per-model queues: the preferred standard resource answers the fresh
      // session's title call, then fails every real call with a definitive
      // 413 (context overflow); the advanced resource always succeeds.
      host.provider.setModelScripts({
        "fake-model": {
          behaviors: [scenarioScript("success").behaviors[0], overflow413.behaviors[0]],
        },
        "fake-model-2": { behaviors: [scenarioScript("success").behaviors[0]] },
      })

      const run = await host.run({ script: overflow413, text: "summarize a huge corpus" })

      const list = await pollReceipts(
        host,
        (all) => all.some((r) => r.decision.kind === "escalate"),
        60_000,
      )
      const escalate = list.find((r) => r.decision.kind === "escalate")
      expect(escalate).toBeDefined()
      if (escalate?.decision.kind !== "escalate") return
      expect(escalate.decision.step).toBe("tier")
      expect(escalate.decision.tier).toBe("advanced")
      expect(escalate.decision.target).toEqual({ providerID: "fake", id: "fake-model-2" })
      expect(escalate.sessionID).toBe(run.sessionID)

      // The owned continuation opens a fresh unit on the escalated resource;
      // its provider call succeeds (per-model queue for fake-model-2).
      const continued = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.id > escalate.id &&
              r.sessionID === run.sessionID &&
              r.outcome?.status === "succeeded",
          ),
        60_000,
      )
      expect(
        continued.some(
          (r) =>
            r.id > escalate.id &&
            r.sessionID === run.sessionID &&
            r.outcome?.status === "succeeded",
        ),
      ).toBe(true)
      await stop(host, run.sessionID)
    },
  )

  it(
    "classifies quota exhaustion and falls back within the tier",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
        tiers: {
          quick: [],
          standard: [
            { providerID: "fake", id: "fake-model" },
            { providerID: "fake", id: "fake-model-2" },
          ],
          advanced: [],
        },
      })

      // Per-model queues: the preferred resource serves the title call then
      // fails every real call with quota exhaustion; the fallback resource
      // always succeeds. Per-model queues are immune to the per-run global
      // script reset, so a zombie retry can never observe a success here.
      host.provider.setModelScripts({
        "fake-model": { behaviors: [scenarioScript("success").behaviors[0], quotaBehavior] },
        "fake-model-2": { behaviors: [scenarioScript("success").behaviors[0]] },
      })

      const run = await host.run({ text: "use the quota" })

      // The prompt-hook admission applies the preferred resource for the
      // first turn; the quota-shaped 429 (retry-after 60) arrives with
      // native.retry=false, so the host does not retry and the plugin does
      // not veto — recovery defers to the next safe boundary (ADP-014). The
      // next user prompt on the same session is that boundary.
      const preferredReceipt = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.decision.kind === "apply" &&
              r.decision.reason === "preferred",
          ),
        30_000,
      )
      const preferred = preferredReceipt.find(
        (r) =>
          r.sessionID === run.sessionID &&
          r.decision.kind === "apply" &&
          r.decision.reason === "preferred",
      )
      expect(preferred).toBeDefined()
      if (preferred?.decision.kind !== "apply") return
      expect(preferred.decision.model.id).toBe("fake-model")

      // The provider saw exactly the title call and the failed main call on
      // the preferred resource — no native retry, no owned continuation.
      const modelsAfterFirst = host.provider.calls
        .map((c) => {
          try {
            return (JSON.parse(c.body) as { model?: string }).model ?? "?"
          } catch {
            return "?"
          }
        })
        .filter((m) => m !== "?")
      expect(modelsAfterFirst).toEqual(["fake-model", "fake-model"])

      await host.run({ text: "try again", sessionID: run.sessionID })

      // At the next admission the preferred resource is still inside its
      // rate-limit window, so the tier sibling is applied with the skip
      // evidence naming it (ADP-009: quota-shaped evidence stays
      // failover-eligible; the runtime category is the coarser rate_limited
      // because the host's failure report carries no response headers — the
      // header refinement is proven in the classifier unit tests). The
      // prompt-time admission receipts carry no unitID, so the episode
      // outcome lands on no receipt; the executed model sequence below is
      // the execution evidence.
      const second = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model-2",
          ),
        30_000,
      )
      const fallback = second.find(
        (r) =>
          r.sessionID === run.sessionID &&
          r.decision.kind === "apply" &&
          r.decision.model.id === "fake-model-2",
      )
      expect(fallback).toBeDefined()
      if (fallback?.decision.kind !== "apply") return
      expect(fallback.decision.evidence.skipped).toEqual([
        { ref: { providerID: "fake", id: "fake-model" }, why: "rate-limited" },
      ])
      // The fallback turn actually executed on the fallback resource.
      const models = host.provider.calls
        .map((c) => {
          try {
            return (JSON.parse(c.body) as { model?: string }).model ?? "?"
          } catch {
            return "?"
          }
        })
        .filter((m) => m !== "?")
      expect(models).toEqual(["fake-model", "fake-model", "fake-model-2"])
      // Quota-shaped infra failure never escalates capability and never
      // parks while a tier sibling is healthy (ADP-013).
      expect(second.some((r) => r.decision.kind === "escalate")).toBe(false)
      expect(second.some((r) => r.decision.kind === "park")).toBe(false)
      await stop(host, run.sessionID)
    },
  )

  it(
    "opens the circuit breaker, admits one half-open probe, and recovers the preferred resource",
    { timeout: 300_000 },
    async () => {
      const outage = scenarioScript("outage")
      const host = await startHost({})
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      })

      // Per-model queue: every fake-model call fails with a 503 (countable
      // outage). The 1s Retry-After keeps the host's native retry loop fast
      // (its own default backoff is ~2s and it waits out larger Retry-After
      // values verbatim), and the veto ping-pong (recovery = the tier's only
      // candidate) makes each episode fail in milliseconds — the five
      // consecutive countable failures accumulate within a couple of runs.
      // No success behavior exists in this phase, so no late call can reset
      // the breaker either.
      const outageFast: FakeProviderBehavior = {
        ...outage.behaviors[0],
        headers: { "retry-after": "1" },
      }
      host.provider.setModelScripts({
        "fake-model": { behaviors: [outageFast] },
      })

      // Repeated failing units accumulate consecutive countable failures
      // until the breaker opens. The owned-recovery veto never fires here
      // (the host does not want to retry), so each awaited run fails fast
      // and nothing survives it.
      const deadline = Date.now() + 120_000
      const launched: string[] = []
      for (;;) {
        const breaker = await breakerStatus(host)
        if (breaker !== "closed") break
        if (Date.now() > deadline) throw new Error(`breaker never opened (last: ${breaker})`)
        const run = await host.run({ text: "fail again" }).catch(() => undefined)
        if (run !== undefined) launched.push(run.sessionID)
      }
      for (const sessionID of launched) await stop(host, sessionID)
      // Safety net: wait until the provider has gone quiet, re-interrupting
      // on every round — a pending owned-recovery continuation can prompt a
      // fresh episode after an interrupt. A grind alive when the cooldown
      // elapses would consume the half-open probe through its retry hook's
      // recovery assessment (and a success call landing after the success
      // script is installed below would close the breaker before the probe).
      const quietDeadline = Date.now() + 60_000
      for (;;) {
        for (const sessionID of launched) await stop(host, sessionID)
        const before = host.provider.requestCount()
        await settle(3_000)
        if (host.provider.requestCount() === before || Date.now() > quietDeadline) break
      }

      // Wait out the open window. baseOpenMs is 30s, but if a phase grind
      // consumed the half-open probe and its episode failed, the breaker
      // reopens with the doubled 60s window, so wait 65s past quiet: with
      // the provider quiet, no assessment runs in between, so the probe
      // prompt below is the next admission to assess the record.
      await settle(65_000)
      host.provider.setModelScripts({
        "fake-model": { behaviors: [scenarioScript("success").behaviors[0]] },
      })
      const probeRun = await host.run({ text: "probe me" })
      const probeList = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === probeRun.sessionID &&
              r.decision.kind === "apply" &&
              r.decision.reason === "probe",
          ),
        30_000,
      )
      const probe = probeList.find(
        (r) =>
          r.sessionID === probeRun.sessionID &&
          r.decision.kind === "apply" &&
          r.decision.reason === "probe",
      )
      expect(probe).toBeDefined()
      if (probe?.decision.kind !== "apply") return
      expect(probe.decision.evidence.probeId).toBeDefined()

      // Probe success closes the breaker: later units route to the preferred
      // resource normally again.
      const next = await host.run({ text: "after recovery" })
      const recovered = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === next.sessionID &&
              r.decision.kind === "apply" &&
              r.decision.reason === "preferred",
          ),
        30_000,
      )
      expect(
        recovered.some(
          (r) =>
            r.sessionID === next.sessionID &&
            r.decision.kind === "apply" &&
            r.decision.reason === "preferred",
        ),
      ).toBe(true)
    },
  )

  it(
    "persists parked work across a host restart and resumes it at the idle boundary",
    { timeout: 240_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "adaptive-e2e-home-"))
      const project = mkdtempSync(join(tmpdir(), "adaptive-e2e-proj-"))
      try {
        const first = await startHost({
          script: scenarioScript("success"),
          paths: { home, project },
        })
        const warm = await first.run({ script: scenarioScript("success"), text: "seed session" })
        await first.close()

        // Plant a parked record exactly as the plugin persists one: the
        // previous process parked this unit; the restarted host must resume
        // it — a clean continuation, never a replayed prompt.
        const hex = (text: string): string => {
          let out = ""
          for (const c of text) out += c.charCodeAt(0).toString(16).padStart(4, "0")
          return out
        }
        const key = `plugin:${hex("coool.adaptive")}:coool.adaptive/parked`
        const record = {
          id: `${warm.sessionID}#1`,
          sessionID: warm.sessionID,
          tier: "standard",
          reason: "all-blocked",
          detail: "planted by restart e2e",
          parkedAt: Date.now(),
        }
        const value = JSON.stringify({ version: 1, parked: [record] })
        execFileSync(
          "sqlite3",
          [
            join(home, "data/opencode/opencode.db"),
            `INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES ('${key}', '${value.replaceAll("'", "''")}', ${String(Date.now())}, ${String(Date.now())})`,
          ],
          { encoding: "utf8" },
        )

        const second = await startHost({
          script: scenarioScript("success"),
          models: {
            "fake-model": { name: "Fake Model" },
            "fake-model-2": { name: "Fake Model 2" },
          },
          paths: { home, project },
        })
        hosts.push(second)
        await rpc(second).settings.set({
          version: 1,
          mode: "control",
          tiers: {
            quick: [],
            standard: [{ providerID: "fake", id: "fake-model-2" }],
            advanced: [],
          },
        })
        // An unrelated unit drives the host to an idle boundary, at which the
        // parked record is eligible for resumption.
        await second.run({ script: scenarioScript("success"), text: "trigger idle" })

        const list = await pollReceipts(
          second,
          (all) => all.some((r) => r.decision.kind === "apply" && r.sessionID === warm.sessionID),
          60_000,
        )
        const resumed = list.find(
          (r) => r.decision.kind === "apply" && r.sessionID === warm.sessionID,
        )
        expect(resumed).toBeDefined()
        if (resumed?.decision.kind !== "apply") return
        expect(resumed.decision.model.id).toBe("fake-model-2")
        const snap = await status(second)
        expect(snap.parked).toBe(0)
      } finally {
        rmSync(home, { recursive: true, force: true })
        rmSync(project, { recursive: true, force: true })
      }
    },
  )

  it(
    "keeps durable tool side effects through owned recovery without replay",
    { timeout: 240_000 },
    async () => {
      // The first main call produces a bash tool call that touches a marker
      // file; the follow-up call hits a 429, and owned recovery continues
      // from session state on the fallback resource.
      const toolCall: FakeProviderScript = {
        behaviors: [
          {
            body: JSON.stringify({
              id: "chatcmpl-tool",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_marker",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({ command: "echo once >> marker.txt" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          },
          scenarioScript("rate-limited").behaviors[0],
          scenarioScript("success").behaviors[0],
        ],
      }
      const host = await startHost({
        script: toolCall,
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
        tiers: {
          quick: [],
          standard: [
            { providerID: "fake", id: "fake-model" },
            { providerID: "fake", id: "fake-model-2" },
          ],
          advanced: [],
        },
      })

      const run = await host.run({ script: toolCall, text: "create the marker" })

      // Owned recovery continues the episode after the rate-limited attempt.
      // By the continuation's admission the preferred resource's short
      // rate-limit window has expired, so the same preferred resource is
      // re-applied — the recovery is horizontal within the tier either way.
      const list = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.decision.kind === "apply" &&
              r.outcome?.status === "succeeded",
          ),
        90_000,
      )
      // Infra failure never escalates capability (ADP-013): no escalate receipt.
      expect(list.some((r) => r.decision.kind === "escalate")).toBe(false)
      // The marker exists exactly once: recovery continued from session
      // state instead of replaying the original prompt (ADP-023) — a replay
      // would append a second line.
      const marker = readFileSync(join(host.project, "marker.txt"), "utf8")
      expect(marker.split("\n").filter((line) => line === "once")).toHaveLength(1)
      await stop(host, run.sessionID)
    },
  )

  it(
    "supervises a native /goal episode: fails over mid-goal and recovers at the next boundary",
    { timeout: 240_000 },
    async () => {
      // GOAL.md's /goal scenario on a real host (2.2.5): the goal command
      // opens one supervised unit; the goal's auto-continuation turns run
      // inside it with no prompt hook of their own. When the preferred
      // resource fails mid-goal, the retry veto owns recovery at the safe
      // boundary (settle → switch → continue from session state), the goal
      // continues on the chosen resource and completes; the preferred
      // resource is used again at the next admission boundary once its
      // rate-limit window has passed.
      const host = await startHost({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
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
        "fake-model": { behaviors: [rateLimited1] },
        "fake-model-2": reply("objective complete"),
      })

      const session = await host.client.session.create()
      await host.client.session.command({
        sessionID: session.id,
        name: "goal",
        text: "keep making progress on the demo objective",
      })
      await host.client.session.wait({ sessionID: session.id })

      // The goal's first unit ran on the preferred resource and failed with
      // the rate limit; the recovery continued the goal on the fallback.
      const list = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model-2" &&
              r.outcome?.status === "succeeded",
          ),
        90_000,
      )
      expect(
        list.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "apply" &&
            r.decision.model.id === "fake-model" &&
            r.outcome?.status === "failed" &&
            r.outcome.category === "rate_limited",
        ),
      ).toBe(true)
      expect(
        list.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "apply" &&
            r.decision.model.id === "fake-model-2" &&
            r.outcome?.status === "succeeded",
        ),
      ).toBe(true)
      // Infra failure never escalates capability (ADP-013).
      expect(list.some((r) => r.decision.kind === "escalate")).toBe(false)

      // Ending the goal must not need Adaptive's help: the native command
      // clears it.
      await host.client.session.command({ sessionID: session.id, name: "goal", text: "clear" })

      // The preferred resource's rate-limit window has passed: the next
      // admission boundary uses it again.
      await settle(35_000)
      host.provider.setModelScripts({
        "fake-model": reply("preferred is back"),
        "fake-model-2": reply("objective complete"),
      })
      await host.run({ text: "back to the preferred resource", sessionID: session.id })
      const recovered = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model" &&
              r.decision.reason === "preferred",
          ),
        30_000,
      )
      expect(
        recovered.some(
          (r) =>
            r.sessionID === session.id &&
            r.decision.kind === "apply" &&
            r.decision.model.id === "fake-model" &&
            r.decision.reason === "preferred",
        ),
      ).toBe(true)
      const models = host.provider.calls
        .map((c) => {
          try {
            return (JSON.parse(c.body) as { model?: string }).model ?? "?"
          } catch {
            return "?"
          }
        })
        .filter((m) => m !== "?")
      expect(models.at(-1)).toBe("fake-model")
      await stop(host, session.id)
    },
  )

  it(
    "spawns a subagent child session that is admitted as its own unit",
    { timeout: 180_000 },
    async () => {
      // The `subagent` tool (host 2.2.5 tool name; arguments key `agent`)
      // runs a child episode in its own session. The child's turn carries no
      // prompt hook, so the pump's execution-started fallback admits it —
      // subagents are separate units sharing provider health (ADP-013).
      const toolCall = (name: string, args: string): FakeProviderBehavior => ({
        body: JSON.stringify({
          id: "chatcmpl-tool",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "fake-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_t", type: "function", function: { name, arguments: args } },
                ],
                finish_reason: "tool_calls",
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      })
      const host = await startHost({ script: scenarioScript("success") })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "control",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      })
      host.provider.setScript({
        behaviors: [
          {
            body: JSON.stringify({
              ...JSON.parse(reply("title").behaviors[0].body ?? "{}"),
              model: "fake-model",
            }),
          },
          toolCall(
            "subagent",
            '{"agent":"general","description":"probe child","prompt":"say done"}',
          ),
          {
            body: JSON.stringify({
              ...JSON.parse(reply("done").behaviors[0].body ?? "{}"),
              model: "fake-model",
            }),
          },
          {
            body: JSON.stringify({
              ...JSON.parse(reply("done").behaviors[0].body ?? "{}"),
              model: "fake-model",
            }),
          },
          {
            body: JSON.stringify({
              ...JSON.parse(reply("done").behaviors[0].body ?? "{}"),
              model: "fake-model",
            }),
          },
        ],
      })
      const session = await host.client.session.create()
      await host.client.session.prompt({ sessionID: session.id, text: "spawn a subagent" })
      await host.client.session.wait({ sessionID: session.id })

      const list = (await host.client.session.list()) as { data?: { id: string }[] }
      const ids = (list.data ?? []).map((s) => s.id)
      expect(ids.length).toBe(2)
      const childID = ids.find((id) => id !== session.id)
      expect(childID).toBeDefined()
      if (childID === undefined) return
      const allReceipts = await receipts(host)
      expect(
        allReceipts.some((r) => r.sessionID === session.id && r.decision.kind === "apply"),
      ).toBe(true)
      // Subagent child sessions are separate units: the child's turn carries
      // no prompt hook, but the pump's execution-started fallback admits it.
      // The child's receipt can lag the parent turn (event pump), so poll.
      const childReceipts = await pollReceipts(
        host,
        (all) => all.some((r) => r.sessionID === childID && r.decision.kind === "apply"),
        30_000,
      )
      expect(
        childReceipts.some((r) => r.sessionID === childID && r.decision.kind === "apply"),
      ).toBe(true)
      await stop(host, session.id)
    },
  )
})
