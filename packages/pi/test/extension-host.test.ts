// covers: ["ADP-028", "ADP-029", "ADP-030", "ADP-058"]
import { expect, it, vi } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { NOTE_ENTRY } from "../src/host/entries.js"
import { registerAdaptive, type AdaptiveSources } from "../src/host/extension.js"
import { timer } from "../src/host/timer.js"
import { readReceipts } from "../src/receipts.js"
import { withHealth } from "../src/health.js"
import type { BranchEntry } from "../src/task.js"
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
  const registerEntryRenderer = vi.fn()
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
    registerEntryRenderer,
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data })
    },
  } as unknown as Parameters<typeof registerAdaptive>[0]
  registerAdaptive(pi, sources, {
    settings: memoryFile(options.settings ?? settings),
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
  return { sources, entries, handler, auto, registerEntryRenderer, registerVirtualModel, pi }
}

const ui = {
  setStatus: vi.fn(),
  setWidget: vi.fn(),
  setWorkingMessage: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}
function context(
  model: unknown,
  session: string | null = "session",
  branch: readonly BranchEntry[] = [],
) {
  return {
    model,
    mode: "tui",
    hasUI: false,
    ui,
    modelRegistry: { getAvailable: () => faux.models },
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => ({ messages: [] }),
      ...(session === null ? {} : { getSessionId: () => session }),
    },
  }
}
const virtual = { provider: "adaptive", id: "auto" }
const request = { model: a, reason: "user", thinkingLevel: "off", messages: [] }

it("keeps a useful routing footer with quiet notes and failed receipt storage", async () => {
  const f = fixture({ preferences: quiet })
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  vi.spyOn(f.sources.receipts, "transaction").mockRejectedValue(new Error("locked"))
  await f.auto.route(request, ctx)
  await f.handler("message_end")({ message: { role: "user" } }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "standard | b")
  expect(f.entries).toEqual([])
})

