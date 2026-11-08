/**
 * Runtime E2E: routing ladder behaviors on a real OpenCode host (ADP-041).
 * Covers: quick routing, advanced routing, explicit pin override,
 * compatibility rejection (not-in-inventory skip), fail-open on corrupt
 * persisted settings.
 *
 * Routing at runtime is pin → agent-role hint → default standard; the tier
 * hint needs the agent observed once (warm-up) before it can route.
 */
// covers: ["ADP-002", "ADP-003", "ADP-005", "ADP-017", "ADP-028", "ADP-029", "ADP-031", "ADP-036", "ADP-041"]
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"
import type { Receipt } from "@coool/adaptive-core/state/receipts/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

const receipts = async (host: StartedHost): Promise<Receipt[]> => {
  const list = await rpc(host).receipts.list()
  return list as Receipt[]
}

describe("runtime e2e: routing ladder", () => {
  it("routes through the agent tier hint after a warm-up unit", { timeout: 120_000 }, async () => {
    const host = await startHost({
      script: scenarioScript("success"),
      models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
    })
    hosts.push(host)
    await rpc(host).settings.set({
      version: 1,
      mode: "active",
      tiers: { quick: [{ providerID: "fake", id: "fake-model-2" }], standard: [], advanced: [] },
      agentTiers: { build: "quick" },
    })

    // First unit: the agent has not been observed yet, so the hint cannot
    // apply and routing defaults to standard. Second unit: the hint routes.
    // Both units share one session — the agent hint is observed per session
    // during the first unit's model requests, and the second unit's
    // admission (now in the awaited prompt hook, before its own model
    // resolution) can only see the agent that unit 1 already reported.
    const warm = await host.run({ script: scenarioScript("success"), text: "warm up" })
    await host.run({
      script: scenarioScript("success"),
      text: "second unit",
      sessionID: warm.sessionID,
    })

    const applies = (await receipts(host)).filter(
      (r) => r.decision.kind === "apply" && r.decision.reason === "preferred",
    )
    // Unit 1 defers (agent unobserved); unit 2 routes through the hint.
    expect(applies.length).toBeGreaterThanOrEqual(1)
    const last = applies.at(-1)
    if (last?.decision.kind !== "apply") return
    expect(last.decision.tier).toBe("quick")
    expect(last.decision.model.id).toBe("fake-model-2")
  })

  it(
    "routes the advanced tier when configured as the agent's tier",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({
        script: scenarioScript("success"),
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: { quick: [], standard: [], advanced: [{ providerID: "fake", id: "fake-model-2" }] },
        agentTiers: { build: "advanced" },
      })

      const warm = await host.run({ script: scenarioScript("success"), text: "warm up" })
      await host.run({
        script: scenarioScript("success"),
        text: "second unit",
        sessionID: warm.sessionID,
      })

      const applies = (await receipts(host)).filter(
        (r) => r.decision.kind === "apply" && r.decision.reason === "preferred",
      )
      expect(applies.length).toBeGreaterThanOrEqual(1)
      const last = applies.at(-1)
      if (last?.decision.kind !== "apply") return
      expect(last.decision.tier).toBe("advanced")
      expect(last.decision.model.id).toBe("fake-model-2")
    },
  )

  it(
    "routes by the explicit pin even against the agent tier hint",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({
        script: scenarioScript("success"),
        models: { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Model 2" } },
      })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: { quick: [{ providerID: "fake", id: "fake-model" }], standard: [], advanced: [] },
        agentTiers: { build: "quick" },
        pin: { providerID: "fake", id: "fake-model-2" },
      })

      // The pin applies on the very first unit — it outranks everything and
      // needs no observed agent.
      await host.run({ script: scenarioScript("success"), text: "pinned work" })

      const applies = (await receipts(host)).filter((r) => r.decision.kind === "apply")
      expect(applies.length).toBeGreaterThanOrEqual(1)
      const pinned = applies[0]
      if (pinned?.decision.kind !== "apply") return
      expect(pinned.decision.model).toEqual({ providerID: "fake", id: "fake-model-2" })
      expect(pinned.decision.reason).toBe("pin")
      // A pin is not a tier: the receipt carries no tier.
      expect(pinned.decision.tier).toBeUndefined()
    },
  )

  it(
    "skips candidates that are not in the inventory and applies the next one",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ script: scenarioScript("success") })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: {
          quick: [],
          standard: [
            { providerID: "fake", id: "ghost-model" },
            { providerID: "fake", id: "fake-model" },
          ],
          advanced: [],
        },
      })

      await host.run({ script: scenarioScript("success"), text: "skip ghost" })

      const admission = (await receipts(host)).find(
        (r) => r.decision.kind === "apply" && r.decision.evidence.skipped.length > 0,
      )
      expect(admission).toBeDefined()
      if (admission?.decision.kind !== "apply") return
      expect(admission.decision.evidence.skipped).toEqual([
        { ref: { providerID: "fake", id: "ghost-model" }, why: "not-in-inventory" },
      ])
      expect(admission.decision.model.id).toBe("fake-model")
    },
  )

  it(
    "fails open: corrupt persisted settings degrade to defaults, host keeps serving",
    { timeout: 180_000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "adaptive-e2e-home-"))
      const project = mkdtempSync(join(tmpdir(), "adaptive-e2e-proj-"))
      for (const dir of ["config", "data", "cache"]) mkdirSync(join(home, dir))
      try {
        const first = await startHost({ paths: { home, project } })
        await rpc(first).settings.set({ version: 1, mode: "active" })
        await first.close()

        // Corrupt the persisted settings row in the host's kv storage.
        execFileSync(
          "sqlite3",
          [
            join(home, "data/opencode/opencode.db"),
            `UPDATE kv SET value='{corrupt' WHERE key LIKE '%coool.adaptive/settings'`,
          ],
          { encoding: "utf8" },
        )

        const second = await startHost({ paths: { home, project } })
        // The read path is total: a corrupted record degrades to defaults.
        const settings = (await rpc(second).settings.get()) as SettingsV1
        expect(settings).toEqual({
          version: 1,
          mode: "observe",
          tiers: { quick: [], standard: [], advanced: [] },
          pin: null,
          agentTiers: {},
          inviteDismissed: false,
        })
        // Ordinary OpenCode behavior continues unsupervised (observe).
        await second.run({ script: scenarioScript("success"), text: "still works" })
        const status = (await rpc(second).status.get()) as { mode: string }
        expect(status.mode).toBe("observe")
      } finally {
        rmSync(home, { recursive: true, force: true })
        rmSync(project, { recursive: true, force: true })
      }
    },
  )
})
