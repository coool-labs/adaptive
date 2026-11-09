// covers: ["ADP-024", "ADP-060", "ADP-010", "ADP-023", "ADP-058"]
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { parkingHandlers } from "../src/host/parking.js"
import { NOTE_ENTRY } from "../src/host/entries.js"
import { virtualModels } from "../src/host/routing.js"
import { timer } from "../src/host/timer.js"
import { withHealth } from "../src/health.js"
import { observeCodexHeaders } from "../src/capacity.js"
import { readReceipts } from "../src/receipts.js"
import {
  cancelPark,
  findPark,
  MAX_WAKES,
  PARK_ENTRY,
  savePark,
  type Parked,
} from "../src/parking.js"
import type { AdaptiveSources } from "../src/host/extension.js"
import type { BranchEntry, TaskState } from "../src/task.js"
import { memoryFile } from "./memory-file.js"
import type { JsonFile } from "../src/store.js"

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }] })
const [physical] = faux.models
const model = { ...physical, provider: "adaptive", id: "auto" }
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: { quick: [], standard: [{ providerID: "local", id: "a" }], advanced: [] },
}
const state: TaskState = {
  version: 1,
  task: "t",
  unit: "u",
  tier: "standard",
  escalations: 0,
  restarts: 0,
  tried: [],
}
const plan = { tier: "standard" as const, state, sticky: false, exclude: [] }
const request = { model, reason: "user" as const, thinkingLevel: "off" as const, messages: [] }
/** Park tokens come from the fixture's sequential id source. */
const tokenPattern = /^\d+$/
const admission = {
  decision: { kind: "park" as const, reason: "all-blocked" as const },
  due: 901_000,
}
const event = { type: "input" as const, source: "interactive" as const, text: "private original" }

/** Gates one `update` on a store so a test can interleave an owner change mid-flight. */
function gateUpdate(file: JsonFile): () => void {
  const original = file.update.bind(file)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(file, "update").mockImplementationOnce(async (change) => {
    const result = await original(change)
    await gate
    return result
  })
  return () => {
    release?.()
  }
}

/** Admission previews read health without mutating it; interleave at that read. */
function gateRead(file: JsonFile): () => void {
  const original = file.read.bind(file)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(file, "read").mockImplementationOnce(async () => {
    const result = await original()
    await gate
    return result
  })
  return () => {
    release?.()
  }
}
const recovery = {
  task: "t",
  token: "recovery",
  tier: "standard" as const,
  escalations: 0,
  restarts: 1,
  tried: [],
}

function fixture() {
  const branch: BranchEntry[] = []
  const file = memoryFile()
  let next = 0
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(settings),
    capabilities: () => Promise.resolve([]),
    newId: () => {
      next += 1
      return String(next)
    },
    health: { file: memoryFile(), clock: Date.now, newId: () => "probe" },
    capacity: { file: memoryFile(), clock: Date.now },
    parking: { file, clock: Date.now, timer },
    receipts: memoryFile(),
    preferences: memoryFile(),
  }
  const host = {
    getActiveTools: () => [],
    appendEntry: vi.fn((customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data })
    }),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  }
  const ctx = {
    model,
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [{ type: "message", message: { role: "user" } }, ...branch],
    },
    modelRegistry: { getAvailable: () => faux.models },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(() => Promise.resolve(true)),
    },
  }
  const handlers = parkingHandlers(host, sources)
  const blocked = () => handlers.blocked(plan, admission, request, ctx)
  const limited = (delay = 900_000) =>
    withHealth(sources.health, (registry) => {
      registry.observe({
        kind: "failure",
        key: { providerID: "local", modelID: "a" },
        category: "quota_exhausted",
        definitive: true,
        retryAfterMs: delay,
      })
    })
  return { sources, file, host, ctx, handlers, branch, blocked, limited }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("lets Pi persist the first conversation before parking at the route boundary", async () => {
  for (const branch of [[], [{ type: "custom" }], [{ type: "message" }]]) {
    const f = fixture()
    await f.limited()
    const ctx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getBranch: () => branch } }
    expect(await f.handlers.input(event, ctx)).toEqual({ action: "continue" })
    expect(f.host.appendEntry).not.toHaveBeenCalled()
    expect(await findPark(f.file, "session")).toBeUndefined()
  }
  const f = fixture()
  await f.limited()
  const ctx = {
    ...f.ctx,
    sessionManager: {
      ...f.ctx.sessionManager,
      getBranch: () => [{ type: "message", message: { role: "assistant" } }],
    },
  }
  expect(await f.handlers.input(event, ctx)).toEqual({ action: "handled" })
  f.handlers.shutdown()
})

