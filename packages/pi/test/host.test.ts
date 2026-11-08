import { expect, it, vi } from "vitest"
import * as scheduler from "@coool/adaptive-core/routing/scheduler/admit"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ToolCapability } from "../src/capabilities.js"
import { afterRun, virtualModels, type AdaptiveSources } from "../src/host/extension.js"
import type { BranchEntry } from "../src/task.js"

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
const [a, b] = faux.models
if (b === undefined) throw new Error("faux fixture models missing")
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: {
    quick: [{ providerID: a.provider, id: a.id }],
    standard: [{ providerID: b.provider, id: b.id }],
    advanced: [{ providerID: a.provider, id: a.id }],
  },
}
const branch = { getBranch: () => [] }
const ctx = { modelRegistry: { getAvailable: () => faux.models }, sessionManager: branch }
function sources(
  read: () => Promise<SettingsV1>,
  capabilities: () => Promise<readonly ToolCapability[]> = () => Promise.resolve([]),
): AdaptiveSources {
  let next = 0
  const newId = (): string => {
    next += 1
    return `id-${String(next)}`
  }
  return { settings: read, capabilities, newId }
}
const request = { model: a, reason: "user" as const, thinkingLevel: "off" as const, messages: [] }

it("binds four models and routes physical models through shared admission", async () => {
  for (const definition of virtualModels(
    sources(() => Promise.resolve(settings)),
    () => [],
  )) {
    const result = await definition.route(request, ctx)
    expect(result.model.id).toBe(
      definition.id === "auto" || definition.id === "standard" ? "b" : "a",
    )
  }
})

it("preserves previous physical choices and excludes virtual catalogue entries", async () => {
  const [definition] = virtualModels(
    sources(() => Promise.resolve(settings)),
    () => [],
  )
  if (definition === undefined) throw new Error("missing fixture")
  const result = await definition.route(
    { ...request, reason: "continuation", previous: { model: a } },
    {
      modelRegistry: { getAvailable: () => [...faux.models, { ...a, provider: "adaptive" }] },
      sessionManager: branch,
    },
  )
  expect(result.model.id).toBe("a")
})

it("does not apply routing changes in observe/off and requires a compatible baseline", async () => {
  for (const mode of ["observe", "off"] as const) {
    for (const definition of virtualModels(
      sources(() => Promise.resolve({ ...settings, mode })),
      () => [],
    )) {
      expect((await definition.route({ ...request, previous: { model: a } }, ctx)).model.id).toBe(
        "a",
      )
      expect((await definition.route(request, ctx)).model.id).toBe(
        definition.id === "auto" || definition.id === "standard" ? "b" : "a",
      )
    }
  }
  const [empty] = virtualModels(
    sources(() => Promise.resolve(defaultSettings())),
    () => [],
  )
  await expect(empty?.route(request, ctx)).rejects.toThrow("no-candidates")
  const [pin] = virtualModels(
    sources(() =>
      Promise.resolve({ ...settings, mode: "observe", pin: { providerID: "local", id: "a" } }),
    ),
    () => [],
  )
  expect((await pin?.route(request, ctx))?.model.id).toBe("a")
})

it("rejects tool support that Pi's catalogue cannot verify, oversized context, and unsupported images", async () => {
  const [tools] = virtualModels(
    sources(() => Promise.resolve(settings)),
    () => ["read"],
  )
  await expect(tools?.route(request, ctx)).rejects.toThrow("no-compatible-resource")
  const [definition] = virtualModels(
    sources(() => Promise.resolve(settings)),
    () => [],
  )
  await expect(
    definition?.route(
      { ...request, messages: [{ role: "user", timestamp: 0, content: "large".repeat(1000) }] },
      {
        modelRegistry: {
          getAvailable: () => faux.models.map((model) => ({ ...model, contextWindow: 1 })),
        },
        sessionManager: branch,
      },
    ),
  ).rejects.toThrow("no-compatible-resource")
  await expect(
    definition?.route(
      {
        ...request,
        messages: [
          {
            role: "user",
            timestamp: 0,
            content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
          },
        ],
      },
      {
        modelRegistry: {
          getAvailable: () => faux.models.map((model) => ({ ...model, input: ["text"] })),
        },
        sessionManager: branch,
      },
    ),
  ).rejects.toThrow("no-compatible-resource")
})

