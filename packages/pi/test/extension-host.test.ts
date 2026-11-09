// covers: ["ADP-028", "ADP-029", "ADP-030", "ADP-058"]
import { expect, it, vi } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { NOTE_ENTRY } from "../src/host/entries.js"
import { registerAdaptive, type AdaptiveSources } from "../src/host/extension.js"
import { timer } from "../src/host/timer.js"
import { readReceipts } from "../src/receipts.js"
import { memoryFile } from "./memory-file.js"

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
const [a] = faux.models
const settings: SettingsV1 = {
  ...defaultSettings(),
  mode: "observe",
  tiers: { quick: [], standard: [{ providerID: "local", id: "b" }], advanced: [] },
}
const quiet = { version: 1, verbosity: "quiet", escalateFromPinned: false }

function fixture(options: { settings?: SettingsV1; preferences?: unknown } = {}) {
  let next = 0
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(options.settings ?? settings),
    capabilities: () => Promise.resolve([]),
    newId: () => {
      next += 1
      return `id-${String(next)}`
    },
    health: { file: memoryFile(), clock: () => 1_000, newId: () => "probe" },
    capacity: { file: memoryFile(), clock: () => 1_000 },
    parking: { file: memoryFile(), clock: () => 1_000, timer },
    receipts: memoryFile(),
    preferences: memoryFile(options.preferences),
  }
  const entries: { customType: string; data: unknown }[] = []
  const on = vi.fn()
  const registerVirtualModel = vi.fn()
  // The fake implements exactly the host surface registerAdaptive consumes; the
  // overloaded `on` cannot be expressed by a plain function.
  const pi = {
    registerVirtualModel,
    getActiveTools: () => [],
    registerTool: vi.fn(),
    on,
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    setModel: vi.fn(),
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data })
    },
  } as unknown as Parameters<typeof registerAdaptive>[0]
  registerAdaptive(pi, sources, {
    settings: memoryFile(),
    version: "1.5.0",
    minimum: "1.5.0",
    testedUpTo: "1.5.0",
  })
  const handler = (name: string): ((event: unknown, ctx: unknown) => Promise<unknown>) => {
    const call = on.mock.calls.find(([event]) => event === name)
    if (call === undefined) throw new Error(`no ${name} handler`)
    return call[1] as (event: unknown, ctx: unknown) => Promise<unknown>
  }
  const auto = registerVirtualModel.mock.calls
    .map(([definition]) => definition as { id: string; route: (...args: unknown[]) => unknown })
    .find((definition) => definition.id === "auto")
  if (auto === undefined) throw new Error("auto model missing")
  return { sources, entries, handler, auto }
}

const ui = {
  setStatus: vi.fn(),
  setWidget: vi.fn(),
  setWorkingMessage: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}
function context(model: unknown, session: string | null = "session") {
  return {
    model,
    mode: "tui",
    hasUI: false,
    ui,
    modelRegistry: { getAvailable: () => faux.models },
    sessionManager: {
      getBranch: () => [],
      ...(session === null ? {} : { getSessionId: () => session }),
    },
  }
}
const virtual = { provider: "adaptive", id: "auto" }
const request = { model: a, reason: "user", thinkingLevel: "off", messages: [] }

it("keeps the receipt and its outcome even when notes are quiet", async () => {
  const f = fixture({ preferences: quiet })
  await f.auto.route(request, context(virtual))
  await f.handler("session_shutdown")({}, context(virtual))
  expect(await readReceipts(f.sources.receipts)).toHaveLength(1)
  expect(f.entries.filter((entry) => entry.customType === NOTE_ENTRY)).toEqual([])
  await f.handler("message_end")(
    { message: { role: "assistant", provider: "local", model: "b", stopReason: "stop" } },
    context(virtual),
  )
  expect((await readReceipts(f.sources.receipts))[0]?.outcome).toEqual({ status: "succeeded" })
})

