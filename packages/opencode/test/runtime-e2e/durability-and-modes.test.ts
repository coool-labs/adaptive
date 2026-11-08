/**
 * Runtime E2E: durable state and operating modes on a real OpenCode host.
 * Covers: settings persistence across restart, per-session overrides and
 * receipts surviving restart, OFF-mode inertness, pin precedence over the
 * tier request and agent hint, and a runtime active→observe mode switch
 * applied at the next admission without a restart.
 */
// covers: ["ADP-024","ADP-028","ADP-029","ADP-030","ADP-031","ADP-036","ADP-054","ADP-055"]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"
import type { Receipt } from "@coool/adaptive-core/state/receipts/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { FakeProviderScript } from "@coool/adaptive-testkit/fake-provider/scenarios"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

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

const status = async (host: StartedHost): Promise<{ mode: string }> =>
  (await rpc(host).status.get()) as { mode: string }

/** The model ids the fake provider actually saw, in request order. */
const modelsSeen = (host: StartedHost): string[] =>
  host.provider.calls
    .map((c) => {
      try {
        return (JSON.parse(c.body) as { model?: string }).model ?? "?"
      } catch {
        return "?"
      }
    })
    .filter((m) => m !== "?")

/** Owns a home/project pair across one or more host lifetimes. */
const makePaths = (): { home: string; project: string; cleanup(): void } => {
  const home = mkdtempSync(join(tmpdir(), "adaptive-e2e-home-"))
  const project = mkdtempSync(join(tmpdir(), "adaptive-e2e-proj-"))
  for (const dir of ["config", "data", "cache"]) mkdirSync(join(home, dir))
  return {
    home,
    project,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    },
  }
}

