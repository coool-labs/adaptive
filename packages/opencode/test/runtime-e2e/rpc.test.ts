// covers: ["ADP-030", "ADP-036", "ADP-041", "ADP-051"]
import { afterAll, describe, expect, it } from "vitest"
import { rpc, rpcRaw, startHost, type StartedHost } from "./helpers.js"
import type { FakeProviderScript } from "@coool/adaptive-testkit/fake-provider/scenarios"

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

describe("runtime e2e: typed rpc surface on a real opencode host", () => {
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

  it("serves the default settings snapshot on a fresh install", { timeout: 120_000 }, async () => {
    const host = await start()
    const settings = (await rpc(host).settings.get()) as Record<string, unknown>
    expect(settings).toEqual({
      version: 1,
      mode: "observe",
      tiers: { quick: [], standard: [], advanced: [] },
      pin: null,
      agentTiers: {},
      inviteDismissed: false,
    })
  })

  it("persists a valid patch and mirrors it in status", { timeout: 120_000 }, async () => {
    const host = await start()
    const patch = (await rpc(host).settings.set({
      mode: "active",
      tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      pin: { providerID: "fake", id: "fake-model" },
    })) as { ok: boolean; settings: Record<string, unknown> }
    expect(patch.ok).toBe(true)

    const settings = (await rpc(host).settings.get()) as {
      mode: string
      pin: unknown
      tiers: { standard: unknown[] }
    }
    expect(settings.mode).toBe("active")
    expect(settings.pin).toEqual({ providerID: "fake", id: "fake-model" })
    expect(settings.tiers.standard).toEqual([{ providerID: "fake", id: "fake-model" }])

    const status = (await rpc(host).status.get()) as {
      mode: string
      pin: unknown
      tiers: {
        standard: { ref: { id: string }; health: string; breaker: string; windowed: boolean }[]
      }
      parked: number
      receipts: number
    }
    expect(status.mode).toBe("active")
    expect(status.pin).toEqual({ providerID: "fake", id: "fake-model" })
    expect(status.tiers.standard).toEqual([
      {
        ref: { providerID: "fake", id: "fake-model" },
        health: "healthy",
        breaker: "closed",
        windowed: false,
        windowUntil: null,
        usedPercent: null,
        resetAt: null,
      },
    ])
    expect(status.parked).toBe(0)
  })

  it(
    "reports per-field errors for an invalid patch and changes nothing",
    { timeout: 120_000 },
    async () => {
      const host = await start()
      await rpc(host).settings.set({ mode: "active" })
      const rejected = (await rpc(host).settings.set({ mode: "bogus" })) as {
        ok: boolean
        errors: string[]
      }
      expect(rejected.ok).toBe(false)
      expect(rejected.errors.length).toBeGreaterThan(0)
      const settings = (await rpc(host).settings.get()) as { mode: string }
      expect(settings.mode).toBe("active")
    },
  )

  it("rejects wire-level invalid input at the schema gate", { timeout: 120_000 }, async () => {
    const host = await start()
    const badPatch = await rpcRaw(host, "settings.set", { input: "not an object" })
    expect(badPatch.ok).toBe(false)
    const badVoid = await rpcRaw(host, "settings.get", { input: { unexpected: true } })
    expect(badVoid.ok).toBe(false)
    const goodVoid = await rpcRaw(host, "settings.get", {})
    expect(goodVoid.ok).toBe(true)
    for (const method of ["session-mode.get", "tier-request.get"]) {
      for (const sessionID of ["", "s".repeat(129)]) {
        const response = await rpcRaw(host, method, { input: { sessionID } })
        // The host rejects gated input with a non-2xx wire error (same shape
        // as the badPatch/badVoid cases above), so the HTTP status is the
        // contract here.
        expect(response.ok).toBe(false)
      }
    }
  })

  it(
    "lists receipts with identities that agree with the status count",
    { timeout: 120_000 },
    async () => {
      const host = await start({ script: successScript })
      await rpc(host).settings.set({
        mode: "active",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      })
      await host.run({ text: "hi" })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const list = (await rpc(host).receipts.list()) as {
        id: number
        sessionID: string
        decision: { kind: string }
      }[]
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBeGreaterThan(0)
      for (const receipt of list) {
        expect(typeof receipt.id).toBe("number")
        expect(receipt.sessionID.startsWith("ses_")).toBe(true)
        expect(typeof receipt.decision.kind).toBe("string")
      }
      const status = (await rpc(host).status.get()) as { receipts: number }
      expect(status.receipts).toBe(list.length)
    },
  )
})
