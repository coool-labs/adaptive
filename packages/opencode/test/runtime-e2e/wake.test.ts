// covers: ["ADP-024"]
/**
 * Runtime E2E on a real OpenCode host: when every model of the tier is out of
 * quota the unit parks, and the wake timer resumes it on its own once a quota
 * window ends — no user prompt, no idle boundary from another session.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { REPO_ROOT, rpc, startHost, type StartedHost } from "./helpers.js"
import type { FakeProviderScript } from "@coool/adaptive-testkit/fake-provider/scenarios"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import type { StatusSnapshot } from "@coool/adaptive-core/status"
import type { Receipt } from "@coool/adaptive-core/state/receipts/types"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

const receipts = async (host: StartedHost): Promise<Receipt[]> =>
  (await rpc(host).receipts.list()) as Receipt[]

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const poll = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  deadlineMs: number,
): Promise<T> => {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await read()
    if (predicate(value) || Date.now() > deadline) return value
    await settle(250)
  }
}

const QUOTA_RESET_SECONDS = 4

const exhausted: FakeProviderScript = {
  behaviors: [
    {
      status: 429,
      headers: { "retry-after": String(QUOTA_RESET_SECONDS) },
      body: JSON.stringify({
        error: { message: "You exceeded your current quota", type: "insufficient_quota" },
      }),
    },
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

const callPrompt = (call: { body: string }): string => {
  try {
    const parsed = JSON.parse(call.body) as { messages?: { role?: string; content?: string }[] }
    const last = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user")
    return typeof last?.content === "string" ? last.content : ""
  } catch {
    return ""
  }
}

const MODELS = { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } }

const recovered = (): Record<string, FakeProviderScript> => ({
  "fake-model": reply("resumed after the reset"),
  "fake-model-2": reply("resumed after the reset"),
})

const succeededFor =
  (sessionID: string) =>
  (all: Receipt[]): boolean =>
    all.some(
      (r) =>
        r.sessionID === sessionID &&
        r.decision.kind === "apply" &&
        r.outcome?.status === "succeeded",
    )

/** Configure both models in the standard tier, run them out of quota, and wait for the park. */
const parkSession = async (
  host: StartedHost,
): Promise<{ sessionID: string; snap: StatusSnapshot }> => {
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
  host.provider.setModelScripts({ "fake-model": exhausted, "fake-model-2": exhausted })
  const session = await host.client.session.create()
  await host.client.session.prompt({ sessionID: session.id, text: "wake-check: finish this" })
  const snap = await poll(
    async () => (await rpc(host).status.get()) as StatusSnapshot,
    (value) => value.waiting.some((entry) => entry.sessionID === session.id),
    60_000,
  )
  return { sessionID: session.id, snap }
}

describe("runtime e2e: parked work wakes when quota returns", () => {
  it(
    "continues a session whose every tier model ran out of quota once one resets",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({ models: MODELS })
      hosts.push(host)
      const { sessionID, snap: waiting } = await parkSession(host)
      const entry = waiting.waiting.find((item) => item.sessionID === sessionID)
      expect(entry, JSON.stringify(waiting)).toMatchObject({ tier: "standard" })
      expect(entry?.resumeAt).toEqual(expect.any(Number))
      expect(entry?.resumeAt ?? 0).toBeLessThan(Date.now() + 60_000)
      expect(
        (await receipts(host)).some(
          (r) =>
            r.sessionID === sessionID &&
            r.decision.kind === "park" &&
            r.decision.reason === "all-blocked",
        ),
      ).toBe(true)

      // Quota is back: the next call to either model succeeds.
      const callsBeforeReset = host.provider.calls.length
      host.provider.setModelScripts(recovered())
      const after = await poll(() => receipts(host), succeededFor(sessionID), 60_000)
      expect(succeededFor(sessionID)(after), JSON.stringify(after)).toBe(true)
      const snap = (await rpc(host).status.get()) as StatusSnapshot
      expect(snap.waiting).toEqual([])
      expect(snap.parked).toBe(0)
      // Exactly one model call carried the wake's continuation after the reset.
      const continuations = host.provider.calls
        .slice(callsBeforeReset)
        .filter((call) => callPrompt(call) === CONTINUATION_PROMPT)
      expect(continuations).toHaveLength(1)
    },
  )

  it(
    "resumes exactly once when the host loads the plugin twice",
    { timeout: 180_000 },
    async () => {
      // Both instances load the same persisted parked record. The process
      // ledger lets one of them resume, and the other takes that resume's
      // switch and prompt as Adaptive's own instead of starting another.
      const host = await startHost({ models: MODELS, pluginEntries: [REPO_ROOT, REPO_ROOT] })
      hosts.push(host)
      const { sessionID } = await parkSession(host)
      const callsBeforeReset = host.provider.calls.length
      host.provider.setModelScripts(recovered())
      const after = await poll(() => receipts(host), succeededFor(sessionID), 60_000)
      expect(succeededFor(sessionID)(after), JSON.stringify(after)).toBe(true)
      // Let any late wake or idle sweep on either instance run before counting.
      await settle(3_000)
      const continuations = host.provider.calls
        .slice(callsBeforeReset)
        .filter((call) => callPrompt(call) === CONTINUATION_PROMPT)
      expect(continuations).toHaveLength(1)
    },
  )

  it(
    "re-arms the wake from persisted parked work after a host restart",
    { timeout: 240_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "adaptive-e2e-home-"))
      const project = mkdtempSync(join(tmpdir(), "adaptive-e2e-proj-"))
      try {
        const first = await startHost({ models: MODELS, paths: { home, project } })
        const { sessionID } = await parkSession(first)
        await first.close()

        // The restarted process sees no event for this session: only the
        // persisted parked record can bring it back.
        const second = await startHost({ models: MODELS, paths: { home, project } })
        hosts.push(second)
        second.provider.setModelScripts(recovered())
        const after = await poll(() => receipts(second), succeededFor(sessionID), 60_000)
        expect(succeededFor(sessionID)(after), JSON.stringify(after)).toBe(true)
        const continuations = second.provider.calls.filter(
          (call) => callPrompt(call) === CONTINUATION_PROMPT,
        )
        expect(continuations).toHaveLength(1)
        expect(((await rpc(second).status.get()) as StatusSnapshot).waiting).toEqual([])
      } finally {
        rmSync(home, { recursive: true, force: true })
        rmSync(project, { recursive: true, force: true })
      }
    },
  )
})
