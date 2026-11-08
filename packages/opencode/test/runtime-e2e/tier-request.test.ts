// covers: ["ADP-002", "ADP-003", "ADP-005", "ADP-055"]
// Tier-request wiring end to end on a real host: the agent declares a task
// tier through the plugin's adaptive_tier tool and the NEXT admission routes
// into that tier (apply receipt tier "quick" — the apply reason stays the
// health-derived preferred/fallback vocabulary) — or defers when the
// requested tier has no configured resources.
import { afterAll, expect, test } from "vitest"

import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"
import type { Receipt } from "../../src/state/receipts/types.js"
import type { FakeProviderScript } from "../fixtures/fake-provider/scenarios.js"

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

function toolCall(name: string, args: Record<string, string>): FakeProviderScript {
  return {
    behaviors: [
      {
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
                  {
                    id: "call-tier-1",
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
    ],
  }
}

const reply = (text: string): FakeProviderScript => ({
  behaviors: [
    {
      body: JSON.stringify({
        id: "chatcmpl-r",
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

test(
  "an agent tier request steers the next admission through the adaptive_tier tool",
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
        quick: [{ providerID: "fake", id: "fake-model-2" }],
        standard: [{ providerID: "fake", id: "fake-model" }],
        advanced: [],
      },
    })

    // Turn 1: title success, then a tool call declaring the quick tier, then
    // a plain reply (the last behavior repeats).
    host.provider.setModelScripts({
      "fake-model": {
        behaviors: [
          scenarioScript("success").behaviors[0],
          ...toolCall("adaptive_tier", { tier: "quick" }).behaviors,
          ...reply("working on it").behaviors,
        ],
      },
      "fake-model-2": { behaviors: reply("quick reply").behaviors },
    })

    const first = await host.run({
      script: toolCall("adaptive_tier", { tier: "quick" }),
      text: "do routine work",
    })
    expect(first).toBeDefined()

    // The tier request steers the NEXT admission: a second turn on the same
    // session routes to the quick tier's resource.
    host.provider.setModelScripts({
      "fake-model": { behaviors: reply("second turn").behaviors },
      "fake-model-2": { behaviors: reply("quick second").behaviors },
    })
    const second = await host.run({ text: "more routine work", sessionID: first.sessionID })
    expect(second).toBeDefined()

    const list = await pollReceipts(
      host,
      (all) =>
        all.some(
          (r) =>
            r.decision.kind === "apply" &&
            r.decision.tier === "quick" &&
            r.sessionID === first.sessionID,
        ),
      60_000,
    )
    const steered = list.find(
      (r) =>
        r.decision.kind === "apply" &&
        r.decision.tier === "quick" &&
        r.sessionID === first.sessionID,
    )
    expect(steered).toBeDefined()
    if (steered?.decision.kind !== "apply") return
    // fake-model-2 is the quick tier's first (only) resource: the first ready
    // candidate wins, so the apply reason is "preferred".
    expect(steered.decision.model).toEqual({ providerID: "fake", id: "fake-model-2" })
    expect(steered.decision.reason).toBe("preferred")

    // The steered turn actually ran on the quick tier's resource: its
    // provider calls hit fake-model-2.
    const quickCalls = host.provider.calls.filter(
      (call) => (JSON.parse(call.body) as { model: string }).model === "fake-model-2",
    )
    expect(quickCalls.length).toBeGreaterThan(0)
  },
)

test(
  "a tier request for an unconfigured tier defers with tier-not-configured",
  { timeout: 180_000 },
  async () => {
    const host = await startHost({
      models: { "fake-model": { name: "Fake Model" } },
    })
    hosts.push(host)
    await rpc(host).settings.set({
      version: 1,
      mode: "active",
      tiers: {
        quick: [],
        standard: [{ providerID: "fake", id: "fake-model" }],
        advanced: [],
      },
    })

    host.provider.setModelScripts({
      "fake-model": {
        behaviors: [
          scenarioScript("success").behaviors[0],
          ...toolCall("adaptive_tier", { tier: "quick" }).behaviors,
          ...reply("still working").behaviors,
          ...reply("done").behaviors,
        ],
      },
    })

    const first = await host.run({
      script: toolCall("adaptive_tier", { tier: "quick" }),
      text: "do work",
    })
    expect(first).toBeDefined()

    // The sticky tier request is evaluated at the next admission: a second
    // turn in the same session meets the unconfigured quick tier and defers.
    const second = await host.run({ text: "continue", sessionID: first.sessionID })
    expect(second).toBeDefined()

    const list = await pollReceipts(
      host,
      (all) =>
        all.some(
          (r) =>
            r.decision.kind === "defer" &&
            r.decision.reason === "routing-defer" &&
            r.decision.detail === "tier-not-configured" &&
            r.sessionID === first.sessionID,
        ),
      60_000,
    )
    const deferred = list.find(
      (r) =>
        r.decision.kind === "defer" &&
        r.decision.reason === "routing-defer" &&
        r.decision.detail === "tier-not-configured" &&
        r.sessionID === first.sessionID,
    )
    expect(deferred).toBeDefined()
    // The session kept running on the session's own model.
    const after = await receipts(host)
    expect(after.length).toBeGreaterThan(0)
  },
)
