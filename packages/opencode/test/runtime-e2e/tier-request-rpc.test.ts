// covers: ["ADP-055"]
// The tier-request RPC surface end to end on a real host: the control surface
// steers one session's admissions through tier-request.set, other sessions
// keep the routing ladder, and clearing the request restores it. Mirrors the
// session-mode RPC journey (ADP-054).
import { afterAll, describe, expect, it } from "vitest"

import { rpc, rpcRaw, startHost, type StartedHost } from "./helpers.js"
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

/** Poll the receipt list until `predicate` holds or the deadline passes. */
const pollReceipts = async (
  host: StartedHost,
  predicate: (list: Receipt[]) => boolean,
  deadlineMs = 60_000,
): Promise<Receipt[]> => {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const list = await receipts(host)
    if (predicate(list)) return list
    if (Date.now() > deadline) return list
    await settle(500)
  }
}

describe("runtime e2e: per-session tier requests over the RPC surface (ADP-055)", () => {
  const hosts: StartedHost[] = []

  const start = async (): Promise<StartedHost> => {
    const host = await startHost({
      models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
    })
    hosts.push(host)
    return host
  }

  afterAll(async () => {
    for (const host of [...hosts].reverse()) await host.close()
  })

  it(
    "steers one session's next admissions through tier-request.set and clears on null",
    { timeout: 180_000 },
    async () => {
      const host = await start()
      // Global control is ACTIVE; the quick tier holds a distinct resource so
      // a steered apply is distinguishable from ordinary routing.
      const patch = (await rpc(host).settings.set({
        mode: "active",
        tiers: {
          quick: [{ providerID: "fake", id: "fake-model-2" }],
          standard: [{ providerID: "fake", id: "fake-model" }],
          advanced: [],
        },
      })) as { ok: boolean }
      expect(patch.ok).toBe(true)

      // Session A starts on the ordinary ladder (standard's fake-model).
      const first = await host.run({ text: "hi", script: successScript })
      const sessionA = first.sessionID

      // The surface pins the quick tier for session A only.
      const pinned = (await rpc(host).tierRequest.set(sessionA, "quick")) as { ok: boolean }
      expect(pinned.ok).toBe(true)
      expect(((await rpc(host).tierRequest.get(sessionA)) as { tier: string | null }).tier).toBe(
        "quick",
      )

      // The NEXT admission in session A routes into the quick tier.
      const second = await host.run({
        text: "hi again",
        sessionID: sessionA,
        script: successScript,
      })
      expect(second.sessionID).toBe(sessionA)
      const steered = await pollReceipts(host, (all) =>
        all.some(
          (r) =>
            r.sessionID === sessionA && r.decision.kind === "apply" && r.decision.tier === "quick",
        ),
      )
      const steeredApply = steered.find(
        (r) =>
          r.sessionID === sessionA && r.decision.kind === "apply" && r.decision.tier === "quick",
      )
      expect(steeredApply).toBeDefined()
      if (steeredApply?.decision.kind === "apply") {
        expect(steeredApply.decision.model).toEqual({ providerID: "fake", id: "fake-model-2" })
      }

      // A second session without a request keeps the ordinary ladder.
      const other = await host.run({ text: "different session", script: successScript })
      expect(other.sessionID).not.toBe(sessionA)
      await settle(1000)
      const ordinary = await pollReceipts(host, (all) =>
        all.some((r) => r.sessionID === other.sessionID && r.decision.kind === "apply"),
      )
      const ordinaryApply = ordinary.find(
        (r) => r.sessionID === other.sessionID && r.decision.kind === "apply",
      )
      expect(ordinaryApply).toBeDefined()
      if (ordinaryApply?.decision.kind === "apply") {
        expect(ordinaryApply.decision.tier).not.toBe("quick")
      }

      // Clearing the request restores the ordinary ladder for session A.
      const cleared = (await rpc(host).tierRequest.set(sessionA, null)) as { ok: boolean }
      expect(cleared.ok).toBe(true)
      expect(
        ((await rpc(host).tierRequest.get(sessionA)) as { tier: string | null }).tier,
      ).toBeNull()
      const third = await host.run({
        text: "after clearing",
        sessionID: sessionA,
        script: successScript,
      })
      expect(third.sessionID).toBe(sessionA)
      const restored = await pollReceipts(host, (all) =>
        all.some(
          (r) =>
            r.sessionID === sessionA && r.decision.kind === "apply" && r.decision.tier !== "quick",
        ),
      )
      const restoredApply = restored.find(
        (r) =>
          r.sessionID === sessionA && r.decision.kind === "apply" && r.decision.tier !== "quick",
      )
      expect(restoredApply).toBeDefined()
    },
  )

  it("rejects an unknown tier and a malformed wire input without a write", async () => {
    const host = await start()
    // Vocabulary failure: the handler reports a per-field error, no write.
    const badTier = await rpcRaw(host, "tier-request.set", {
      input: { sessionID: "ses_1", tier: "bogus" },
    })
    expect(badTier.ok).toBe(true)
    const badTierOutput = (await badTier.json()) as { output: { ok: boolean; errors: string[] } }
    expect(badTierOutput.output).toEqual({
      ok: false,
      errors: ["tier must be one of quick, standard, advanced or null"],
    })
    expect(((await rpc(host).tierRequest.get("ses_1")) as { tier: string | null }).tier).toBeNull()

    // Wire-gate failure: the tier type is wrong, so the transport rejects it.
    const badWire = await rpcRaw(host, "tier-request.set", {
      input: { sessionID: "ses_1", tier: 7 },
    })
    expect(badWire.ok).toBe(false)
  })
})
