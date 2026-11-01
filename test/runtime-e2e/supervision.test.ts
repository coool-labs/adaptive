// covers: ["ADP-001", "ADP-005", "ADP-008", "ADP-009", "ADP-010", "ADP-013", "ADP-019", "ADP-022", "ADP-029", "ADP-041", "ADP-045"]
import { afterAll, describe, expect, it } from "vitest"
import { startHost, rpc, type StartedHost } from "./helpers.js"
import type { Receipt } from "../../src/state/receipts/types.js"
import type { FakeProviderScript } from "../fixtures/fake-provider/scenarios.js"

const successScript: FakeProviderScript = {
  behaviors: [
    {
      body: JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fake says hi" },
            finish_reason: "stop",
          },
        ],
      }),
    },
  ],
}

const settle = async (ms = 500): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const receipts = async (host: StartedHost): Promise<Receipt[]> => {
  const list = await rpc(host).receipts.list()
  return list as Receipt[]
}

const tierRefs = (names: string[]): { providerID: string; id: string }[] =>
  names.map((id) => ({ providerID: "fake", id }))

describe("runtime e2e: supervision on a real opencode host", () => {
  const cases: StartedHost[] = []

  const start = async (options: Parameters<typeof startHost>[0] = {}): Promise<StartedHost> => {
    const host = await startHost(options)
    cases.push(host)
    return host
  }

  afterAll(async () => {
    for (const host of cases.reverse()) {
      await host.close()
    }
  })

  it(
    "loads the plugin and defers in observe mode on a fresh install",
    { timeout: 120_000 },
    async () => {
      const host = await start()
      const { sessionID } = await host.run({ text: "hi", script: successScript })
      await settle(1000)
      const list = await receipts(host)
      expect(list.length).toBeGreaterThan(0)
      const admission = list[list.length - 1]
      expect(admission?.sessionID).toBe(sessionID)
      expect(admission?.decision.kind).toBe("observe-only")
      if (admission?.decision.kind === "observe-only") {
        expect(admission.decision.would).toEqual({
          kind: "defer",
          reason: "routing-defer",
          detail: "tier-not-configured",
        })
      }
      expect(host.provider.requestCount()).toBeGreaterThan(0)
    },
  )

  it(
    "routes a standard-tier unit in control mode and applies the tier resource",
    { timeout: 120_000 },
    async () => {
      const host = await start()
      const patch = (await rpc(host).settings.set({
        mode: "control",
        tiers: { quick: [], standard: tierRefs(["fake-model"]), advanced: [] },
      })) as { ok: boolean }
      expect(patch.ok).toBe(true)
      const { sessionID } = await host.run({ text: "hi", script: successScript })
      await settle(1000)
      const list = await receipts(host)
      const applied = list.filter((r) => r.decision.kind === "apply")
      expect(applied.length).toBeGreaterThan(0)
      const first = applied[0]
      expect(first?.sessionID).toBe(sessionID)
      if (first?.decision.kind === "apply") {
        expect(first.decision.model).toEqual({ providerID: "fake", id: "fake-model" })
      }
      const status = (await rpc(host).status.get()) as {
        tiers: { standard: { ref: { id: string } }[] }
      }
      const standard = status.tiers.standard.map((entry) => entry.ref.id)
      expect(standard).toContain("fake-model")
    },
  )

  it("keeps the identical decision in observe and control mode", { timeout: 120_000 }, async () => {
    const host = await start()
    await rpc(host).settings.set({
      tiers: { quick: [], standard: tierRefs(["fake-model"]), advanced: [] },
    })
    const { sessionID } = await host.run({ text: "hi", script: successScript })
    await settle(500)
    const observeReceipts = await receipts(host)
    const observeDecision = observeReceipts[observeReceipts.length - 1]?.decision
    expect(observeDecision?.kind).toBe("observe-only")
    await rpc(host).settings.set({ mode: "control" })
    await host.run({ text: "hi again", sessionID, script: successScript })
    await settle(1000)
    const list = await receipts(host)
    const applied = list.filter((r) => r.decision.kind === "apply")
    expect(applied.length).toBe(1)
    const wrapped = observeDecision?.kind === "observe-only" ? observeDecision.would : undefined
    expect(wrapped).toEqual(applied[0]?.decision)
  })

  it(
    "falls back within the tier through a rate limit and owns recovery",
    { timeout: 120_000 },
    async () => {
      const host = await start({
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
        script: {
          behaviors: [
            {
              status: 429,
              body: JSON.stringify({ error: { message: "rate limited" } }),
              headers: { "retry-after": "1" },
            },
            {
              body: JSON.stringify({
                id: "cmpl-2",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "recovered" },
                    finish_reason: "stop",
                  },
                ],
              }),
            },
          ],
        },
      })
      await rpc(host).settings.set({
        mode: "control",
        tiers: { quick: [], standard: tierRefs(["fake-model", "fake-model-2"]), advanced: [] },
      })
      await host.run({ text: "hi" })
      await settle(1500)
      const list = await receipts(host)
      // receipts.list is newest first (the supervisor's view slice is reversed).
      const applied = list.filter((r) => r.decision.kind === "apply")
      expect(applied.length).toBeGreaterThanOrEqual(2)
      const fallback = applied[0]
      const preferred = applied[applied.length - 1]
      expect(preferred?.decision).toMatchObject({ kind: "apply", reason: "preferred" })
      if (preferred?.decision.kind === "apply") {
        expect(preferred.decision.model.id).toBe("fake-model")
        expect(preferred.outcome).toMatchObject({ status: "failed", category: "rate_limited" })
      }
      expect(fallback?.decision).toMatchObject({ kind: "apply", reason: "fallback" })
      if (fallback?.decision.kind === "apply") {
        expect(fallback.decision.model.id).toBe("fake-model-2")
        expect(fallback.outcome).toMatchObject({ status: "succeeded" })
        expect(fallback.decision.evidence.skipped).toEqual([
          { ref: { providerID: "fake", id: "fake-model" }, why: "rate-limited" },
        ])
      }
      expect(host.provider.requestCount()).toBeGreaterThanOrEqual(2)
    },
  )

  it("never escalates capability on infrastructure failure", { timeout: 120_000 }, async () => {
    const host = await start({
      models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      script: {
        behaviors: [
          {
            status: 429,
            body: JSON.stringify({ error: { message: "rate limited" } }),
            headers: { "retry-after": "60" },
          },
          {
            body: JSON.stringify({
              id: "cmpl-2",
              object: "chat.completion",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "recovered" },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        ],
      },
    })
    await rpc(host).settings.set({
      mode: "control",
      tiers: {
        quick: [],
        standard: tierRefs(["fake-model"]),
        advanced: tierRefs(["fake-model-2"]),
      },
    })
    await host.run({ text: "hi" })
    await settle(1500)
    const list = await receipts(host)
    const escalations = list.filter(
      (r) =>
        r.decision.kind === "escalate" ||
        (r.decision.kind === "observe-only" && r.decision.would.kind === "escalate"),
    )
    expect(escalations).toEqual([])
  })

  it(
    "opens the circuit breaker after repeated outages and parks admission",
    { timeout: 300_000 },
    async () => {
      const host = await start({
        script: {
          behaviors: [{ status: 503, body: JSON.stringify({ error: { message: "unavailable" } }) }],
        },
      })
      await rpc(host).settings.set({
        mode: "control",
        tiers: { quick: [], standard: tierRefs(["fake-model"]), advanced: [] },
      })
      // One fully-awaited run collects countable failures quickly; the host's
      // own retry backoff makes a failing prompt keep retrying in the
      // background even after session.wait returns, so progress is observed
      // through receipts instead of awaited runs.
      const first = await host.run({ text: "run 0" })
      const breakerSession = (await host.client.session.create()).id
      await host.client.session.prompt({ sessionID: breakerSession, text: "trip it" })
      // The breaker opens on the fifth countable failure; the next admission
      // then parks. Poll until the first park surfaces (any session — the
      // background retry grind of earlier prompts may be the one to show it).
      const parkDeadline = Date.now() + 120_000
      for (;;) {
        const list = await receipts(host)
        if (list.some((r) => r.decision.kind === "park") || Date.now() > parkDeadline) break
        await settle(500)
      }
      // Interrupting an already-finished session is a host-side no-op error;
      // both interrupts only exist to stop a possibly-still-grinding retry loop.
      const stop = async (sessionID: string): Promise<void> => {
        try {
          await host.client.session.interrupt({ sessionID })
        } catch {
          // session already idle
        }
      }
      await stop(breakerSession)
      await stop(first.sessionID)
      await settle(2000)
      const list = await receipts(host)
      const parked = list.filter((r) => r.decision.kind === "park")
      expect(parked.length).toBeGreaterThan(0)
      expect(
        parked.every((r) => r.decision.kind === "park" && r.decision.reason === "all-blocked"),
      ).toBe(true)
      // With the breaker open, a fresh unit parks at admission. The host's own
      // unsupervised title generation for a fresh session may still touch the
      // provider, so the asserted invariant is stability once the park has
      // surfaced: a parked admission drives no further provider traffic.
      const parkedSession = (await host.client.session.create()).id
      await host.client.session.prompt({ sessionID: parkedSession, text: "one more" })
      const parkedDeadline = Date.now() + 15_000
      let parkedFresh = false
      for (;;) {
        const list = await receipts(host)
        if (list.some((r) => r.sessionID === parkedSession && r.decision.kind === "park")) {
          parkedFresh = true
          break
        }
        if (Date.now() > parkedDeadline) break
        await settle(500)
      }
      expect(parkedFresh).toBe(true)
      await stop(parkedSession)
      await settle(2000)
      const before = host.provider.requestCount()
      await settle(2000)
      expect(host.provider.requestCount()).toBe(before)
    },
  )

  it(
    "attaches outcomes and never fails over on user cancellation",
    { timeout: 120_000 },
    async () => {
      const host = await start({
        script: {
          behaviors: [
            {
              body: JSON.stringify({
                id: "cmpl-1",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "slow reply" },
                    finish_reason: "stop",
                  },
                ],
              }),
              delayMs: 4000,
            },
          ],
        },
      })
      await rpc(host).settings.set({
        mode: "control",
        tiers: { quick: [], standard: tierRefs(["fake-model"]), advanced: [] },
      })
      const sessionID = (await host.client.session.create()).id
      await host.client.session.prompt({ sessionID, text: "hi" })
      await settle(1500)
      await host.client.session.interrupt({ sessionID })
      await settle(1000)
      const list = await receipts(host)
      const interrupted = list.filter((r) => r.outcome?.status === "interrupted")
      expect(interrupted.length).toBeGreaterThan(0)
      const failures = list.filter((r) => r.outcome?.status === "failed")
      expect(failures).toEqual([])
    },
  )

  it("tracks concurrent sessions independently", { timeout: 120_000 }, async () => {
    const host = await start()
    await rpc(host).settings.set({
      mode: "control",
      tiers: { quick: [], standard: tierRefs(["fake-model"]), advanced: [] },
    })
    const [first, second] = await Promise.all([
      host.run({ text: "one" }),
      host.run({ text: "two" }),
    ])
    await settle(1000)
    const list = await receipts(host)
    const sessions = new Set(list.map((r) => r.sessionID))
    expect(sessions.has(first.sessionID)).toBe(true)
    expect(sessions.has(second.sessionID)).toBe(true)
  })
})
