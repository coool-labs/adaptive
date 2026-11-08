// covers: ["ADP-007", "ADP-013", "ADP-019", "ADP-023", "ADP-024", "ADP-029", "ADP-031"]
import { describe, expect, it, vi } from "vitest"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import { RECEIPTS_KEY } from "../../src/state/receipts/types.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
import { wireRef } from "../adapters/opencode/helpers.js"
import {
  activeStorage,
  FakeSupervisorSession,
  flush,
  makeSupervisor,
  seed,
  settingsJSON,
  storedParked,
  storedReceipts,
} from "./helpers.js"
import type { Supervisor } from "../../src/supervisor/index.js"

const PROMPT = { kind: "prompt", sessionID: "s1" } as const
const QUOTA = {
  kind: "execution-failed",
  sessionID: "s1",
  at: 20,
  error: { type: "UnknownError", message: "Model quota exhausted" },
} as const

async function start(supervisor: Supervisor, model = "a"): Promise<void> {
  await supervisor.handleReport(PROMPT)
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
  await supervisor.handleReport({
    kind: "model-request",
    sessionID: "s1",
    model: { providerID: "prov", id: model },
    requestKind: "primary",
  })
}

async function tripSibling(supervisor: Supervisor): Promise<void> {
  await supervisor.handleReport({
    kind: "model-request",
    sessionID: "s1",
    model: { providerID: "prov", id: "b" },
    requestKind: "primary",
  })
  for (let index = 0; index < 5; index += 1) {
    await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
  }
}

describe("terminal quota recovery", () => {
  it("parks an exhausted tier instead of escalating or prompting a blocked resource", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleReport({
      ...QUOTA,
      error: { type: "UnknownError", message: "You've hit your session limit" },
    })
    await flush()
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "park",
    })
    expect(parseParkedPayload(storedParked(storage))).toMatchObject([
      { sessionID: "s1", tier: "standard", reason: "all-blocked", detail: "quota exhausted" },
    ])
  })

  it("records a defer when no tier is configured", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    seed(storage, SETTINGS_KEY, settingsJSON("active"))
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "defer",
      detail: "tier-not-configured",
    })
    expect(parseParkedPayload(storedParked(storage))).toEqual([])
  })

  it("does not borrow a tier when an explicit pin exhausts its quota", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    seed(storage, SETTINGS_KEY, settingsJSON("active", {}, wireRef("prov", "a")))
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(parseParkedPayload(storedParked(storage))).toEqual([])
  })

  it("OBSERVE records the same fallback without continuing the session", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("observe", {
        standard: [wireRef("prov", "a"), wireRef("prov", "b")],
      }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", model: { providerID: "prov", id: "b" } },
    })
  })

  it("honors OFF chosen while the failure outcome is being persisted", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    const set = storage.source.set
    let armed = true
    const persist = vi.spyOn(storage.source, "set").mockImplementation(async (key, value) => {
      if (key === RECEIPTS_KEY && armed) {
        armed = false
        await supervisor.setSessionMode("s1", "off")
      }
      return set(key, value)
    })
    await supervisor.handleReport(QUOTA)
    await flush()
    persist.mockRestore()
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("OBSERVE releases a due probe instead of reserving it for work it never runs", async () => {
    let now = 1000
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock: () => now })
    await tripSibling(supervisor)
    now = 40_000
    await start(supervisor)
    await supervisor.updateSettings({ mode: "observe" })
    await supervisor.handleReport(QUOTA)
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "probe" },
    })
    await supervisor.updateSettings({ mode: "active" })
    await supervisor.handleReport(PROMPT)
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: { providerID: "prov", id: "b" },
    })
  })

  it("does not duplicate a retry-owned continuation or its late terminal echo", async () => {
    const session = new FakeSupervisorSession()
    let release: (() => void) | undefined
    session.source.wait = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleRetry({
      sessionID: "s1",
      model: { providerID: "prov", id: "a" },
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
    })
    await flush()
    await supervisor.handleReport(QUOTA)
    release?.()
    await flush()
    expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toEqual([
      `prompt:s1:${CONTINUATION_PROMPT}`,
    ])
  })

  it("ignores a terminal echo after the owned prompt was delivered but before its hook", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await start(supervisor)
    await supervisor.handleRetry({
      sessionID: "s1",
      model: { providerID: "prov", id: "a" },
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
    })
    await flush()
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(1)
  })

  it("bounds automatic continuations even when earlier quota windows expire", async () => {
    let now = 1000
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock: () => now })
    await start(supervisor)
    for (const model of ["a", "b", "a"]) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: { providerID: "prov", id: model },
        requestKind: "primary",
      })
      await supervisor.handleReport(QUOTA)
      await flush()
      now += 15 * 60 * 1000
      await supervisor.handleReport(PROMPT)
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: now })
    }
    expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(2)
  })

  it("releases a probe when the task's terminal-recovery budget is exhausted", async () => {
    let now = 1000
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock: () => now })
    await start(supervisor)
    for (const model of ["a", "b"]) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: { providerID: "prov", id: model },
        requestKind: "primary",
      })
      await supervisor.handleReport(QUOTA)
      await flush()
      now += 15 * 60 * 1000
      await supervisor.handleReport(PROMPT)
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: now })
    }
    await tripSibling(supervisor)
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: { providerID: "prov", id: "a" },
      requestKind: "primary",
    })
    now += 40_000
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(2)
    await supervisor.handleReport(PROMPT)
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: { providerID: "prov", id: "b" },
    })
  })

  it.each(["wait", "prompt"] as const)(
    "logs a failed continuation %s without retrying",
    async (operation) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
      try {
        const session = new FakeSupervisorSession({
          failWait: operation === "wait",
          failPrompt: operation === "prompt",
        })
        const storage = activeStorage()
        const supervisor = makeSupervisor({ storage, session })
        await start(supervisor)
        await supervisor.handleReport(QUOTA)
        await flush()
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("quota-recovery"))
        expect(session.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(
          operation === "prompt" ? 1 : 0,
        )
      } finally {
        errors.mockRestore()
      }
    },
  )

  it("releases an admitted probe when the continuation prompt fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      let now = 1000
      const session = new FakeSupervisorSession({ failPrompt: true })
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session, clock: () => now })
      await tripSibling(supervisor)
      now = 40_000
      await start(supervisor)
      await supervisor.handleReport(QUOTA)
      await flush()
      await supervisor.handleReport(PROMPT)
      expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
        kind: "apply",
        reason: "probe",
        model: { providerID: "prov", id: "b" },
      })
    } finally {
      errors.mockRestore()
    }
  })

  it.each(["off", "observe", "user"] as const)(
    "aborts before switching when %s is chosen during settle",
    async (choice) => {
      const session = new FakeSupervisorSession()
      let release: (() => void) | undefined
      session.source.wait = () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await start(supervisor)
      await supervisor.handleReport(QUOTA)
      await flush()
      if (choice === "user") {
        await supervisor.handleReport({
          kind: "execution-interrupted",
          sessionID: "s1",
          at: 30,
          reason: "user",
        })
      } else {
        await supervisor.updateSettings({ mode: choice })
      }
      release?.()
      await flush()
      expect(session.log).toEqual(["switch:s1:prov/a"])
    },
  )
})
