// covers: ["ADP-024", "ADP-056", "ADP-062"]
import { expect, it, vi } from "vitest"
import { ResourceHealthRegistry } from "@coool/adaptive-core/health/index"
import { HEALTH_KEY, parseHealthPayload } from "@coool/adaptive-core/state/health/index"
import { processLedger } from "../../src/adapters/opencode/process-ledger.js"
import {
  activeStorage,
  FakeSupervisorSession,
  KeyFailStorage,
  makeSupervisor,
  settingsJSON,
} from "./helpers.js"
import { PARKED_KEY } from "@coool/adaptive-core/state/parked-work/types"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import { makeInfo } from "../adapters/opencode/helpers.js"

const A = { providerID: "prov", id: "a" }

it("drops a queued health mirror write after its supervisor is disposed", async () => {
  const storage = activeStorage()
  const ledger = processLedger({})
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession(), ledger })
  await supervisor.settings()
  await supervisor.handleReport({ kind: "model-selected", sessionID: "s1", model: A, at: 1000 })
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1000 })
  let release: () => void = () => undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const gate = ledger.healthOperation(() => blocked)
  await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 1001 })
  supervisor.dispose()
  release()
  await gate
  await ledger.healthOperation(() => Promise.resolve())
  expect(storage.data.get(HEALTH_KEY)).toBeUndefined()
})

function blocked(storage: KeyFailStorage): void {
  const health = new ResourceHealthRegistry(() => 1_000)
  for (const key of [
    { providerID: "prov" },
    { providerID: "prov", modelID: "a" },
    { providerID: "prov", modelID: "a", variantID: "high" },
    { providerID: "other" },
  ])
    health.observe({ kind: "failure", key, category: "quota_exhausted", definitive: true })
  storage.data.set(HEALTH_KEY, { version: 1, records: health.snapshot() })
}

it("resets inherited health durably across duplicate instances without reviving stale blockers", async () => {
  const storage = activeStorage()
  blocked(storage)
  const holder = {}
  const firstLedger = processLedger(holder)
  const secondLedger = processLedger(holder)
  const live = makeSupervisor({
    storage,
    session: new FakeSupervisorSession(),
    ledger: firstLedger,
  })
  const ui = makeSupervisor({ storage, session: new FakeSupervisorSession(), ledger: secondLedger })
  await Promise.all([live.settings(), ui.settings()])
  await ui.resetHealth({ ...A, variant: "high" })
  expect(parseHealthPayload(storage.data.get(HEALTH_KEY)).map((record) => record.key)).toEqual([
    { providerID: "other" },
  ])
  await live.handleReport({ kind: "model-selected", sessionID: "s1", model: A, at: 1_000 })
  await live.handleReport({ kind: "execution-started", sessionID: "s1", at: 1_000 })
  await live.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 1_001 })
  await firstLedger.healthOperation(() => Promise.resolve())
  expect((await ui.status()).tiers.standard[0]?.health).toBe("healthy")
  expect(
    parseHealthPayload(storage.data.get(HEALTH_KEY)).some(
      (record) => record.key.providerID === "prov" && record.health === "quota_exhausted",
    ),
  ).toBe(false)
  live.dispose()
  ui.dispose()
})

it("does not clear in-memory health when reset persistence fails", async () => {
  const storage = new KeyFailStorage(HEALTH_KEY)
  storage.data.set(SETTINGS_KEY, settingsJSON("active", { standard: [A] }))
  blocked(storage)
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
  await expect(supervisor.resetHealth(A)).rejects.toThrow("write failed")
  expect((await supervisor.status()).tiers.standard[0]?.health).toBe("quota_exhausted")
  expect(parseHealthPayload(storage.data.get(HEALTH_KEY))).toHaveLength(4)
  supervisor.dispose()
})

function park(storage: KeyFailStorage, sessionID = "s1"): void {
  storage.data.set(PARKED_KEY, {
    version: 1,
    parked: [
      {
        id: `${sessionID}#1`,
        sessionID,
        tier: "standard",
        reason: "all-blocked",
        parkedAt: 5,
      },
    ],
  })
}

