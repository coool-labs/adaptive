/**
 * Manual controls at their edges (ADP-024/028/062): the user's explicit
 * resume, cancel and reset actions on state that moved under them.
 */
// covers: ["ADP-024", "ADP-028", "ADP-062"]
import { describe, expect, it } from "vitest"

import { ResourceHealthRegistry } from "@coool/adaptive-core/health/index"
import { HEALTH_KEY, parseHealthPayload } from "@coool/adaptive-core/state/health/index"
import { parseParkedPayload } from "@coool/adaptive-core/state/parked-work/index"
import { PARKED_KEY } from "@coool/adaptive-core/state/parked-work/types"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import {
  activeStorage,
  FakeScheduler,
  FakeSupervisorSession,
  flush,
  makeSupervisor,
  settingsJSON,
  storedParked,
} from "./helpers.js"
import { wireRef } from "../adapters/opencode/helpers.js"

const A = { providerID: "prov", id: "a" }
const B = { providerID: "prov", id: "b" }

function parkRecord(id: string, sessionID: string, tier = "standard") {
  return { id, sessionID, tier, reason: "all-blocked", parkedAt: 5 }
}

function seedParked(storage: { data: Map<string, unknown> }, ...records: object[]): void {
  storage.data.set(PARKED_KEY, { version: 1, parked: records })
}

describe("manual resume of parked work", () => {
  it("keeps waiting, delivering nothing, once the parked tier was emptied", async () => {
    const storage = activeStorage()
    seedParked(storage, parkRecord("s1#1", "s1"))
    storage.data.set(SETTINGS_KEY, settingsJSON("active", { quick: [wireRef("prov", "a")] }))
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    expect(await supervisor.resumeParked("s1")).toBe("waiting")
    await flush()
    expect(session.log).toEqual([])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    supervisor.dispose()
  })

  it("refuses under a global observe mode, naming the remedy, and leaves the wait intact", async () => {
    const storage = activeStorage()
    storage.data.set(
      SETTINGS_KEY,
      settingsJSON("observe", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
    )
    seedParked(storage, parkRecord("s1#1", "s1"))
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await expect(supervisor.resumeParked("s1")).rejects.toThrow(
      "Set this session to Active before resuming parked work.",
    )
    expect(session.log).toEqual([])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    supervisor.dispose()
  })

  it("two clicks deliver exactly one continuation", async () => {
    const storage = activeStorage()
    seedParked(storage, parkRecord("s1#1", "s1"))
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const outcomes = await Promise.all([
      supervisor.resumeParked("s1"),
      supervisor.resumeParked("s1"),
    ])
    await flush()
    expect(outcomes.filter((outcome) => outcome === "resumed")).toHaveLength(1)
    expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(1)
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
    supervisor.dispose()
  })
})

describe("manual cancel of parked work", () => {
  it("cancels every record the session holds and none of another session's", async () => {
    const storage = activeStorage()
    seedParked(
      storage,
      parkRecord("s1#1", "s1"),
      parkRecord("s1#2", "s1", "advanced"),
      parkRecord("s2#1", "s2"),
    )
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    expect(await supervisor.cancelParked("s1")).toBe("cancelled")
    expect(parseParkedPayload(storedParked(storage)).map((record) => record.id)).toEqual(["s2#1"])
    expect(await supervisor.cancelParked("s1")).toBe("not-parked")
    supervisor.dispose()
  })
})

describe("manual health reset", () => {
  it("clears the chosen model and its inherited limits, never a sibling's own record", async () => {
    const storage = activeStorage()
    const health = new ResourceHealthRegistry(() => 1_000)
    health.observe({
      kind: "failure",
      key: { providerID: "prov", modelID: "a" },
      category: "quota_exhausted",
      definitive: true,
    })
    health.observe({
      kind: "failure",
      key: { providerID: "prov", modelID: "b" },
      category: "quota_exhausted",
      definitive: true,
    })
    storage.data.set(HEALTH_KEY, { version: 1, records: health.snapshot() })
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    await supervisor.resetHealth(A)
    expect(parseHealthPayload(storage.data.get(HEALTH_KEY)).map((record) => record.key)).toEqual([
      { providerID: "prov", modelID: B.id },
    ])
    const tiers = (await supervisor.status()).tiers.standard
    expect(tiers.map((entry) => [entry.ref.id, entry.health])).toEqual([
      ["a", "healthy"],
      ["b", "quota_exhausted"],
    ])
    supervisor.dispose()
  })

  it("is harmless on a resource that was never unhealthy", async () => {
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    await expect(supervisor.resetHealth(A)).resolves.toBeUndefined()
    expect(parseHealthPayload(storage.data.get(HEALTH_KEY))).toEqual([])
    supervisor.dispose()
  })
})

describe("user intent against parked work (ADP-024/028)", () => {
  it("a manual model pick ends the wait: the record is dropped and no wake stays armed", async () => {
    const storage = activeStorage()
    seedParked(storage, parkRecord("s1#1", "s1"))
    const scheduler = new FakeScheduler()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session, scheduler })
    await supervisor.settings()
    await flush()
    expect(scheduler.pending()).toHaveLength(1)
    await supervisor.handleReport({ kind: "model-selected", sessionID: "s1", model: B, at: 20 })
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
    expect(scheduler.pending()).toHaveLength(0)
    expect((await supervisor.status()).waiting).toEqual([])
    supervisor.dispose()
  })

  it("work parked under a tier the user later emptied is held, not resumed, dropped or woken", async () => {
    const storage = activeStorage()
    seedParked(storage, parkRecord("s1#1", "s1"))
    storage.data.set(SETTINGS_KEY, settingsJSON("active", { quick: [wireRef("prov", "a")] }))
    const scheduler = new FakeScheduler()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session, scheduler })
    await supervisor.settings()
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    await flush()
    expect(session.log).toEqual([])
    expect(scheduler.pending()).toHaveLength(0)
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    const status = await supervisor.status()
    expect(status.parked).toBe(1)
    expect(status.waiting).toEqual([])
    // Configuring the tier again makes the held work due without losing it.
    await supervisor.updateSettings({
      tiers: { quick: [], standard: [A], advanced: [] },
    })
    expect(scheduler.pending()).toHaveLength(1)
    supervisor.dispose()
  })
})