describe("runtime e2e: durability across restarts and operating modes", () => {
  it(
    "persists settings (mode + tiers) over RPC across a host restart",
    { timeout: 180_000 },
    async () => {
      const paths = makePaths()
      try {
        const first = await startHost({ paths: { home: paths.home, project: paths.project } })
        const patch = (await rpc(first).settings.set({
          version: 1,
          mode: "active",
          tiers: {
            quick: [],
            standard: [{ providerID: "fake", id: "fake-model" }],
            advanced: [],
          },
          pin: null,
        })) as { ok: boolean }
        expect(patch.ok).toBe(true)
        const before = (await rpc(first).settings.get()) as SettingsV1
        expect(before.mode).toBe("active")
        await first.close()

        const second = await startHost({ paths: { home: paths.home, project: paths.project } })
        hosts.push(second)
        const after = (await rpc(second).settings.get()) as SettingsV1
        expect(after).toEqual(before)
        // The restarted host serves with the restored mode, not the safe default.
        expect((await status(second)).mode).toBe("active")
      } finally {
        paths.cleanup()
      }
    },
  )

  it(
    "persists a per-session mode override and tier request across a host restart",
    { timeout: 180_000 },
    async () => {
      const paths = makePaths()
      try {
        const first = await startHost({ paths: { home: paths.home, project: paths.project } })
        // A real session id, exercised once so it exists in the host's store.
        const warm = await first.run({ text: "seed the session", script: successScript })
        const override = (await rpc(first).sessionMode.set(warm.sessionID, "active")) as {
          ok: boolean
        }
        expect(override.ok).toBe(true)
        const tier = (await rpc(first).tierRequest.set(warm.sessionID, "quick")) as { ok: boolean }
        expect(tier.ok).toBe(true)
        await first.close()

        const second = await startHost({ paths: { home: paths.home, project: paths.project } })
        hosts.push(second)
        const modeAfter = (await rpc(second).sessionMode.get(warm.sessionID)) as {
          mode: string | null
        }
        expect(modeAfter.mode).toBe("active")
        const tierAfter = (await rpc(second).tierRequest.get(warm.sessionID)) as {
          tier: string | null
        }
        expect(tierAfter.tier).toBe("quick")
      } finally {
        paths.cleanup()
      }
    },
  )

  it(
    "lists the receipts recorded before a restart after it, with stable ids and no duplicates",
    { timeout: 180_000 },
    async () => {
      const paths = makePaths()
      try {
        const first = await startHost({
          script: scenarioScript("success"),
          paths: { home: paths.home, project: paths.project },
        })
        await rpc(first).settings.set({
          version: 1,
          mode: "active",
          tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
        })
        const run = await first.run({ text: "record decisions", script: scenarioScript("success") })
        const before = await pollReceipts(
          first,
          (all) => all.some((r) => r.sessionID === run.sessionID && r.decision.kind === "apply"),
          30_000,
        )
        const beforeForSession = before.filter((r) => r.sessionID === run.sessionID)
        expect(beforeForSession.length).toBeGreaterThan(0)
        await first.close()

        const second = await startHost({ paths: { home: paths.home, project: paths.project } })
        hosts.push(second)
        const after = await pollReceipts(
          second,
          (all) => {
            const ids = new Set(all.map((r) => r.id))
            return beforeForSession.every((r) => ids.has(r.id))
          },
          30_000,
        )
        // Every pre-restart receipt survives with its original id, exactly once.
        for (const receipt of beforeForSession) {
          const matches = after.filter((r) => r.id === receipt.id)
          expect(matches).toHaveLength(1)
          expect(matches[0]?.sessionID).toBe(receipt.sessionID)
          expect(matches[0]?.decision.kind).toBe(receipt.decision.kind)
        }
      } finally {
        paths.cleanup()
      }
    },
  )

  it(
    "is inert in OFF mode: no switch, no receipts, status reports off",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ script: scenarioScript("success") })
      hosts.push(host)
      // A tier ladder exists, but OFF must never route through it.
      const patch = (await rpc(host).settings.set({
        version: 1,
        mode: "off",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model-2" }], advanced: [] },
      })) as { ok: boolean }
      expect(patch.ok).toBe(true)
      expect((await status(host)).mode).toBe("off")

      const run = await host.run({ text: "work while disabled", script: scenarioScript("success") })

      // The turn ran on the host's own model — no switch to the tier resource.
      const models = modelsSeen(host)
      expect(models.length).toBeGreaterThanOrEqual(2)
      for (const model of models) expect(model).toBe("fake-model")

      // OFF records nothing at all: no apply, no observe-only, no receipts.
      await settle(1000)
      expect(await receipts(host)).toEqual([])
      expect(run.sessionID).toBeDefined()
    },
  )

  it(
    "applies the pin ahead of the tier request and the agent tier hint",
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

      // Both weaker signals point at the quick tier; the pin must win anyway.
      const session = await host.client.session.create()
      const tier = (await rpc(host).tierRequest.set(session.id, "quick")) as { ok: boolean }
      expect(tier.ok).toBe(true)
      await host.client.session.prompt({ sessionID: session.id, text: "pinned work" })
      await host.client.session.wait({ sessionID: session.id })

      const list = await pollReceipts(
        host,
        (all) => all.some((r) => r.sessionID === session.id && r.decision.kind === "apply"),
        30_000,
      )
      const applied = list.find((r) => r.sessionID === session.id && r.decision.kind === "apply")
      expect(applied).toBeDefined()
      if (applied?.decision.kind !== "apply") return
      expect(applied.decision.reason).toBe("pin")
      expect(applied.decision.model).toEqual({ providerID: "fake", id: "fake-model-2" })
      // A pin is not a tier: the receipt carries no tier even though a tier
      // request was active.
      expect(applied.decision.tier).toBeUndefined()
    },
  )

  it(
    "switches global mode active→observe at runtime: the next admission is observe-only",
    { timeout: 180_000 },
    async () => {
      const host = await startHost({ script: scenarioScript("success") })
      hosts.push(host)
      await rpc(host).settings.set({
        version: 1,
        mode: "active",
        tiers: { quick: [], standard: [{ providerID: "fake", id: "fake-model" }], advanced: [] },
      })

      // Under active, the turn is admitted and applied on the tier resource.
      const active = await host.run({ text: "while active", script: scenarioScript("success") })
      const appliedBefore = await pollReceipts(
        host,
        (all) => all.some((r) => r.sessionID === active.sessionID && r.decision.kind === "apply"),
        30_000,
      )
      expect(
        appliedBefore.some((r) => r.sessionID === active.sessionID && r.decision.kind === "apply"),
      ).toBe(true)

      // The mode change lands at the next admission boundary — no restart.
      const switched = (await rpc(host).settings.set({ mode: "observe" })) as { ok: boolean }
      expect(switched.ok).toBe(true)
      expect((await status(host)).mode).toBe("observe")

      const observed = await host.run({
        text: "while observing",
        script: scenarioScript("success"),
      })
      const after = await pollReceipts(
        host,
        (all) =>
          all.some((r) => r.sessionID === observed.sessionID && r.decision.kind === "observe-only"),
        30_000,
      )
      expect(
        after.some((r) => r.sessionID === observed.sessionID && r.decision.kind === "observe-only"),
      ).toBe(true)
      // Observing never switches: no admission was applied for the session.
      expect(
        after.some((r) => r.sessionID === observed.sessionID && r.decision.kind === "apply"),
      ).toBe(false)
      // And no provider call was switched to the tier resource either —
      // every observed call stayed on the host's own model.
      for (const model of modelsSeen(host)) expect(model).toBe("fake-model")
    },
  )
})