it("does not turn an unconfigured tier into an availability wait", async () => {
  const f = fixture()
  vi.spyOn(f.sources, "settings").mockResolvedValue(defaultSettings())
  expect(await f.handlers.input(event, f.ctx)).toEqual({ action: "continue" })
  expect(await f.handlers.recover(recovery, f.ctx)).toBe(false)
  expect(await findPark(f.file, "session")).toBeUndefined()
  expect(f.ctx.ui.setStatus).not.toHaveBeenCalledWith("adaptive", expect.stringContaining("parked"))
})

it("parks later input before dispatch, keeps it only in the session, and wakes it once", async () => {
  const f = fixture()
  await f.limited()
  expect(await f.handlers.input(event, f.ctx)).toEqual({ action: "handled" })
  expect(f.host.sendUserMessage).not.toHaveBeenCalled()
  expect(JSON.stringify(f.file.value())).not.toContain("private original")
  expect(f.branch).toMatchObject([
    { customType: PARK_ENTRY, data: { input: { text: "private original" } } },
    {
      customType: NOTE_ENTRY,
      data: { version: 1, text: expect.stringContaining("waiting") as unknown },
    },
  ])
  expect(f.ctx.ui.setWidget).toHaveBeenCalledWith(
    "adaptive",
    expect.arrayContaining([expect.stringContaining("Parked")]),
  )
  await vi.advanceTimersByTimeAsync(901_000)
  expect(f.host.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: event.text }],
    { expandPromptTemplates: false },
  )
  expect(f.handlers.takeInput()).toMatchObject({
    wakes: 0,
    wakeToken: expect.stringMatching(tokenPattern) as unknown,
  })
  expect(f.handlers.takeInput()).toBeUndefined()
  expect(await findPark(f.file, "session")).toBeUndefined()
  await vi.runAllTimersAsync()
  expect(f.host.sendUserMessage).toHaveBeenCalledTimes(1)
})

it("cancels on a new prompt or physical pick, but not an Adaptive pick or owned input", async () => {
  for (const action of ["input", "physical", "shutdown"] as const) {
    const f = fixture()
    await f.blocked()
    await f.handlers.modelSelect(model, f.ctx)
    expect(await f.handlers.input({ ...event, source: "extension" }, f.ctx)).toEqual({
      action: "continue",
    })
    if (action === "input") await f.handlers.input(event, { ...f.ctx, model: physical })
    if (action === "physical") await f.handlers.modelSelect(physical, f.ctx)
    if (action === "shutdown") f.handlers.shutdown()
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(f.host.sendMessage).not.toHaveBeenCalled()
    if (action !== "shutdown") expect(await findPark(f.file, "session")).toBeUndefined()
  }
})

it("re-arms a future park on restart, then sends only a hidden continuation", async () => {
  const f = fixture()
  await f.blocked()
  f.handlers.shutdown()
  const reopened = parkingHandlers(f.host, f.sources)
  await reopened.sessionStart(f.ctx)
  expect(f.ctx.ui.confirm).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(900_000)
  expect(f.host.sendUserMessage).not.toHaveBeenCalled()
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.host.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    customType: "adaptive.continuation",
    display: false,
    details: {
      task: "t",
      tier: "standard",
      wakes: 0,
      wakeToken: expect.stringMatching(tokenPattern) as unknown,
    },
  })
  expect(f.host.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true })
})

it("asks on an overdue restart, honours decline, and caps automatic wakes", async () => {
  for (const accept of [true, false]) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.blocked()
    f.handlers.shutdown()
    vi.setSystemTime(1_000_000)
    f.ctx.ui.confirm.mockResolvedValue(accept)
    await f.handlers.sessionStart(f.ctx)
    expect(f.ctx.ui.confirm).toHaveBeenCalledWith("Parked task", "Resume the parked task now?")
    expect(f.host.sendMessage).toHaveBeenCalledTimes(accept ? 1 : 0)
  }
  vi.setSystemTime(1_000)
  const f = fixture()
  expect(
    await f.handlers.blocked(
      { ...plan, state: { ...state, wakes: MAX_WAKES } },
      admission,
      request,
      f.ctx,
    ),
  ).toBeUndefined()
  await vi.runAllTimersAsync()
  await f.handlers.sessionStart(f.ctx)
  expect(f.ctx.ui.setStatus).toHaveBeenCalledWith(
    "adaptive",
    expect.stringContaining("needs your input"),
  )
  expect(f.host.sendMessage).not.toHaveBeenCalled()
})

