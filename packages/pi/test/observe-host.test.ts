// covers: ["ADP-017", "ADP-029"]
import { expect, it, vi } from "vitest"
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { readReceipts } from "../src/receipts.js"
import { routingFixture } from "./routing-fixture.js"
import { observeInput } from "../src/host/observe.js"

it("observes full history rather than recommending a model that only fits the new prompt", async () => {
  const f = routingFixture({
    ...defaultSettings(),
    tiers: {
      quick: [],
      standard: [
        { providerID: "local", id: "a" },
        { providerID: "local", id: "b" },
      ],
      advanced: [],
    },
  })
  const messages = [{ role: "user" as const, content: "history".repeat(1000), timestamp: 0 }]
  const ctx = {
    model: f.a,
    modelRegistry: {
      getAvailable: () =>
        f.faux.models.map((model) => ({
          ...model,
          contextWindow: model.id === "a" ? 100 : 100_000,
        })),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
      buildSessionProjection: () => ({ messages, entries: [], thinkingLevel: "off", model: null }),
    },
  }
  expect(await f.observe({ type: "input", source: "interactive", text: "hi" }, ctx)).toEqual({
    action: "continue",
  })
  expect(await readReceipts(f.sources.receipts)).toMatchObject([
    { decision: { kind: "observe-only", would: { kind: "apply", model: { id: "b" } } } },
  ])
})

it("captures feedback before awaits, reports observation before quiet notes, and isolates feedback failures", async () => {
  const f = routingFixture({
    ...defaultSettings(),
    tiers: { quick: [], standard: [{ providerID: "local", id: "a" }], advanced: [] },
  })
  const ctx = {
    model: f.a,
    modelRegistry: { getAvailable: () => f.faux.models },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
      buildSessionProjection: () => ({
        messages: [],
        entries: [],
        thinkingLevel: "off",
        model: null,
      }),
    },
  }
  const show = vi.fn()
  const capture = vi.fn(() => show)
  const observer = observeInput(f.host, f.sources, { last: undefined }, capture)
  const pending = observer({ type: "input", source: "interactive", text: "next" }, ctx)
  expect(capture).toHaveBeenCalledWith(ctx)
  expect(show).not.toHaveBeenCalled()
  await pending
  expect(show).toHaveBeenCalledExactlyOnceWith({ kind: "observing", tier: "standard" })
  expect(f.host.appendEntry).not.toHaveBeenCalled()
})

it("reports degraded observation and never lets feedback interrupt the user", async () => {
  const f = routingFixture()
  const ctx = {
    model: f.a,
    modelRegistry: { getAvailable: () => f.faux.models },
    sessionManager: {
      getBranch: () => [],
      buildSessionProjection: () => {
        throw new Error("context unavailable")
      },
    },
  }
  const show = vi.fn()
  const observer = observeInput(f.host, f.sources, { last: undefined }, () => show)
  expect(await observer({ type: "input", source: "interactive", text: "next" }, ctx)).toEqual({
    action: "continue",
  })
  expect(show).toHaveBeenCalledExactlyOnceWith({ kind: "degraded" })
  const throwing = observeInput(f.host, f.sources, { last: undefined }, () => () => {
    throw new Error("status failed")
  })
  expect(await throwing({ type: "input", source: "interactive", text: "next" }, ctx)).toEqual({
    action: "continue",
  })
  const captureFailure = observeInput(f.host, f.sources, { last: undefined }, () => {
    throw new Error("capture failed")
  })
  expect(await captureFailure({ type: "input", source: "interactive", text: "next" }, ctx)).toEqual(
    { action: "continue" },
  )
})

it("uses the SDK's compacted and edited context, ignores Adaptive notes, and keeps historical images", async () => {
  const f = routingFixture({
    ...defaultSettings(),
    tiers: {
      quick: [],
      standard: [
        { providerID: "local", id: "a" },
        { providerID: "local", id: "b" },
      ],
      advanced: [],
    },
  })
  const timestamp = "2026-01-01T00:00:00.000Z"
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "old",
      parentId: null,
      timestamp,
      message: { role: "user", timestamp: 0, content: "discarded".repeat(10000) },
    },
    {
      type: "message",
      id: "kept",
      parentId: "old",
      timestamp,
      message: {
        role: "user",
        timestamp: 0,
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "kept",
      timestamp,
      firstKeptEntryId: "kept",
      summary: "small summary",
      tokensBefore: 100000,
    },
    {
      type: "custom",
      id: "note",
      parentId: "compact",
      timestamp,
      customType: "adaptive.note",
      data: { text: "note".repeat(10000) },
    },
  ]
  const ctx = {
    model: f.a,
    modelRegistry: {
      getAvailable: () =>
        f.faux.models.map((model) => ({
          ...model,
          input: model.id === "a" ? ["text" as const] : ["text" as const, "image" as const],
          contextWindow: 10000,
        })),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
      buildSessionProjection: () => buildSessionProjection(entries),
    },
  }
  await f.observe({ type: "input", source: "interactive", text: "next" }, ctx)
  expect(await readReceipts(f.sources.receipts)).toMatchObject([
    { decision: { would: { model: { id: "b" } } } },
  ])
  entries.push({
    type: "context_edit",
    id: "edit",
    parentId: "note",
    timestamp,
    targetId: "kept",
    replacement: { content: "image removed" },
  })
  await f.observe({ type: "input", source: "interactive", text: "next" }, ctx)
  expect((await readReceipts(f.sources.receipts))[0]).toMatchObject({
    decision: { would: { model: { id: "a" } } },
  })
  expect(f.host.appendEntry).not.toHaveBeenCalled()
})

it("fails open without a full-context API and performs no routing work while OFF", async () => {
  const f = routingFixture()
  const ctx = {
    model: f.a,
    modelRegistry: { getAvailable: vi.fn(() => f.faux.models) },
    sessionManager: { getBranch: () => [] },
  }
  expect(await f.observe({ type: "input", source: "interactive", text: "next" }, ctx)).toEqual({
    action: "continue",
  })
  expect(ctx.modelRegistry.getAvailable).not.toHaveBeenCalled()
  expect(await readReceipts(f.sources.receipts)).toEqual([])
  const off = routingFixture({ ...defaultSettings(), mode: "off" })
  const projection = vi.fn(() => {
    throw new Error("OFF must not inspect context")
  })
  const capabilities = vi.spyOn(off.sources, "capabilities")
  await off.observe(
    { type: "input", source: "interactive", text: "next" },
    {
      ...ctx,
      sessionManager: { ...ctx.sessionManager, buildSessionProjection: projection },
    },
  )
  expect(projection).not.toHaveBeenCalled()
  expect(capabilities).not.toHaveBeenCalled()
  expect(await off.sources.health.file.read()).toBeUndefined()
  expect(await off.sources.capacity.file.read()).toBeUndefined()
  expect(await off.sources.receipts.read()).toBeUndefined()
})