it("routes a sessionless host without recording receipts", async () => {
  const f = fixture()
  const routed = await f.auto.route(request, context(virtual, null))
  expect(routed).toMatchObject({ model: { id: "b" } })
  await f.handler("session_shutdown")({}, context(virtual))
  expect(await f.sources.receipts.read()).toBeUndefined()
})

it("observes a manual model: one receipt and a note, never an intervention", async () => {
  const f = fixture()
  const input = { type: "input", source: "interactive", text: "hello" }
  expect(await f.handler("input")(input, context(a))).toEqual({ action: "continue" })
  expect(await readReceipts(f.sources.receipts)).toMatchObject([
    { decision: { kind: "observe-only", would: { kind: "apply", model: { id: "b" } } } },
  ])
  expect(f.entries).toMatchObject([
    { customType: NOTE_ENTRY, data: { text: expect.stringContaining("Observing") as unknown } },
  ])
})

it("leaves a manual model alone when Adaptive is off or an input is extension-made", async () => {
  const off = fixture({ settings: { ...settings, mode: "off" } })
  const input = { type: "input", source: "interactive", text: "hello" }
  expect(await off.handler("input")(input, context(a))).toEqual({ action: "continue" })
  expect(await off.sources.receipts.read()).toBeUndefined()
  const f = fixture()
  await f.handler("input")({ ...input, source: "extension" }, context(a))
  await f.handler("input")(input, context(undefined))
  expect(await f.sources.receipts.read()).toBeUndefined()
})

it("fails open when observation cannot be recorded", async () => {
  const f = fixture()
  vi.spyOn(f.sources.receipts, "transaction").mockRejectedValue(new Error("locked"))
  const input = { type: "input", source: "interactive", text: "hello" }
  expect(await f.handler("input")(input, context(a))).toEqual({ action: "continue" })
  expect(f.entries).toEqual([])
})

it("notes only changes in what Adaptive would do, and routes on when a receipt fails", async () => {
  const f = fixture()
  const input = { type: "input", source: "interactive", text: "hello" }
  await f.handler("input")(input, context(a))
  await f.handler("input")(input, context(a))
  expect(await readReceipts(f.sources.receipts)).toHaveLength(2)
  expect(f.entries.filter((entry) => entry.customType === NOTE_ENTRY)).toHaveLength(1)
  vi.spyOn(f.sources.receipts, "transaction").mockRejectedValue(new Error("locked"))
  expect(await f.auto.route(request, context(virtual))).toMatchObject({ model: { id: "b" } })
  await f.handler("session_shutdown")({}, context(virtual))
})

it("receipts a deferred pin as the host's choice and does not attach outcomes to it", async () => {
  const f = fixture({ settings: { ...settings, pin: { providerID: "local", id: "ghost" } } })
  expect(await f.auto.route(request, context(virtual))).toMatchObject({ model: { id: "b" } })
  await f.handler("session_shutdown")({}, context(virtual))
  expect(await readReceipts(f.sources.receipts)).toMatchObject([
    { decision: { kind: "defer", reason: "pin-unverifiable" } },
  ])
  await f.handler("message_end")(
    { message: { role: "assistant", provider: "local", model: "b", stopReason: "stop" } },
    context(virtual),
  )
  expect((await readReceipts(f.sources.receipts))[0]?.outcome).toBeUndefined()
})

it("fails open when the first-run offer cannot be made", async () => {
  const f = fixture()
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const start = f.handler("session_start")
  await start({}, { ...context(a), mode: "rpc", hasUI: true, sessionManager: {} })
  expect(log).toHaveBeenCalledWith(expect.stringContaining("onboarding"))
  log.mockRestore()
})

it("attaches the outcome even when the turn ends before the receipt write settled", async () => {
  const f = fixture()
  await f.auto.route(request, context(virtual))
  await f.handler("message_end")(
    { message: { role: "assistant", provider: "local", model: "b", stopReason: "stop" } },
    context(virtual),
  )
  expect((await readReceipts(f.sources.receipts))[0]?.outcome).toEqual({ status: "succeeded" })
})