it("shows observation before quiet-note filtering, then clears on a manual off selection", async () => {
  const f = fixture({ preferences: quiet })
  const setStatus = vi.fn()
  const ctx = { ...context(a), hasUI: true, ui: { ...ui, setStatus } }
  await f.handler("input")({ source: "interactive", text: "hello" }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Observing | would use standard")
  vi.spyOn(f.sources, "settings").mockResolvedValue({ ...settings, mode: "off" })
  await f.handler("model_select")({ model: a, previousModel: virtual }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
  expect(f.entries).toEqual([])
})

it("shows setup rather than parking an unconfigured selected tier", async () => {
  const f = fixture({ settings: defaultSettings() })
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  await expect(f.auto.route(request, ctx)).rejects.toThrow("no-candidates")
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive: set up tiers | /adaptive")
  expect(await f.sources.parking.file.read()).toBeUndefined()
})

it("shows degraded on internal health fallback, not on successful normal admission", async () => {
  const f = fixture()
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  vi.spyOn(f.sources.health.file, "update").mockRejectedValue(new Error("locked"))
  expect(await f.auto.route(request, ctx)).toMatchObject({ model: { id: "b" } })
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive degraded | /adaptive doctor")
  await f.handler("session_shutdown")({}, ctx)
})

it("keeps an observer's internal health fallback visible even with quiet notes", async () => {
  const f = fixture({ preferences: quiet })
  const setStatus = vi.fn()
  const ctx = { ...context(a), hasUI: true, ui: { ...ui, setStatus } }
  vi.spyOn(f.sources.health.file, "read").mockRejectedValue(new Error("locked"))
  expect(await f.handler("input")({ source: "interactive", text: "hello" }, ctx)).toEqual({
    action: "continue",
  })
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive degraded | /adaptive doctor")
})

it("cannot repaint a manual selection when a prior admission finishes late", async () => {
  const f = fixture({ settings: { ...settings, mode: "off" } })
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  let release: ((value: SettingsV1) => void) | undefined
  const held = new Promise<SettingsV1>((resolve) => {
    release = resolve
  })
  vi.spyOn(f.sources, "settings").mockImplementationOnce(() => held)
  const pending = f.auto.route(request, ctx)
  await f.handler("model_select")({ model: a, previousModel: virtual }, { ...ctx, model: a })
  setStatus.mockClear()
  release?.(settings)
  await pending
  expect(setStatus).not.toHaveBeenCalled()
  await f.handler("session_shutdown")({}, ctx)
})

it("refreshes configured and empty selected tiers, including branch and session resets", async () => {
  const f = fixture()
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  await f.auto.route(request, ctx)
  await f.handler("session_tree")({}, { ...ctx, model: { provider: "adaptive", id: "quick" } })
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive: set up tiers | /adaptive")
  await f.handler("model_select")({ model: virtual, previousModel: a }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
  await f.handler("session_start")({}, { ...ctx, model: undefined })
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
  await f.handler("session_shutdown")({}, ctx)
})

it("reports failed configuration refresh and failed route preparation as degraded", async () => {
  const f = fixture()
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  vi.spyOn(f.sources, "settings").mockRejectedValue(new Error("broken configuration"))
  await f.handler("model_select")({ model: virtual, previousModel: a }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive degraded | /adaptive doctor")
  await expect(f.auto.route(request, ctx)).rejects.toThrow("broken configuration")
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive degraded | /adaptive doctor")
})

it("shows task escalation and recovery from admitted state, not capability inference", async () => {
  const f = fixture({
    settings: {
      ...settings,
      tiers: { ...settings.tiers, advanced: [{ providerID: "local", id: "b" }] },
    },
  })
  const setStatus = vi.fn()
  const ctx = { ...context(virtual), hasUI: true, ui: { ...ui, setStatus } }
  const state = {
    version: 1,
    task: "task",
    unit: "unit",
    tier: "advanced",
    escalations: 1,
    restarts: 0,
    tried: [],
  }
  await f.auto.route({ ...request, reason: "continuation", state }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Escalated advanced | b")
  await f.auto.route({ ...request, reason: "retry", state }, ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Recovering advanced | b")
  await f.handler("session_shutdown")({}, ctx)
})

it("wraps resume/cancel command status writes without erasing admitted routing", async () => {
  const f = fixture()
  const setStatus = vi.fn()
  const ctx = {
    ...context(virtual),
    hasUI: true,
    ui: { ...ui, setStatus },
    waitForIdle: () => Promise.resolve(),
  }
  await f.auto.route(request, ctx)
  const registered = vi.mocked(f.pi.registerCommand).mock.calls[0]?.[1]
  if (registered === undefined) throw new Error("adaptive command missing")
  // The public host handler consumes only the structural fake context above.
  const command = registered.handler as (args: string, ctx: unknown) => Promise<void>
  await command("resume", ctx)
  await command("cancel", ctx)
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", "standard | b")
  await f.handler("session_shutdown")({}, ctx)
})

it("clears status after a session-off command selects a manual model before saving its override", async () => {
  const f = fixture({ settings: { ...settings, inviteDismissed: true } })
  const setStatus = vi.fn()
  let selected: { readonly provider: string; readonly id: string } = virtual
  const choices = ["Mode", "This session", "off"]
  const menus: { title: string; choices: string[] }[] = []
  const ctx = {
    ...context(virtual),
    mode: "rpc",
    hasUI: true,
    get model() {
      return selected
    },
    isIdle: () => true,
    waitForIdle: () => Promise.resolve(),
    modelRegistry: { getAvailable: () => faux.models, find: () => a },
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [
        { type: "model_change", provider: "local", modelId: "a" },
        ...f.entries.map((entry) => ({ type: "custom", ...entry })),
      ],
    },
    ui: {
      ...ui,
      setStatus,
      select: (_title: string, options: string[]) => {
        menus.push({ title: _title, choices: options })
        const prefix = choices.shift()
        return Promise.resolve(
          options.find((option) => {
            const title = option
              .replace(/^\d+\. /, "")
              .split(" — ")[0]
              ?.replace(/…$/, "")
            return title === prefix
          }),
        )
      },
    },
  }
  vi.mocked(f.pi.setModel).mockImplementation(async (model) => {
    const previousModel = selected
    selected = model
    await f.handler("model_select")({ model, previousModel }, ctx)
    return true
  })
  await f.auto.route(request, ctx)
  const registered = vi.mocked(f.pi.registerCommand).mock.calls[0]?.[1]
  if (registered === undefined) throw new Error("adaptive command missing")
  const command = registered.handler as (args: string, ctx: unknown) => Promise<void>
  await command("", ctx)
  expect(selected, JSON.stringify({ menus, notices: ui.notify.mock.calls })).toMatchObject({
    provider: "local",
    id: "a",
  })
  expect(f.entries).toContainEqual({
    customType: "adaptive.session",
    data: { version: 1, mode: "off" },
  })
  expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
  await f.handler("session_shutdown")({}, ctx)
})

it("says when a dispatch is a retry after a failure", async () => {
  const f = fixture()
  await f.auto.route({ ...request, reason: "retry" }, context(virtual))
  await f.handler("session_shutdown")({}, context(virtual))
  expect(f.entries).toMatchObject([
    { customType: NOTE_ENTRY, data: { text: "standard → local/b · retry" } },
  ])
})

it("renders the notes it writes: the transcript entry type has a registered renderer", () => {
  const f = fixture()
  expect(f.registerEntryRenderer).toHaveBeenCalledWith(NOTE_ENTRY, expect.any(Function))
})

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

it("does not observe an input already consumed by owned parking", async () => {
  const f = fixture()
  await withHealth(f.sources.health, (registry) => {
    registry.observe({
      kind: "failure",
      key: { providerID: "local", modelID: "b" },
      category: "quota_exhausted",
      definitive: true,
      retryAfterMs: 180_000,
    })
  })
  const ctx = context(virtual, "session", [{ type: "message", message: { role: "user" } }])
  try {
    expect(
      await f.handler("input")({ type: "input", source: "interactive", text: "hello" }, ctx),
    ).toEqual({ action: "handled" })
    expect(await readReceipts(f.sources.receipts)).toMatchObject([{ decision: { kind: "park" } }])
  } finally {
    await f.handler("session_shutdown")({}, ctx)
  }
})

it("notes leaving Adaptive for a physical model, and only then", async () => {
  const f = fixture()
  const select = f.handler("model_select")
  await select({ model: a, previousModel: virtual, source: "set" }, context(a))
  await select({ model: a, previousModel: undefined, source: "restore" }, context(a))
  await select({ model: a, previousModel: a, source: "set" }, context(a))
  await select({ model: virtual, previousModel: a, source: "set" }, context(virtual))
  expect(f.entries).toEqual([
    { customType: NOTE_ENTRY, data: { version: 1, text: "Paused · you picked local/a" } },
  ])
  const quietly = fixture({ preferences: quiet })
  await quietly.handler("model_select")({ model: a, previousModel: virtual }, context(a))
  expect(quietly.entries).toEqual([])
  const broken = fixture({ preferences: { verbosity: "loud" } })
  await broken.handler("model_select")({ model: a, previousModel: virtual }, context(a))
  expect(broken.entries).toEqual([])
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