it("uses only exact, explicit tool declarations including negative declarations", async () => {
  for (const tools of [true, false]) {
    const [definition] = virtualModels(
      sources(
        () => Promise.resolve(settings),
        () =>
          Promise.resolve([
            { providerID: "other", id: "b", tools: true },
            { providerID: "local", id: "unknown", tools: true },
            { providerID: "local", id: "b", tools },
          ]),
      ),
      () => ["read"],
    )
    if (definition === undefined) throw new Error("missing fixture")
    if (tools) expect((await definition.route(request, ctx)).model.id).toBe("b")
    else await expect(definition.route(request, ctx)).rejects.toThrow("no-compatible-resource")
  }
})

it("does not dispatch an unexpected resource returned across the scheduler boundary", async () => {
  const injected = vi.spyOn(scheduler, "admit").mockReturnValueOnce({
    kind: "apply",
    model: { providerID: "unconfigured", id: "model" },
    reason: "preferred",
    evidence: { skipped: [] },
  })
  try {
    const [definition] = virtualModels(
      sources(() => Promise.resolve(settings)),
      () => [],
    )
    await expect(definition?.route(request, ctx)).rejects.toThrow("inventory changed")
  } finally {
    injected.mockRestore()
  }
})

it("stores task state only when the plan changes it", async () => {
  const [auto] = virtualModels(
    sources(() => Promise.resolve(settings)),
    () => [],
  )
  if (auto === undefined) throw new Error("missing fixture")
  const started = await auto.route(request, ctx)
  expect(started.state).toEqual({
    version: 1,
    task: "id-1",
    unit: "id-2",
    tier: "standard",
    escalations: 0,
  })
  // Pi compares by identity: handing back its own object appends nothing.
  const stored: unknown = JSON.parse(JSON.stringify(started.state))
  const continued = await auto.route(
    { ...request, reason: "continuation", previous: { model: b }, state: stored },
    ctx,
  )
  expect(continued.state).toBe(stored)
  await expect(auto.route({ ...request, state: { version: 2 } }, ctx)).rejects.toThrow(
    "Adaptive task state: version must be 1",
  )
})

const failedRun: readonly BranchEntry[] = [
  {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: {
      provider: "adaptive",
      modelId: "auto",
      state: { version: 1, task: "t", unit: "u", tier: "standard", escalations: 0 },
    },
  },
  { type: "message", message: { role: "user" } },
  {
    type: "message",
    message: {
      role: "assistant",
      provider: "local",
      model: "b",
      stopReason: "error",
      errorMessage: "prompt is too long: 9000 tokens > 8000 maximum",
    },
  },
]
function settle(model: { provider: string; id: string } | undefined, hasUI = true) {
  const notices: string[] = []
  return {
    notices,
    ctx: {
      ...ctx,
      sessionManager: { getBranch: () => failedRun },
      model,
      hasUI,
      ui: {
        notify: (message: string) => {
          notices.push(message)
        },
      },
    },
  }
}

it("continues a capability failure on the next tier with a hidden owned message", async () => {
  for (const hasUI of [true, false]) {
    const sent: unknown[] = []
    const { ctx: settled, notices } = settle({ provider: "adaptive", id: "auto" }, hasUI)
    await afterRun(
      { aborted: false },
      settled,
      sources(() => Promise.resolve(settings)),
      (message) => sent.push(message),
    )
    expect(sent).toEqual([
      {
        customType: "adaptive.continuation",
        content: expect.stringContaining("Continue the interrupted work") as unknown,
        display: false,
        details: { task: "t", token: "id-1", tier: "advanced", escalations: 1 },
      },
    ])
    expect(notices).toEqual(
      hasUI ? ["Adaptive: the task needs more capability; continuing on advanced."] : [],
    )
  }
})

it("never continues aborted, manual or unjustified runs, and fails open", async () => {
  const sent: unknown[] = []
  const send = (message: unknown) => sent.push(message)
  const read = sources(() => Promise.resolve(settings))
  await afterRun({ aborted: true }, settle({ provider: "adaptive", id: "auto" }).ctx, read, send)
  await afterRun({ aborted: false }, settle({ provider: "local", id: "b" }).ctx, read, send)
  await afterRun({ aborted: false }, settle(undefined).ctx, read, send)
  await afterRun(
    { aborted: false },
    settle({ provider: "adaptive", id: "standard" }).ctx,
    read,
    send,
  )
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
  try {
    await afterRun(
      { aborted: false },
      settle({ provider: "adaptive", id: "auto" }).ctx,
      sources(() => Promise.reject(new Error("settings unreadable"))),
      send,
    )
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("settings unreadable"))
  } finally {
    logged.mockRestore()
  }
  expect(sent).toEqual([])
})