it("shows an abortable countdown, handles manual cancellation, and never parks direct requests", async () => {
  const f = fixture()
  const controller = new AbortController()
  const pending = f.handlers.blocked(
    plan,
    { ...admission, due: 3_000 },
    { ...request, signal: controller.signal },
    f.ctx,
  )
  expect(f.ctx.ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("0:02"))
  const rejected = expect(pending).rejects.toThrow("cancelled")
  controller.abort()
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  expect(
    await f.handlers.blocked(plan, admission, { ...request, reason: "direct" }, f.ctx),
  ).toBeUndefined()
  expect(
    await f.handlers.blocked({ ...plan, state: undefined }, admission, request, f.ctx),
  ).toBeUndefined()
  const manual = f.handlers.blocked(plan, { ...admission, due: 3_000 }, request, f.ctx)
  const cancelled = expect(manual).rejects.toThrow("cancelled")
  await f.handlers.modelSelect(physical, f.ctx)
  await cancelled
})

it("awaits headless parks within the owning route and persists the wake budget", async () => {
  const f = fixture()
  const pending = f.handlers.blocked(plan, admission, request, {
    ...f.ctx,
    mode: "print",
    hasUI: false,
  })
  await vi.advanceTimersByTimeAsync(900_000)
  expect(await pending).toMatchObject({ state: { wakes: 0, hops: 0, task: "t", tried: [] } })
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  expect(f.host.sendUserMessage).not.toHaveBeenCalled()
})

it("awaits headless intercepted input and cancels it without dispatching on a new prompt", async () => {
  const f = fixture()
  await f.limited()
  const pending = f.handlers.input(event, { ...f.ctx, mode: "print", hasUI: false })
  await vi.advanceTimersByTimeAsync(0)
  await f.handlers.modelSelect(physical, f.ctx)
  expect(await pending).toEqual({ action: "handled" })
  expect(f.host.sendUserMessage).not.toHaveBeenCalled()
})

it("awaits a later intercepted headless input and dispatches it once when due", async () => {
  const f = fixture()
  await f.limited()
  const pending = f.handlers.input(event, { ...f.ctx, mode: "print", hasUI: false })
  await vi.advanceTimersByTimeAsync(901_000)
  expect(await pending).toEqual({ action: "handled" })
  expect(f.host.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: event.text }],
    { expandPromptTemplates: false },
  )
  expect(await findPark(f.file, "session")).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it("enforces a per-unit hop budget even if Pi keeps retrying after successes", async () => {
  const f = fixture()
  const [auto] = virtualModels(f.sources, () => [], f.handlers)
  const result = auto?.route(
    {
      ...request,
      reason: "retry",
      state: { ...state, hops: 2 },
      failed: {
        model: physical,
        message: fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 Service Unavailable",
        }),
      },
    },
    f.ctx,
  )
  await expect(result).rejects.toThrow("all-blocked")
  expect(await findPark(f.file, "session")).toMatchObject({ tier: "standard" })
  f.handlers.shutdown()
})

it("does not touch routing for manual or streaming sessions or re-arm headless sessions", async () => {
  const f = fixture()
  expect(await f.handlers.input({ ...event, streamingBehavior: "steer" }, f.ctx)).toEqual({
    action: "continue",
  })
  expect(await f.handlers.input(event, { ...f.ctx, model: undefined })).toEqual({
    action: "continue",
  })
  expect(await f.handlers.input(event, { ...f.ctx, model: physical })).toEqual({
    action: "continue",
  })
  await f.handlers.sessionStart({ ...f.ctx, mode: "print" })
  await f.handlers.sessionStart({ ...f.ctx, model: physical })
  await f.handlers.sessionStart(f.ctx)
  expect(vi.getTimerCount()).toBe(0)
})

it("claims a shared wake only once when two sessions re-arm the same durable task", async () => {
  const f = fixture()
  await f.blocked()
  const second = parkingHandlers(f.host, f.sources)
  await second.sessionStart(f.ctx)
  await vi.advanceTimersByTimeAsync(900_000)
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(resumedNotes(f.branch)).toEqual([resumedNote])
})

it("fails open on optional parking errors and leaves malformed records for inspection", async () => {
  const f = fixture()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const broken = {
    read: () => Promise.reject(new Error("store broken")),
    update: () => Promise.reject(new Error("store broken")),
  }
  const handlers = parkingHandlers(f.host, {
    ...f.sources,
    parking: { ...f.sources.parking, file: broken },
  })
  await f.limited()
  expect(await handlers.input(event, f.ctx)).toEqual({ action: "continue" })
  await handlers.modelSelect(physical, f.ctx)
  await handlers.sessionStart(f.ctx)
  const [auto] = virtualModels(f.sources, () => [], handlers)
  expect((await auto?.route(request, f.ctx))?.model.id).toBe("a")
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("store broken"))
})

