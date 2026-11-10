// covers: ["ADP-031", "ADP-051", "ADP-061"]
import { afterEach, expect, it, vi } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { SESSION_ENTRY } from "../src/session.js"
import { registerAdaptive, type AdaptiveSources } from "../src/host/extension.js"
import type { BranchEntry } from "../src/task.js"
import { memoryFile } from "./memory-file.js"

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
const [a] = faux.models
const settings: SettingsV1 = {
  ...defaultSettings(),
  mode: "active",
  tiers: {
    quick: [{ providerID: "local", id: "a" }],
    standard: [
      { providerID: "local", id: "b" },
      { providerID: "local", id: "a" },
    ],
    advanced: [{ providerID: "local", id: "b" }],
  },
}
const QUOTA = "429 You exceeded your current quota, please check your plan and billing details."

function fixture() {
  let next = 0
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(settings),
    capabilities: () => Promise.resolve([]),
    newId: () => `id-${String(++next)}`,
    health: { file: memoryFile(), clock: () => 1_000, newId: () => "probe" },
    capacity: { file: memoryFile(), clock: () => 1_000 },
    parking: { file: memoryFile(), clock: () => 1_000, timer: () => () => undefined },
    receipts: memoryFile(),
    preferences: memoryFile(),
  }
  const on = vi.fn()
  const sendMessage = vi.fn()
  const registerVirtualModel = vi.fn()
  // The fake implements exactly the host surface registerAdaptive consumes.
  const pi = {
    registerVirtualModel,
    getActiveTools: () => [],
    registerTool: vi.fn(),
    on,
    sendMessage,
    sendUserMessage: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    setModel: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as Parameters<typeof registerAdaptive>[0]
  registerAdaptive(pi, sources, {
    settings: memoryFile(settings),
    capabilities: memoryFile(),
    version: "1.5.0",
    minimum: "1.5.0",
    testedUpTo: "1.5.0",
  })
  const handler = (name: string): ((event: unknown, ctx: unknown) => Promise<unknown>) => {
    const call = on.mock.calls.find(([event]) => event === name)
    if (call === undefined) throw new Error(`no ${name} handler`)
    return call[1] as (event: unknown, ctx: unknown) => Promise<unknown>
  }
  return { handler, sendMessage, sources }
}

const virtual = { provider: "adaptive", id: "auto" }
const state = {
  version: 1,
  task: "t",
  unit: "u",
  tier: "standard",
  escalations: 0,
  restarts: 0,
  tried: [],
}
const running: BranchEntry[] = [
  {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "adaptive", modelId: "auto", state },
  },
  { type: "message", message: { role: "user" } },
  {
    type: "message",
    message: {
      role: "assistant",
      provider: "local",
      model: "b",
      stopReason: "error",
      errorMessage: QUOTA,
    },
  },
]

function context(branch: readonly BranchEntry[], model: unknown = virtual) {
  return {
    model,
    mode: "print",
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), setWorkingMessage: vi.fn() },
    modelRegistry: { getAvailable: () => faux.models },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session",
      buildSessionProjection: () => ({ messages: [] }),
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

it("recovers a quota failure when the branch is well formed", async () => {
  const f = fixture()
  await f.handler("agent_settled")({ aborted: false }, context(running))
  expect(f.sendMessage).toHaveBeenCalledOnce()
})

it.each([
  ["corrupt router state", { ...state, version: 2 }],
  ["a negative restart count", { ...state, restarts: -1 }],
  ["an unknown tier", { ...state, tier: "ultra" }],
])("never recovers or throws into Pi when the branch holds %s", async (_name, broken) => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const f = fixture()
  const branch = running.map((entry) =>
    entry.type === "custom"
      ? { ...entry, data: { ...(entry.data as object), state: broken } }
      : entry,
  )
  await expect(
    f.handler("agent_settled")({ aborted: false }, context(branch)),
  ).resolves.toBeUndefined()
  expect(f.sendMessage).not.toHaveBeenCalled()
  expect(logged).toHaveBeenCalled()
})

it("never lets a corrupt session override throw out of any Pi event, and leaves a manual model alone", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const f = fixture()
  const corrupt: BranchEntry = {
    type: "custom",
    customType: SESSION_ENTRY,
    data: { version: 1, mode: "sometimes" },
  }
  const failed = {
    role: "assistant",
    provider: "local",
    model: "b",
    stopReason: "error",
    errorMessage: QUOTA,
  }
  const events: readonly (readonly [string, unknown])[] = [
    ["agent_settled", { aborted: false }],
    ["message_end", { message: failed }],
    ["input", { source: "interactive", text: "hello" }],
    ["model_select", { model: a, previousModel: virtual }],
    ["session_tree", {}],
    ["session_start", {}],
  ]
  // The override is only consulted for a manually chosen model; it fails open there.
  const manual = context([...running, corrupt], a)
  for (const [name, event] of events)
    await expect(f.handler(name)(event, manual)).resolves.not.toThrow()
  expect(f.sendMessage).not.toHaveBeenCalled()
  await expect(f.handler("session_shutdown")({}, manual)).resolves.toBeUndefined()
})

it("keeps recovering a virtual session whose branch holds a corrupt override: virtual selection is always active", async () => {
  const f = fixture()
  const corrupt: BranchEntry = {
    type: "custom",
    customType: SESSION_ENTRY,
    data: { version: 1, mode: "sometimes" },
  }
  await f.handler("agent_settled")({ aborted: false }, context([...running, corrupt]))
  expect(f.sendMessage).toHaveBeenCalledOnce()
})

it("never overwrites an unreadable shared health file while still recording nothing from it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const f = fixture()
  const unreadable = vi.fn(() => Promise.reject(new Error("health is not valid JSON")))
  const update = vi.spyOn(f.sources.health.file, "update").mockImplementation(unreadable)
  await expect(
    f.handler("message_end")(
      {
        message: {
          role: "assistant",
          provider: "local",
          model: "b",
          stopReason: "error",
          errorMessage: QUOTA,
        },
      },
      context([]),
    ),
  ).resolves.toBeUndefined()
  expect(update).toHaveBeenCalledOnce()
})
