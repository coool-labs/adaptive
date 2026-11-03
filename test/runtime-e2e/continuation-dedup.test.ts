// covers: ["ADP-013", "ADP-023"]
/**
 * Runtime E2E on a real OpenCode host: an automatic quota recovery must
 * deliver its continuation prompt exactly once (ADP-013/ADP-023).
 *
 * Regression (user-reported, web GUI): after a terminal quota failure the
 * recovery's continuation message appeared TEN times in the session — ten
 * identical user rows within 72ms, while exactly ONE recovery admission was
 * recorded. These tests drive the same flows on a real host and count the
 * user rows carrying the continuation text: once for a routed admission and
 * once for the manually-picked deferred admission the report came from.
 */
import { afterAll, describe, expect, it } from "vitest"

import { rpc, REPO_ROOT, startHost, type StartedHost } from "./helpers.js"
import type { FakeProviderScript } from "../fixtures/fake-provider/scenarios.js"
import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
import type { Receipt } from "../../src/state/receipts/types.js"

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

const exhausted: FakeProviderScript = {
  behaviors: [
    {
      status: 400,
      body: JSON.stringify({ error: { message: "Model quota exhausted", type: "quota_error" } }),
    },
  ],
}

interface UserRow {
  type: string
  text?: string
}

/** The model id a provider call carried (parsed from its request body). */
const callModel = (call: { body: string }): string => {
  try {
    return (JSON.parse(call.body) as { model?: string }).model ?? "?"
  } catch {
    return "?"
  }
}

/** The last user-role message a provider call carried (the turn's prompt). */
const callPrompt = (call: { body: string }): string => {
  try {
    const parsed = JSON.parse(call.body) as {
      messages?: Array<{ role?: string; content?: string }>
    }
    const last = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user")
    return typeof last?.content === "string" ? last.content : ""
  } catch {
    return ""
  }
}

const countRows = async (
  host: StartedHost,
  sessionID: string,
): Promise<{ rows: UserRow[]; continuation: UserRow[] }> => {
  const messages = (await host.client.session.context({ sessionID })) as UserRow[]
  const rows = messages.filter((m) => m.type === "user")
  return { rows, continuation: rows.filter((m) => m.text === CONTINUATION_PROMPT) }
}

describe("runtime e2e: automatic continuation delivery", () => {
  it(
    "delivers the continuation prompt exactly once even when the plugin is loaded twice",
    { timeout: 180_000 },
    async () => {
      // Regression (user-reported): the daemon loaded Adaptive twice (repo
      // path + npm entry in the global config). Each instance runs its own
      // event pump, so a quota recovery must stay single-delivery across
      // instances.
      const host = await startHost({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
        pluginEntries: [REPO_ROOT, REPO_ROOT],
      })
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
        "fake-model": exhausted,
        "fake-model-2": reply("recovered by the fallback"),
      })
      const session = await host.client.session.create()
      await host.client.session.switchModel({
        sessionID: session.id,
        model: { providerID: "fake", id: "fake-model" },
      })
      await settle(2_000)
      await host.client.session.prompt({
        sessionID: session.id,
        text: "dedup-check on the user's pick",
      })
      await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model-2" &&
              r.outcome?.status === "succeeded",
          ),
        60_000,
      )
      await settle(2_000)
      const { rows, continuation } = await countRows(host, session.id)
      expect(
        continuation.length,
        `continuation user rows: ${String(continuation.length)}; user rows: ${JSON.stringify(rows.map((r) => (r.text ?? "").slice(0, 60)))}`,
      ).toBe(1)
    },
  )

  it(
    "delivers the quota continuation prompt exactly once (routed admission)",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
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
        "fake-model": exhausted,
        "fake-model-2": reply("recovered by the fallback"),
      })
      const session = await host.client.session.create()
      await host.client.session.prompt({
        sessionID: session.id,
        text: "dedup-check: complete this once",
      })
      // The recovery switches to the second model and continues without a user
      // prompt; wait for the recovery turn's success before inspecting rows.
      await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model-2" &&
              r.outcome?.status === "succeeded",
          ),
        60_000,
      )
      await settle(2_000)
      const { rows, continuation } = await countRows(host, session.id)
      expect(
        continuation.length,
        `continuation user rows: ${String(continuation.length)}; user rows: ${JSON.stringify(rows.map((r) => (r.text ?? "").slice(0, 60)))}`,
      ).toBe(1)
      // The work itself continued exactly once (title calls carry the host's
      // summarization template, not the continuation prompt).
      const continuationCalls = host.provider.calls.filter(
        (call) => callModel(call) === "fake-model-2" && callPrompt(call) === CONTINUATION_PROMPT,
      )
      expect(continuationCalls).toHaveLength(1)
    },
  )

  it(
    "delivers the quota continuation prompt exactly once (deferred manual pick)",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
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
        "fake-model": exhausted,
        "fake-model-2": reply("recovered by the fallback"),
      })
      const session = await host.client.session.create()
      await host.client.session.switchModel({
        sessionID: session.id,
        model: { providerID: "fake", id: "fake-model" },
      })
      await settle(2_000)
      await host.client.session.prompt({
        sessionID: session.id,
        text: "dedup-check on the user's pick",
      })
      await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "defer" &&
              r.decision.detail === "manual-selection" &&
              r.outcome?.status === "failed" &&
              r.outcome.category === "quota_exhausted",
          ),
        60_000,
      )
      // The deferred failure must still continue automatically.
      await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === session.id &&
              r.decision.kind === "apply" &&
              r.decision.model.id === "fake-model-2" &&
              r.outcome?.status === "succeeded",
          ),
        60_000,
      )
      await settle(2_000)
      const { rows, continuation } = await countRows(host, session.id)
      expect(
        continuation.length,
        `continuation user rows: ${String(continuation.length)}; user rows: ${JSON.stringify(rows.map((r) => (r.text ?? "").slice(0, 60)))}`,
      ).toBe(1)
      const continuationCalls = host.provider.calls.filter(
        (call) => callModel(call) === "fake-model-2" && callPrompt(call) === CONTINUATION_PROMPT,
      )
      expect(continuationCalls).toHaveLength(1)
    },
  )
})