it("re-arms long timers in capped steps rather than overflowing setTimeout", async () => {
  const f = fixture()
  await f.handlers.blocked(plan, { ...admission, due: 3_601_000 }, request, f.ctx)
  await vi.advanceTimersByTimeAsync(1_800_000)
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_800_000)
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
})

it("does not resurrect a cancelled or already claimed entry on restart", async () => {
  const f = fixture()
  const record: Parked = {
    session: "session",
    token: "orphan",
    tier: "standard",
    due: 1_000,
    wakes: 0,
    claimed: false,
  }
  await savePark(f.file, record)
  await f.handlers.sessionStart(f.ctx)
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("restores intercepted text and images from Pi's session only", async () => {
  for (const images of [
    undefined,
    [],
    [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
  ]) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.limited()
    await f.handlers.input({ ...event, ...(images === undefined ? {} : { images }) }, f.ctx)
    f.handlers.shutdown()
    const reopened = parkingHandlers(f.host, f.sources)
    await reopened.sessionStart(f.ctx)
    await vi.advanceTimersByTimeAsync(901_000)
    expect(f.host.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      [{ type: "text", text: event.text }, ...(images ?? [])],
      { expandPromptTemplates: false },
    )
  }
})

it("preserves corrupt session payloads and reports the offending fields", async () => {
  const invalid = [
    { token: "t" },
    { token: "t", state, input: null },
    { token: "t", state, input: { text: 1 } },
    { token: "t", state, input: { text: "x", images: {} } },
    ...[
      null,
      { type: "text", data: "x", mimeType: "image/png" },
      { type: "image", data: 1, mimeType: "image/png" },
      { type: "image", data: "x", mimeType: null },
    ].map((image) => ({ token: "t", state, input: { text: "x", images: [image] } })),
  ]
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  for (const data of invalid) {
    const f = fixture()
    f.branch.push(
      { type: "message", message: { role: "user" } },
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: PARK_ENTRY, data: null },
      { type: "custom", customType: PARK_ENTRY, data },
    )
    await savePark(f.file, {
      session: "session",
      token: "t",
      tier: "standard",
      due: 901_000,
      wakes: 0,
      claimed: false,
    })
    await f.handlers.sessionStart(f.ctx)
    expect(f.host.sendMessage).not.toHaveBeenCalled()
    expect(await findPark(f.file, "session")).toBeDefined()
  }
  expect(logged).toHaveBeenCalledTimes(invalid.length)
})

it("supports missing optional UI and rejects a missing session identity safely", async () => {
  const f = fixture()
  const withoutUI = {
    model,
    mode: "tui",
    hasUI: true,
    sessionManager: f.ctx.sessionManager,
    modelRegistry: f.ctx.modelRegistry,
  }
  await f.handlers.input(event, withoutUI)
  await f.handlers.blocked(plan, admission, request, withoutUI)
  f.handlers.shutdown()
  await f.handlers.sessionStart(withoutUI)
  f.handlers.shutdown()
  vi.setSystemTime(1_000_000)
  await f.handlers.sessionStart(withoutUI)
  expect(await findPark(f.file, "session")).toBeUndefined()
  const noSession = { ...f.ctx, sessionManager: { getBranch: () => [] } }
  await f.handlers.sessionStart(noSession)
  await expect(
    f.handlers.blocked(plan, { ...admission, due: 2_000_000 }, request, noSession),
  ).rejects.toThrow("session id")
})

it("does not dispatch when a durable headless wake was cancelled by another process", async () => {
  const f = fixture()
  const pending = f.handlers.blocked(plan, admission, request, { ...f.ctx, mode: "print" })
  await vi.advanceTimersByTimeAsync(0)
  await cancelPark(f.file, "session")
  await vi.advanceTimersByTimeAsync(900_000)
  expect(await pending).toBeUndefined()
  expect(f.host.sendMessage).not.toHaveBeenCalled()
})

it("ignores stale callbacks even if a timer adapter delivered them after cancellation", async () => {
  const f = fixture()
  let callback: (() => void) | undefined
  const handlers = parkingHandlers(f.host, {
    ...f.sources,
    parking: {
      ...f.sources.parking,
      timer: (next) => {
        callback = next
        return () => undefined
      },
    },
  })
  await handlers.blocked(plan, admission, request, f.ctx)
  handlers.shutdown()
  callback?.()
  expect(f.host.sendMessage).not.toHaveBeenCalled()
})

it("logs a failed timer claim without dispatching or duplicating the input", async () => {
  const f = fixture()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  await f.blocked()
  vi.spyOn(f.file, "update").mockRejectedValueOnce(new Error("wake claim failed"))
  await vi.advanceTimersByTimeAsync(900_000)
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("wake claim failed"))
  expect(f.host.sendMessage).not.toHaveBeenCalled()
})

