// covers: ["ADP-032", "ADP-054", "ADP-056", "ADP-062", "ADP-063"]
import { expect, it, vi } from "vitest"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import type { AdaptiveEnv } from "@coool/adaptive-core/flow/controller"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { adaptiveSurface } from "../src/host/adaptive.js"
import { DEFAULT_MODEL_HELP } from "../src/host/actions.js"
import type { AdaptiveSources } from "../src/host/extension.js"
import { withHealth } from "../src/health.js"
import { memoryFile } from "./support/memory-file.js"

const commands = vi.hoisted(() => ({
  options: undefined as
    | {
        env(ctx: ExtensionContext): Promise<AdaptiveEnv>
      }
    | undefined,
}))
vi.mock("../src/host/commands.js", () => ({
  registerCommands: (_pi: unknown, options: NonNullable<typeof commands.options>) => {
    commands.options = options
  },
}))

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("action not wired")
  return value
}

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
const [a] = faux.models
const virtual = { ...a, provider: "adaptive", id: "auto", api: "pi-virtual" }
const models = faux.models
const everything = [...models, virtual]
const configured: SettingsV1 = {
  ...defaultSettings(),
  inviteDismissed: true,
  tiers: { quick: [], standard: [{ providerID: "local", id: "a" }], advanced: [] },
}

function setup(
  options: { settings?: SettingsV1; branch?: unknown[]; hasUI?: boolean; find?: boolean } = {},
) {
  const settings = memoryFile(options.settings ?? configured)
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(options.settings ?? configured),
    capabilities: () => Promise.resolve([{ providerID: "local", id: "a", tools: true }]),
    newId: () => "id",
    health: { file: memoryFile(), clock: () => 1_000, newId: () => "probe" },
    capacity: { file: memoryFile(), clock: () => 1_000 },
    parking: { file: memoryFile(), clock: () => 1_000, timer: () => () => undefined },
    receipts: memoryFile(),
    preferences: memoryFile(),
  }
  const pi = {
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    appendEntry: vi.fn(),
    setModel: vi.fn(() => Promise.resolve(true)),
  }
  const parking = {
    resume: vi.fn(() => Promise.resolve("resumed" as const)),
    cancel: vi.fn(() => Promise.resolve("not-parked" as const)),
  }
  const refresh = vi.fn(() => Promise.resolve())
  const surface = adaptiveSurface(
    pi,
    sources,
    {
      settings,
      capabilities: memoryFile(),
      version: "1.5.0",
      minimum: "1.5.0",
      testedUpTo: "1.5.0",
    },
    parking,
    () => refresh,
  )
  const shown: string[] = []
  const choose = vi.fn((_title: string, choices: string[]): string | undefined => choices[0])
  const confirm = vi.fn(() => Promise.resolve(true))
  // The fake implements exactly the context surface Adaptive reads.
  const ctx = {
    mode: "rpc",
    hasUI: options.hasUI ?? true,
    model: { provider: "adaptive", id: "auto" },
    isIdle: () => true,
    sessionManager: { getSessionId: () => "s", getBranch: () => options.branch ?? [] },
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => everything,
      find: (provider: string, id: string) =>
        options.find === false
          ? undefined
          : everything.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
      getRegisteredProviderConfig: () => undefined,
    },
    ui: {
      select: (title: string, choices: string[]) => {
        shown.push(`${title}\n${choices.join("\n")}`)
        return Promise.resolve(choose(title, choices))
      },
      confirm,
      notify: (message: string) => {
        shown.push(message)
      },
    },
  } as unknown as ExtensionContext
  const env = async () => {
    if (commands.options === undefined) throw new Error("commands missing")
    return commands.options.env(ctx)
  }
  return { sources, settings, pi, parking, surface, shown, choose, confirm, ctx, env, refresh }
}

it("refreshes feedback after successful mode/settings changes, never rejected patches", async () => {
  const f = setup()
  const { api } = await f.env()
  await api.setSettings({ mode: "off" })
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await api.setSettings({ pin: { providerID: "", id: "" } })
  expect(f.refresh).toHaveBeenCalledTimes(1)
  await api.setSessionMode("s", "active")
  expect(f.refresh).toHaveBeenCalledTimes(2)
  await api.setSessionMode("wrong", "off")
  expect(f.refresh).toHaveBeenCalledTimes(2)
})

it("does not refresh a replaced session when an old command finishes", async () => {
  const f = setup()
  const { api } = await f.env()
  vi.spyOn(f.ctx.sessionManager, "getSessionId").mockReturnValue("new-session")
  await api.setSettings({ mode: "off" })
  expect(f.refresh).not.toHaveBeenCalled()
})

it("lists only physical models for the tier editor", async () => {
  const f = setup()
  expect((await f.env()).models().map((model) => model.modelID)).toEqual(["a", "b"])
})

it("wires the clock and forwards resume and cancel to the owned parking", async () => {
  const f = setup()
  const env = await f.env()
  expect(env.clock?.()).toBe(1_000)
  expect(await need(env.actions?.resume)("s")).toBe("resumed")
  expect(await need(env.actions?.cancel)("s")).toBe("not-parked")
  expect(f.parking.resume).toHaveBeenCalledWith(f.ctx)
  expect(f.parking.cancel).toHaveBeenCalledWith(f.ctx)
})