it("manually resumes through the live instance and waits before continuing", async () => {
  const storage = activeStorage()
  park(storage)
  const holder = {}
  const session = new FakeSupervisorSession()
  let settle: () => void = () => undefined
  let deliver: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const delivered = new Promise<void>((resolve) => {
    deliver = resolve
  })
  session.source.wait = () => settled
  session.source.prompt = ({ text }) => {
    expect(text).toBe(CONTINUATION_PROMPT)
    deliver()
    return Promise.resolve({})
  }
  const live = makeSupervisor({ storage, session, ledger: processLedger(holder) })
  const uiSession = new FakeSupervisorSession()
  const ui = makeSupervisor({ storage, session: uiSession, ledger: processLedger(holder) })
  await live.handleReport({ kind: "model-selected", sessionID: "other", model: A, at: 1000 })
  expect(await ui.resumeParked("missing")).toBe("not-parked")
  expect(await ui.resumeParked("s1")).toBe("resumed")
  expect(session.log).toEqual([])
  settle()
  await delivered
  expect(session.log).toEqual(["switch:s1:prov/a"])
  expect(uiSession.log).toEqual([])
  live.dispose()
  ui.dispose()
})

it("keeps a manual retry parked while health still blocks the tier", async () => {
  const storage = activeStorage()
  park(storage)
  blocked(storage)
  const session = new FakeSupervisorSession()
  const supervisor = makeSupervisor({ storage, session })
  expect(await supervisor.resumeParked("s1")).toBe("waiting")
  expect(session.log).toEqual([])
  expect((await supervisor.status()).parked).toBe(1)
  supervisor.dispose()
})

it("rejects manual resume while inactive, executing, or disposed", async () => {
  const storage = activeStorage()
  park(storage)
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
  await supervisor.setSessionMode("s1", "off")
  await expect(supervisor.resumeParked("s1")).rejects.toThrow("Active")
  await supervisor.setSessionMode("s1", "active")
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1000 })
  await expect(supervisor.resumeParked("s1")).rejects.toThrow("current run")
  supervisor.dispose()
  await expect(supervisor.resumeParked("s1")).rejects.toThrow("current run")
})

it("cancels only the requested wait and reports persistence failures", async () => {
  const storage = activeStorage()
  park(storage)
  const ledger = processLedger({})
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession(), ledger })
  expect(await supervisor.cancelParked("other")).toBe("not-parked")
  expect((await supervisor.status()).parked).toBe(1)
  expect(await supervisor.cancelParked("s1")).toBe("cancelled")
  expect(ledger.takeovers("s1")).toBe(1)
  expect((await supervisor.status()).parked).toBe(0)
  supervisor.dispose()
  const broken = new KeyFailStorage(PARKED_KEY)
  park(broken)
  const failed = makeSupervisor({ storage: broken, session: new FakeSupervisorSession() })
  await expect(failed.cancelParked("s1")).rejects.toThrow("write failed")
  expect((await failed.status()).parked).toBe(1)
  failed.dispose()
})

it("doctor checks missing, disabled, tool-incompatible and available models", async () => {
  const storage = activeStorage()
  storage.data.set(
    SETTINGS_KEY,
    settingsJSON("active", {
      standard: [A, { ...A, id: "b" }, { ...A, id: "missing" }, { ...A, id: "c" }],
    }),
  )
  const infos = [
    makeInfo("prov", "a"),
    makeInfo("prov", "b", { enabled: false }),
    makeInfo("prov", "c", { tools: false }),
  ]
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession(), infos })
  const checks = await supervisor.doctor()
  expect(checks).toContainEqual({
    state: "ok",
    message: "prov/a (standard): available with tool support",
  })
  expect(checks.filter((check) => check.state === "error").map((check) => check.message)).toEqual([
    "prov/b (standard): model unavailable",
    "prov/missing (standard): model unavailable",
  ])
  expect(checks.some((check) => check.message.includes("tool calls unsupported"))).toBe(true)
  vi.spyOn(supervisor, "status").mockRejectedValue(new Error("SECRET"))
  Object.defineProperty(infos, "0", {
    get() {
      throw new Error("SECRET")
    },
  })
  const failed = await supervisor.doctor()
  expect(failed.map((check) => check.message)).toEqual([
    "Settings, health or parked work could not be read",
    "Configured models could not be checked",
  ])
  supervisor.dispose()
})