it("a new manual choice wins even while a wake claim is resolving", async () => {
  const f = fixture()
  await f.blocked()
  const original = { ...f.file }
  let release: (() => void) | undefined
  vi.spyOn(f.file, "update").mockImplementationOnce(async (change) => {
    const result = await original.update(change)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return result
  })
  await vi.advanceTimersByTimeAsync(900_000)
  await f.handlers.modelSelect(physical, f.ctx)
  release?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  expect(resumedNotes(f.branch)).toEqual([])
})

it("re-reads capacity after its reset and combines capacity and health wake deadlines", async () => {
  for (const healthDelay of [0, 20_000]) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await observeCodexHeaders(f.sources.capacity, "local", {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-after-seconds": "10",
    })
    if (healthDelay > 0) await f.limited(healthDelay)
    const [auto] = virtualModels(f.sources, () => [], f.handlers)
    await Promise.all([
      expect(auto?.route(request, f.ctx)).resolves.toMatchObject({ model: { id: "a" } }),
      vi.advanceTimersByTimeAsync(21_000),
    ])
    expect(f.ctx.ui.setWorkingMessage).toHaveBeenCalledWith(
      expect.stringContaining(healthDelay === 0 ? "0:11" : "0:21"),
    )
  }
})

it("parks terminal quota failures before adding a continuation, then wakes with one hidden message", async () => {
  const f = fixture()
  await f.limited()
  expect(await f.handlers.recover(recovery, f.ctx)).toBe(true)
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(901_000)
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.host.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    display: false,
    details: { restarts: 1, wakes: 0, wakeToken: expect.stringMatching(tokenPattern) as unknown },
  })
  expect(f.host.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true })
})

it("keeps headless terminal recovery owned, bounded, and abortable", async () => {
  for (const abort of [false, true]) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.limited()
    const waiting = f.handlers.recover(
      { ...recovery, wakes: 1 },
      { ...f.ctx, mode: "print", hasUI: false },
    )
    await vi.advanceTimersByTimeAsync(0)
    if (abort) await f.handlers.modelSelect(physical, f.ctx)
    else await vi.advanceTimersByTimeAsync(901_000)
    expect(await waiting).toBe(true)
    expect(f.host.sendMessage).toHaveBeenCalledTimes(abort ? 0 : 1)
  }
  vi.setSystemTime(1_000)
  const f = fixture()
  await f.limited()
  expect(
    await f.handlers.recover({ ...recovery, wakes: MAX_WAKES }, { ...f.ctx, mode: "print" }),
  ).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("leaves compatible, short-wait, manual, and optional-store-failed terminal recovery to the normal path", async () => {
  const f = fixture()
  expect(await f.handlers.recover(recovery, f.ctx)).toBe(false)
  expect(await f.handlers.recover(recovery, { ...f.ctx, model: physical })).toBe(false)
  expect(
    await f.handlers.recover(recovery, { ...f.ctx, modelRegistry: { getAvailable: () => [] } }),
  ).toBe(false)
  await f.limited(10_000)
  expect(await f.handlers.recover(recovery, f.ctx)).toBe(false)
  await f.limited()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(f.file, "update").mockRejectedValueOnce(new Error("save failed"))
  expect(await f.handlers.recover(recovery, f.ctx)).toBe(false)
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("save failed"))
})

it("never dispatches an input whose cancel or admission raced a newer owner", async () => {
  // A stale cancel (a park record exists, so cancelling awaits the shared store).
  const parked = fixture()
  await parked.blocked()
  const racing = gateUpdate(parked.file)
  const cancelPending = parked.handlers.input(event, parked.ctx)
  await vi.advanceTimersByTimeAsync(0)
  parked.handlers.shutdown()
  racing()
  expect(await cancelPending).toEqual({ action: "handled" })
  expect(parked.host.sendUserMessage).not.toHaveBeenCalled()
  expect(await findPark(parked.file, "session")).toBeUndefined()

  // A stale park decision (the admission raced the owner change inside the scheduler).
  const decided = fixture()
  await decided.limited()
  const admit = gateRead(decided.sources.health.file)
  const decidePending = decided.handlers.input(event, decided.ctx)
  await vi.advanceTimersByTimeAsync(0)
  decided.handlers.shutdown()
  admit()
  expect(await decidePending).toEqual({ action: "handled" })
  expect(decided.host.sendUserMessage).not.toHaveBeenCalled()
  expect(await findPark(decided.file, "session")).toBeUndefined()
})