it("pauses a virtual session on the last manual model and refuses when there is none", async () => {
  const manual = { type: "model_change", provider: "local", modelId: "b" }
  const adaptive = { type: "model_change", provider: "adaptive", modelId: "auto" }
  const f = setup({ branch: [manual, adaptive] })
  const { api } = await f.env()
  expect(await api.setSessionMode("s", "off")).toEqual({ ok: true })
  expect(f.pi.setModel).toHaveBeenCalledWith(models[1])
  expect(f.pi.appendEntry).toHaveBeenCalledWith("adaptive.session", { version: 1, mode: "off" })
  const bare = setup({ branch: [adaptive] })
  expect(await (await bare.env()).api.setSessionMode("s", "off")).toMatchObject({ ok: false })
  const missing = setup({ branch: [manual, adaptive], find: false })
  expect(await (await missing.env()).api.setSessionMode("s", "off")).toMatchObject({ ok: false })
  expect(missing.pi.setModel).not.toHaveBeenCalled()
})

it("reports parked work for this and other sessions through the status snapshot", async () => {
  const f = setup()
  const { api } = await f.env()
  expect((await api.status()).waiting).toEqual([])
  await f.sources.parking.file.update(() => ({
    next: {
      version: 1,
      records: [
        { session: "s", token: "t1", tier: "standard", due: 5_000, wakes: 0, claimed: false },
        { session: "other", token: "t2", tier: "quick", due: 6_000, wakes: 0, claimed: false },
      ],
    },
    result: undefined,
  }))
  expect((await api.status()).waiting).toEqual([
    { sessionID: "s", tier: "standard", resumeAt: 5_000 },
    { sessionID: "other", tier: "quick", resumeAt: 6_000 },
  ])
})

it("resets the health of a configured resource, and shows the Pi settings for a default", async () => {
  const f = setup()
  await withHealth(f.sources.health, (registry) => {
    registry.observe({
      kind: "failure",
      key: { providerID: "local", modelID: "a" },
      category: "quota_exhausted",
      definitive: true,
      retryAfterMs: 60_000,
    })
  })
  const { actions } = await f.env()
  await need(actions?.resetHealth)({ providerID: "local", id: "a" })
  expect(JSON.stringify(await f.sources.health.file.read())).not.toContain("quota")
  await need(actions?.defaults)()
  expect(f.shown.at(-1)).toContain(DEFAULT_MODEL_HELP.split("\n")[0])
  await need(actions?.preferences)()
  expect(f.shown.at(-1)).toContain("Preferences")
})

it("declares tool support for the configured models from the capabilities file", async () => {
  const f = setup()
  f.choose.mockImplementation((_title, choices) => choices[0])
  await need((await f.env()).actions?.tools)()
  expect(f.shown[0]).toContain("Tool support · select a model")
  expect(f.shown[0]).toContain("local/a")
  expect(f.shown.at(-1)).toBe("Tool capability saved")
})

it("runs the doctor over this session's Pi, storage, health and parked work", async () => {
  const f = setup()
  await withHealth(f.sources.health, (registry) => {
    registry.observe({
      kind: "failure",
      key: { providerID: "local", modelID: "a" },
      category: "quota_exhausted",
      definitive: true,
      retryAfterMs: 60_000,
    })
  })
  const checks = await need((await f.env()).actions?.doctor)()
  const messages = checks.map((check) => check.message)
  expect(messages).toContain("Pi 1.5.0 (supported: ≥1.5.0 <2)")
  expect(messages).toContain("Shared storage writable; exclusive lock works")
  expect(messages).toContain("Health: 1 model limited")
  expect(messages).toContain("No parked work")
})

it("offers first-run setup only with a UI and stays silent without one", async () => {
  const headless = setup({ settings: { ...configured, inviteDismissed: false }, hasUI: false })
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  await headless.surface.onboard(headless.ctx)
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
  expect(headless.shown).toEqual([])
  expect(await headless.settings.read()).toMatchObject({ inviteDismissed: false })
  const interactive = setup({ settings: { ...configured, inviteDismissed: false } })
  interactive.choose.mockImplementation((_title, choices) =>
    choices.find((choice) => choice.includes("use Adaptive this session")),
  )
  await interactive.surface.onboard(interactive.ctx)
  expect(interactive.shown[0]).toContain("Adaptive is installed")
  expect(interactive.pi.setModel).toHaveBeenCalledWith(virtual)
})

it("edits the suggested tiers before saving them", async () => {
  const f = setup({ settings: { ...configured, inviteDismissed: false } })
  const answers = ["Edit suggested tiers", "Back"]
  f.choose.mockImplementation((_title, choices) => {
    const wanted = answers.shift()
    return wanted === undefined ? undefined : choices.find((choice) => choice.includes(wanted))
  })
  await f.surface.onboard(f.ctx)
  expect(f.shown.some((text) => text.startsWith("Adaptive ("))).toBe(true)
})
