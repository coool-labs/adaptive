// covers: ["ADP-016", "ADP-018", "ADP-019", "ADP-010", "ADP-022"]
import { expect, it } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { recordOutcome, type AdaptiveSources } from "../src/host/extension.js"
import { virtualModels } from "../src/host/routing.js"
import type { BranchEntry } from "../src/task.js"
import { memoryFile } from "./memory-file.js"

const faux = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
const [a, b] = faux.models
if (b === undefined) throw new Error("faux fixture models missing")
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: {
    quick: [{ providerID: "local", id: "a" }],
    standard: [
      { providerID: "local", id: "a" },
      { providerID: "local", id: "b" },
    ],
    advanced: [{ providerID: "local", id: "b" }],
  },
}
const ctx = {
  modelRegistry: { getAvailable: () => faux.models },
  sessionManager: { getBranch: (): BranchEntry[] => [], getSessionId: () => "session" },
}
const auto = { provider: "adaptive", id: "auto" }
const RATE_LIMITED = "429 Rate limit reached for requests per min"
const QUOTA = "429 You exceeded your current quota, please check your plan and billing details."

function fixture() {
  let now = 1_000_000
  let next = 0
  const newId = () => `id-${String(++next)}`
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(settings),
    capabilities: () => Promise.resolve([]),
    newId,
    capacity: { file: memoryFile(), clock: () => now },
    parking: { file: memoryFile(), clock: () => now, timer: () => () => undefined },
    health: { file: memoryFile(), clock: () => now, newId },
    receipts: memoryFile(),
    preferences: memoryFile(),
  }
  const definition = virtualModels(sources, () => []).find((entry) => entry.id === "auto")
  if (definition === undefined) throw new Error("missing auto model")
  const request = {
    model: a,
    reason: "user" as const,
    thinkingLevel: "off" as const,
    messages: [],
  }
  const outcome = (model: "a" | "b", stopReason: string, errorMessage?: string) =>
    recordOutcome(
      {
        role: "assistant",
        provider: "local",
        model,
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
      { model: auto, sessionManager: { getBranch: () => [] } },
      sources,
    )
  return {
    route: definition.route.bind(definition),
    request,
    outcome,
    advance: (ms: number) => {
      now += ms
    },
  }
}

it("fails over within the tier, then returns to the preferred model only at the next safe boundary", async () => {
  const f = fixture()
  const first = await f.route(f.request, ctx)
  expect(first.model.id).toBe("a")
  await f.outcome("a", "error", RATE_LIMITED)

  // A new work unit finds the preferred model limited and takes the next of the same tier.
  const second = await f.route(f.request, ctx)
  expect(second.model.id).toBe("b")

  // The limit lifts while that unit is still running: tool continuations never move it back.
  f.advance(10 * 60_000)
  const continued = await f.route(
    { ...f.request, reason: "continuation", previous: { model: b }, state: second.state },
    ctx,
  )
  expect(continued.model.id).toBe("b")
  expect(continued.state).toBe(second.state)

  // Only the next unit re-admits through the configured order and finds the recovered model.
  const next = await f.route(f.request, ctx)
  expect(next.model.id).toBe("a")
})

it("keeps a limited model out for its whole window and lets exactly one request probe it afterwards", async () => {
  const f = fixture()
  await f.route(f.request, ctx)
  await f.outcome("a", "error", QUOTA)
  for (const elapsed of [0, 60_000, 5 * 60_000]) {
    f.advance(elapsed)
    expect((await f.route(f.request, ctx)).model.id).toBe("b")
  }
  // Past the quota window the breaker lets one probe through; its success closes it.
  f.advance(15 * 60_000)
  expect((await f.route(f.request, ctx)).model.id).toBe("a")
  await f.outcome("a", "stop")
  expect((await f.route(f.request, ctx)).model.id).toBe("a")
})

it("does not let a user abort quarantine the preferred model", async () => {
  const f = fixture()
  await f.route(f.request, ctx)
  await f.outcome("a", "aborted", "429 ignored on a cancelled request")
  expect((await f.route(f.request, ctx)).model.id).toBe("a")
})

it("parks rather than borrowing another tier when the whole tier is limited, and resumes on recovery", async () => {
  const f = fixture()
  await f.route(f.request, ctx)
  await f.outcome("a", "error", RATE_LIMITED)
  await f.outcome("b", "error", RATE_LIMITED)
  // The quick and advanced tiers hold healthy models, yet the standard unit never moves there.
  await expect(f.route(f.request, ctx)).rejects.toThrow("Adaptive unavailable: all-blocked")
  f.advance(31_000)
  expect((await f.route(f.request, ctx)).model.id).toBe("a")
})