it("never arms a park persisted by a stale input or stale blocked route", async () => {
  for (const run of ["input", "blocked"] as const) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.limited()
    const release = gateUpdate(f.file)
    const pending =
      run === "input"
        ? f.handlers.input(event, f.ctx)
        : f.handlers.blocked(plan, admission, request, f.ctx)
    await vi.advanceTimersByTimeAsync(0)
    f.handlers.shutdown()
    release()
    expect(await pending).toEqual(run === "input" ? { action: "handled" } : undefined)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.host.sendMessage).not.toHaveBeenCalled()
    expect(f.branch).not.toContainEqual(
      expect.objectContaining({ customType: "pi.virtual-model-state" }),
    )
  }
})

it("cancels an owned headless wait when its own signal aborts", async () => {
  for (const run of ["input", "recover"] as const) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.limited()
    const controller = new AbortController()
    const context = { ...f.ctx, mode: "print" as const, hasUI: false, signal: controller.signal }
    const pending =
      run === "input" ? f.handlers.input(event, context) : f.handlers.recover(recovery, context)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toEqual(run === "input" ? { action: "handled" } : true)
    expect(f.host.sendUserMessage).not.toHaveBeenCalled()
    expect(f.host.sendMessage).not.toHaveBeenCalled()
    expect(await findPark(f.file, "session")).toBeUndefined()
  }
})

it("leaves terminal recovery to the newer owner when it raced a shutdown", async () => {
  for (const stage of ["admission", "persist"] as const) {
    vi.setSystemTime(1_000)
    const f = fixture()
    await f.limited()
    const release = stage === "admission" ? gateRead(f.sources.health.file) : gateUpdate(f.file)
    const pending = f.handlers.recover(recovery, f.ctx)
    await vi.advanceTimersByTimeAsync(0)
    f.handlers.shutdown()
    release()
    expect(await pending).toBe(true)
    expect(f.host.sendMessage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    // A stale admission never persisted; a stale persist stays until a newer
    // owner's next prompt or session start cancels it.
    if (stage === "admission") expect(await findPark(f.file, "session")).toBeUndefined()
  }
})

it("keeps re-arming still-blocked wake cycles without burning the resume budget", async () => {
  const f = fixture()
  // Still-blocked wake cycles re-park for free: twice the give-up budget, still fresh.
  for (let round = 1; round <= 2 * MAX_WAKES; round += 1) {
    vi.setSystemTime(1_000)
    const pending = f.blocked()
    await pending
    await vi.advanceTimersByTimeAsync(901_000)
    expect(await findPark(f.file, "session")).toBeUndefined()
    expect(f.host.sendMessage.mock.calls[round - 1]?.[0]).toMatchObject({
      customType: "adaptive.continuation",
      details: { wakes: 0 },
    })
  }
  expect(f.host.sendMessage).toHaveBeenCalledTimes(2 * MAX_WAKES)
})

it("bounds the headless re-wait loop without burning the resume budget", async () => {
  const f = fixture()
  const [auto] = virtualModels(f.sources, () => [], f.handlers)
  await Promise.all([
    expect(
      auto?.route(request, {
        ...f.ctx,
        mode: "print",
        hasUI: false,
        modelRegistry: { getAvailable: () => [] },
      }),
    ).rejects.toThrow("no-compatible-resource"),
    vi.runAllTimersAsync(),
  ])
  // The saved state survives the throw so the settling turn can re-park it.
  const saved = f.branch.filter((entry) => entry.customType === "pi.virtual-model-state").at(-1)
  expect(saved).toMatchObject({
    data: { state: { wakes: 0, wakeToken: expect.stringMatching(tokenPattern) as unknown } },
  })
})

it("consumes a wake only when a resumed run fails again, then gives up visibly", async () => {
  const f = fixture()
  await f.limited()
  // Five woken rounds that fail again: the budget drains one per failed delivery
  // (parkingAfterRun passes wakes+1 to recover when the resumed state carries a wake token).
  for (let wakes = 0; wakes < MAX_WAKES; wakes += 1) {
    expect(
      await f.handlers.recover({ ...recovery, wakes: wakes + 1, wakeToken: "tk" }, f.ctx),
    ).toBe(true)
  }
  expect(await findPark(f.file, "session")).toMatchObject({ wakes: MAX_WAKES, claimed: false })
  expect(f.ctx.ui.setWidget).toHaveBeenLastCalledWith(
    "adaptive",
    expect.arrayContaining(["Automatic retries used up · /adaptive resume tries now"]),
  )
  const notes = f.branch
    .filter((entry) => entry.customType === NOTE_ENTRY)
    .map((entry) => entry.data)
  expect(notes).toContainEqual({
    version: 1,
    text: expect.stringContaining(
      "Gave up after 5 failed resumes · /adaptive resume tries now",
    ) as unknown,
  })
  await vi.runAllTimersAsync()
  expect(f.host.sendMessage).not.toHaveBeenCalled()
})

it("manual resume still dispatches a given-up park", async () => {
  const f = fixture()
  await f.limited()
  expect(await f.handlers.recover({ ...recovery, wakes: MAX_WAKES, wakeToken: "tk" }, f.ctx)).toBe(
    true,
  )
  expect(vi.getTimerCount()).toBe(0)
  await f.handlers.resume(f.ctx)
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.host.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    customType: "adaptive.continuation",
    details: { wakes: MAX_WAKES, wakeToken: expect.stringMatching(tokenPattern) as unknown },
  })
  expect(await findPark(f.file, "session")).toBeUndefined()
  await vi.runAllTimersAsync()
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
})

