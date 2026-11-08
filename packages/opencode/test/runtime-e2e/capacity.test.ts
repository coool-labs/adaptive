// covers: ["ADP-020", "ADP-056"]
// Capacity in the status snapshot, end to end on a real host: a completed
// turn whose response carries x-codex usage headers feeds the passive sensor,
// and the very next status.get reports the used percent and reset time for a
// configured openai resource — no second admission needed (the response
// handler persists the reading to the capacity mirror that status reads).
import { afterAll, expect, test } from "vitest"

import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

test(
  "a sensed subscription capacity window shows in status with its reset time",
  { timeout: 180_000 },
  async () => {
    const host = await startHost({
      models: { "fake-model": { name: "Fake Model" } },
      script: scenarioScript("success"),
    })
    hosts.push(host)
    await rpc(host).settings.set({
      version: 1,
      mode: "active",
      tiers: { quick: [], standard: [{ providerID: "openai", id: "probe-codex" }], advanced: [] },
    })

    await host.run({ text: "say done" })

    const status = (await rpc(host).status.get()) as {
      tiers: { standard: { usedPercent: number | null; resetAt: number | null }[] }
    }
    expect(status.tiers.standard).toHaveLength(1)
    expect(status.tiers.standard[0]?.usedPercent).toBe(72)
    expect(status.tiers.standard[0]?.resetAt).not.toBeNull()
  },
)
