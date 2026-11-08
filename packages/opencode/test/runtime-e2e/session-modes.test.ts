// covers: ["ADP-029", "ADP-041", "ADP-045", "ADP-054"]
import { afterAll, describe, expect, it } from "vitest"
import { rpc, startHost, type StartedHost } from "./helpers.js"
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

describe("runtime e2e: per-session mode overrides (ADP-054)", () => {
  const cases: StartedHost[] = []

  const start = async (): Promise<StartedHost> => {
    const host = await startHost()
    cases.push(host)
    return host
  }

  afterAll(async () => {
    for (const host of cases.reverse()) {
      await host.close()
    }
  })

  it(
    "applies an overridden session's admission while other sessions stay observed",
    { timeout: 180_000 },
    async () => {
      const host = await start()
      // Global control is OBSERVE with a configured standard tier; the
      // override flips one session to active.
      const patch = (await rpc(host).settings.set({
        mode: "observe",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      })) as { ok: boolean }
      expect(patch.ok).toBe(true)

      const { sessionID: overridden } = await host.run({ text: "hi", script: successScript })
      const override = (await rpc(host).sessionMode.set(overridden, "active")) as { ok: boolean }
      expect(override.ok).toBe(true)
      const readBack = (await rpc(host).sessionMode.get(overridden)) as { mode: string | null }
      expect(readBack.mode).toBe("active")

      const second = await host.run({
        text: "hi again",
        sessionID: overridden,
        script: successScript,
      })
      expect(second.sessionID).toBe(overridden)
      await settle(1000)
      const third = await host.run({ text: "and once more", script: successScript })
      expect(third.sessionID).not.toBe(overridden)
      await settle(1000)

      const list = await receipts(host)
      const applied = list.filter((r) => r.sessionID === overridden && r.decision.kind === "apply")
      expect(applied.length).toBeGreaterThan(0)
      if (applied[0]?.decision.kind === "apply") {
        expect(applied[0].decision.model).toEqual({ providerID: "fake", id: "fake-model" })
      }
      // The unoverridden session stayed observed: its receipts are
      // observe-only records of the identical decision.
      const observed = list.filter((r) => r.sessionID === third.sessionID)
      expect(observed.length).toBeGreaterThan(0)
      expect(observed.some((r) => r.decision.kind === "observe-only")).toBe(true)
      expect(observed.some((r) => r.decision.kind === "apply")).toBe(false)

      // Clearing the override returns the session to the global observe mode.
      const cleared = (await rpc(host).sessionMode.set(overridden, null)) as { ok: boolean }
      expect(cleared.ok).toBe(true)
      expect(
        ((await rpc(host).sessionMode.get(overridden)) as { mode: string | null }).mode,
      ).toBeNull()
    },
  )
})