it("receipts a park without a transcript note when quiet, and still parks if the receipt fails", async () => {
  const quiet = fixture()
  await quiet.limited()
  await quiet.sources.preferences.update(() => ({
    next: { version: 1, verbosity: "quiet", escalateFromPinned: false },
    result: undefined,
  }))
  expect(await quiet.handlers.input(event, quiet.ctx)).toEqual({ action: "handled" })
  expect(quiet.branch.map((entry) => entry.customType)).toEqual([PARK_ENTRY])
  expect(await readReceipts(quiet.sources.receipts)).toHaveLength(1)
  const broken = fixture()
  await broken.limited()
  vi.spyOn(broken.sources.receipts, "transaction").mockRejectedValue(new Error("locked"))
  expect(await broken.handlers.input(event, broken.ctx)).toEqual({ action: "handled" })
  expect(broken.branch.map((entry) => entry.customType)).toEqual([PARK_ENTRY])
  expect(await findPark(broken.file, "session")).toBeDefined()
})

it("resumes a parked task on request, and says so when nothing is parked", async () => {
  const f = fixture()
  await f.handlers.resume(f.ctx)
  expect(f.ctx.ui.notify).toHaveBeenLastCalledWith("Nothing is parked in this session.", "info")
  await f.handlers.resume({ ...f.ctx, sessionManager: { getBranch: () => f.branch } })
  expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2)
  await f.blocked()
  const { mode, hasUI, sessionManager, modelRegistry } = f.ctx
  await f.handlers.resume({ mode, hasUI, sessionManager, modelRegistry })
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(f.host.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    customType: "adaptive.continuation",
    details: { task: "t", wakes: 0, wakeToken: expect.stringMatching(tokenPattern) as unknown },
  })
  expect(await findPark(f.file, "session")).toBeUndefined()
  await vi.runAllTimersAsync()
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
})

it("cancels a parked task on request without waking it", async () => {
  const f = fixture()
  await f.blocked()
  await f.handlers.cancel(f.ctx)
  expect(await findPark(f.file, "session")).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1_000_000)
  expect(f.host.sendMessage).not.toHaveBeenCalled()
  expect(resumedNotes(f.branch)).toEqual([])
})

const resumedNote = { version: 1, text: "standard resumed · retrying parked work" }

function resumedNotes(branch: readonly BranchEntry[]): unknown[] {
  return branch
    .filter((entry) => entry.customType === NOTE_ENTRY)
    .map((entry) => entry.data)
    .filter(
      (data) =>
        typeof data === "object" &&
        data !== null &&
        "text" in data &&
        typeof data.text === "string" &&
        data.text.includes("resumed"),
    )
}

