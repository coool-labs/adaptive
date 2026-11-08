import { expect, it, vi } from "vitest"
import * as scheduler from "@coool/adaptive-core/routing/scheduler/admit"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { virtualModels } from "../src/host/extension.js"

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
const ctx = { modelRegistry: { getAvailable: () => faux.models } }
const request = { model: a, reason: "user" as const, thinkingLevel: "off" as const, messages: [] }

it("binds four models and routes physical models through shared admission", async () => {
  for (const definition of virtualModels(
    () => Promise.resolve(settings),
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
    () => Promise.resolve(settings),
    () => [],
  )
  if (definition === undefined) throw new Error("missing fixture")
  const result = await definition.route(
    { ...request, reason: "continuation", previous: { model: a } },
    {
      modelRegistry: { getAvailable: () => [...faux.models, { ...a, provider: "adaptive" }] },
    },
  )
  expect(result.model.id).toBe("a")
})

it("does not apply routing changes in observe/off and requires a compatible baseline", async () => {
  for (const mode of ["observe", "off"] as const) {
    for (const definition of virtualModels(
      () => Promise.resolve({ ...settings, mode }),
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
    () => Promise.resolve(defaultSettings()),
    () => [],
  )
  await expect(empty?.route(request, ctx)).rejects.toThrow("no-candidates")
  const [pin] = virtualModels(
    () => Promise.resolve({ ...settings, mode: "observe", pin: { providerID: "local", id: "a" } }),
    () => [],
  )
  expect((await pin?.route(request, ctx))?.model.id).toBe("a")
})

it("rejects tool support that Pi's catalogue cannot verify, oversized context, and unsupported images", async () => {
  const [tools] = virtualModels(
    () => Promise.resolve(settings),
    () => ["read"],
  )
  await expect(tools?.route(request, ctx)).rejects.toThrow("no-compatible-resource")
  const [definition] = virtualModels(
    () => Promise.resolve(settings),
    () => [],
  )
  await expect(
    definition?.route(
      { ...request, messages: [{ role: "user", timestamp: 0, content: "large".repeat(1000) }] },
      {
        modelRegistry: {
          getAvailable: () => faux.models.map((model) => ({ ...model, contextWindow: 1 })),
        },
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
      },
    ),
  ).rejects.toThrow("no-compatible-resource")
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
      () => Promise.resolve(settings),
      () => [],
    )
    await expect(definition?.route(request, ctx)).rejects.toThrow("inventory changed")
  } finally {
    injected.mockRestore()
  }
})