it.each(["input", "recovery", "route", "headless-input", "headless-route"])(
  "notes exactly one successful owned %s wake after the reset, never while parked",
  async (flow) => {
    const f = fixture()
    await f.limited()
    const ctx = flow.startsWith("headless") ? { ...f.ctx, mode: "print", hasUI: false } : f.ctx
    let pending: Promise<unknown>
    if (flow === "input" || flow === "headless-input") pending = f.handlers.input(event, ctx)
    else if (flow === "recovery") pending = f.handlers.recover(recovery, ctx)
    else pending = f.handlers.blocked(plan, admission, request, ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(resumedNotes(f.branch)).toEqual([])
    await vi.advanceTimersByTimeAsync(901_000)
    await pending
    expect(resumedNotes(f.branch)).toEqual([resumedNote])
    await vi.runAllTimersAsync()
    expect(resumedNotes(f.branch)).toEqual([resumedNote])
  },
)

it("keeps owned wakes quiet when the saved verbosity is quiet", async () => {
  const f = fixture()
  await f.blocked()
  await f.sources.preferences.update(() => ({
    next: { version: 1, verbosity: "quiet", escalateFromPinned: false },
    result: undefined,
  }))
  await vi.advanceTimersByTimeAsync(900_000)
  expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
  expect(resumedNotes(f.branch)).toEqual([])
})

it.each(["preferences", "append"])(
  "fails open when the resumed note's %s fails",
  async (failure) => {
    const f = fixture()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await f.blocked()
    if (failure === "preferences") {
      vi.spyOn(f.sources.preferences, "read").mockRejectedValueOnce(
        new Error("note preference failed"),
      )
    } else {
      f.host.appendEntry.mockImplementationOnce(() => {
        throw new Error("note append failed")
      })
    }
    await vi.advanceTimersByTimeAsync(900_000)
    expect(f.host.sendMessage).toHaveBeenCalledTimes(1)
    expect(resumedNotes(f.branch)).toEqual([])
    expect(await findPark(f.file, "session")).toBeUndefined()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[coool.adaptive] notes:"))
  },
)

it.each(["route", "headless-route"])(
  "suppresses a %s resumed note if cancellation races the preference read",
  async (flow) => {
    const f = fixture()
    const ctx = flow === "headless-route" ? { ...f.ctx, mode: "print", hasUI: false } : f.ctx
    const pending = f.handlers.blocked(plan, admission, request, ctx)
    await vi.advanceTimersByTimeAsync(0)
    const release = gateRead(f.sources.preferences)
    await vi.advanceTimersByTimeAsync(900_000)
    await f.handlers.cancel(f.ctx)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toBeUndefined()
    expect(resumedNotes(f.branch)).toEqual([])
  },
)

it("does not note a continuation the host rejected", async () => {
  const f = fixture()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  await f.blocked()
  f.host.sendMessage.mockImplementationOnce(() => {
    throw new Error("continuation rejected")
  })
  await vi.advanceTimersByTimeAsync(900_000)
  expect(resumedNotes(f.branch)).toEqual([])
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("continuation rejected"))
})

it("fails open when the give-up note cannot be written", async () => {
  const f = fixture()
  await f.limited()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  let calls = 0
  f.host.appendEntry.mockImplementation((customType: string, data: unknown) => {
    calls += 1
    if (calls > 1) throw new Error("note failed")
    f.branch.push({ type: "custom", customType, data })
  })
  expect(await f.handlers.recover({ ...recovery, wakes: MAX_WAKES, wakeToken: "tk" }, f.ctx)).toBe(
    true,
  )
  expect(await findPark(f.file, "session")).toMatchObject({ wakes: MAX_WAKES })
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("note failed"))
})

it("drops the parked record when the woken lineage finishes, and only that record", async () => {
  const f = fixture()
  const record: Parked = {
    session: "session",
    token: "7",
    tier: "standard",
    due: Date.now() + 60_000,
    wakes: 1,
    claimed: false,
  }
  await savePark(f.file, record)
  f.branch.push({
    type: "custom",
    customType: PARK_ENTRY,
    data: { token: record.token, state: { ...state, wakeToken: "p1" } },
  })
  // A different task's park is left parked.
  await f.handlers.clearServed("t-other", f.ctx)
  expect(await findPark(f.file, "session")).toEqual(record)
  // The served lineage's record is dropped.
  await f.handlers.clearServed("t", f.ctx)
  expect(await findPark(f.file, "session")).toBeUndefined()
})

it("serving without a parked record or session identity is a safe no-op", async () => {
  const f = fixture()
  await f.handlers.clearServed("t", f.ctx)
  expect(await findPark(f.file, "session")).toBeUndefined()
  await f.handlers.clearServed("t", {
    ...f.ctx,
    sessionManager: { getBranch: f.ctx.sessionManager.getBranch },
  })
})

it("keeps a park whose payload is missing instead of guessing", async () => {
  const f = fixture()
  await savePark(f.file, {
    session: "session",
    token: "7",
    tier: "standard",
    due: Date.now() + 60_000,
    wakes: 0,
    claimed: false,
  })
  // No PARK_ENTRY payload for that token: serve nothing.
  await f.handlers.clearServed("t", f.ctx)
  expect(await findPark(f.file, "session")).toMatchObject({ token: "7" })
})

it("fails open when reading a served park's payload throws", async () => {
  const f = fixture()
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  await savePark(f.file, {
    session: "session",
    token: "7",
    tier: "standard",
    due: Date.now() + 60_000,
    wakes: 0,
    claimed: false,
  })
  f.branch.push({ type: "custom", customType: PARK_ENTRY, data: { token: "7" } })
  await f.handlers.clearServed("t", f.ctx)
  expect(await findPark(f.file, "session")).toMatchObject({ token: "7" })
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("state missing"))
})
