// covers: ["ADP-020", "ADP-021", "ADP-031", "ADP-051", "ADP-056", "ADP-059"]
import { resourceUsableAt } from "@coool/adaptive-core/execution/parking/wake"
import { admit } from "@coool/adaptive-core/routing/scheduler/admit"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { CAPACITY_VERSION, MAX_CAPACITY_READINGS } from "@coool/adaptive-core/state/capacity/types"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { buildStatus } from "@coool/adaptive-core/status"
import { afterEach, expect, it, vi } from "vitest"
import { observeCodexHeaders, readCapacity, type SharedCapacity } from "../src/capacity.js"
import type { JsonFile } from "../src/store.js"

const A: ModelRef = { providerID: "openai-codex", id: "a" }
const B: ModelRef = { providerID: "other", id: "b" }
const SIBLING: ModelRef = { providerID: A.providerID, id: "sibling", variant: "fast" }

/** Each update serializes like JsonFile's cross-process lock, without timers. */
class MemoryFile implements JsonFile {
  data: unknown
  writes = 0
  failed = false
  #tail: Promise<unknown> = Promise.resolve()

  read(): Promise<unknown> {
    return Promise.resolve(this.data)
  }

  update<R>(
    change: (current: unknown) => { readonly next: unknown; readonly result: R },
  ): Promise<R> {
    const run = this.#tail.then(() => {
      if (this.failed) throw new Error("secret adapter failure")
      const { next, result } = change(this.data)
      if (next !== undefined) {
        this.data = next
        this.writes += 1
      }
      return result
    })
    this.#tail = run.catch(() => undefined)
    return run
  }
}

function fixture() {
  const file = new MemoryFile()
  let now = 1_000
  const shared: SharedCapacity = { file, clock: () => now }
  return {
    file,
    shared,
    time: (value: number) => {
      now = value
    },
  }
}

function telemetry(percent = "95", reset = "120"): Record<string, string> {
  return {
    "x-codex-primary-used-percent": percent,
    "x-codex-primary-reset-after-seconds": reset,
  }
}

function entry(providerID: string, observedAt = 1_000) {
  return {
    key: { providerID },
    reading: { usedRatio: 0.25, confidence: "high", observedAt },
  }
}

afterEach(() => vi.restoreAllMocks())

it("reports explicit unknown readings without inventing capacity or touching the mirror", async () => {
  const { file, shared } = fixture()
  for (const headers of [{}, { "retry-after": "10" }, telemetry("not a number"), telemetry("101")])
    await observeCodexHeaders(shared, A.providerID, headers)
  expect(await readCapacity(shared, [A, B])).toEqual({
    capacity: {},
    readings: { [schedulerHealthKey(A)]: null, [schedulerHealthKey(B)]: null },
  })
  expect(file.data).toBeUndefined()
  expect(file.writes).toBe(0)
  expect(await readCapacity(shared, [])).toEqual({ capacity: {}, readings: {} })
})

it("shares provider-wide Codex observations with status and every model of another reader", async () => {
  const { file, shared } = fixture()
  await observeCodexHeaders(shared, A.providerID, {
    Authorization: "secret key",
    "set-cookie": ["secret cookie"],
    "X-Codex-Primary-Used-Percent": "30",
    "LLM_PROVIDER-X-CODEX-SECONDARY-USED-PERCENT": "96",
    "llm_provider-x-codex-secondary-reset-at": "",
    "llm_provider-x-codex-secondary-reset-after-seconds": "120",
    "x-codex-private-token": "secret Codex token",
  })
  const anotherProcess: SharedCapacity = { file, clock: () => 2_000 }
  const view = await readCapacity(anotherProcess, [A, SIBLING, B])
  const reading = {
    usedRatio: 0.96,
    remainingRatio: 1 - 0.96,
    resetAt: 121_000,
    confidence: "high",
    observedAt: 1_000,
    evidence: "x-codex headers",
  }
  expect(view.readings).toEqual({
    [schedulerHealthKey(A)]: reading,
    [schedulerHealthKey(SIBLING)]: reading,
    [schedulerHealthKey(B)]: null,
  })
  expect(view.capacity).toEqual({
    [schedulerHealthKey(A)]: { draining: true, exhausted: false },
    [schedulerHealthKey(SIBLING)]: { draining: true, exhausted: false },
  })
  expect(file.data).toEqual({
    version: CAPACITY_VERSION,
    readings: [{ key: { providerID: A.providerID }, reading }],
  })
  expect(JSON.stringify(file.data)).not.toContain("secret")
  expect(file.writes).toBe(1)
  const settings = defaultSettings()
  const status = buildStatus({
    settings: { ...settings, tiers: { ...settings.tiers, standard: [A, SIBLING, B] } },
    health: [],
    capacity: view.readings,
    parked: 0,
    waiting: [],
    receipts: 0,
  })
  expect(
    status.tiers.standard.map(({ usedPercent, resetAt }) => ({ usedPercent, resetAt })),
  ).toEqual([
    { usedPercent: 96, resetAt: 121_000 },
    { usedPercent: 96, resetAt: 121_000 },
    { usedPercent: null, resetAt: null },
  ])
})

it("uses core confidence, exhaustion and freshness rather than estimating absent metadata", async () => {
  const { shared, time } = fixture()
  await observeCodexHeaders(shared, A.providerID, { "x-codex-primary-used-percent": "95" })
  expect((await readCapacity(shared, [A])).capacity[schedulerHealthKey(A)]).toEqual({
    draining: false,
    exhausted: false,
  })
  time(2_000)
  await observeCodexHeaders(shared, A.providerID, { "x-codex-primary-used-percent": "100" })
  expect((await readCapacity(shared, [A])).capacity[schedulerHealthKey(A)]).toEqual({
    draining: false,
    exhausted: true,
  })
  time(62_000)
  expect((await readCapacity(shared, [A])).readings[schedulerHealthKey(A)]).toMatchObject({
    observedAt: 2_000,
  })
  time(62_001)
  expect(await readCapacity(shared, [A])).toEqual({
    capacity: {},
    readings: { [schedulerHealthKey(A)]: null },
  })
})

it("feeds the shared scheduler so draining yields only at a new admission and exhaustion parks", async () => {
  const { shared, time } = fixture()
  const base = {
    routing: { kind: "tier", tier: "standard", source: "default" } as const,
    inventory: [A, B].map((ref) => ({
      providerID: ref.providerID,
      modelID: ref.id,
      enabled: true,
      providerEnabled: true,
      variantAvailable: true,
    })),
    demand: {},
    tierCandidates: [A, B],
    health: {},
  }
  await observeCodexHeaders(shared, A.providerID, telemetry())
  const { capacity } = await readCapacity(shared, [A, B])
  expect(admit({ ...base, capacity })).toMatchObject({ kind: "apply", model: B })
  expect(admit({ ...base, capacity, tierCandidates: [A] })).toMatchObject({
    kind: "apply",
    model: A,
    reason: "draining",
  })
  expect(admit({ ...base, capacity, routing: { kind: "pin", model: A } })).toMatchObject({
    kind: "apply",
    model: A,
    reason: "pin",
  })
  time(2_000)
  await observeCodexHeaders(shared, A.providerID, telemetry("100"))
  const exhausted = await readCapacity(shared, [A])
  expect(admit({ ...base, capacity: exhausted.capacity, tierCandidates: [A] })).toMatchObject({
    kind: "park",
    reason: "all-blocked",
  })
  // Parking must not use the five-minute unknown fallback for a capacity-only block.
  expect(resourceUsableAt([], exhausted.readings[schedulerHealthKey(A)] ?? null, 2_000)).toBe(
    62_000,
  )
})

it("merges peers under the file lock, preserving newer and equal-time observations", async () => {
  const { file, shared, time } = fixture()
  const peer: SharedCapacity = { file, clock: () => 2_000 }
  await Promise.all([
    observeCodexHeaders(shared, A.providerID, telemetry("50")),
    observeCodexHeaders(peer, B.providerID, telemetry("25")),
  ])
  time(3_000)
  await observeCodexHeaders(shared, A.providerID, telemetry("75"))
  await observeCodexHeaders(shared, A.providerID, telemetry("5"))
  time(2_000)
  await observeCodexHeaders(shared, A.providerID, telemetry("10"))
  const view = await readCapacity(peer, [A, B])
  expect(view.readings[schedulerHealthKey(A)]).toMatchObject({ usedRatio: 0.75, observedAt: 3_000 })
  expect(view.readings[schedulerHealthKey(B)]).toMatchObject({ usedRatio: 0.25, observedAt: 2_000 })
  // Invalid/missing telemetry is not a new observation and cannot refresh age.
  time(4_000)
  await observeCodexHeaders(shared, A.providerID, {})
  await observeCodexHeaders(shared, A.providerID, telemetry("bad"))
  expect((await readCapacity(shared, [A])).readings[schedulerHealthKey(A)]).toMatchObject({
    observedAt: 3_000,
  })
})

it("bounds retention and evicts oldest observations first", async () => {
  const { file, shared, time } = fixture()
  file.data = {
    version: CAPACITY_VERSION,
    readings: Array.from({ length: MAX_CAPACITY_READINGS }, (_, index) =>
      entry(`p${String(index)}`, index),
    ),
  }
  time(MAX_CAPACITY_READINGS)
  await observeCodexHeaders(shared, A.providerID, telemetry())
  const expected = [
    expect.objectContaining({ key: { providerID: A.providerID } }),
    ...Array.from({ length: MAX_CAPACITY_READINGS - 1 }, (_, index) =>
      entry(`p${String(MAX_CAPACITY_READINGS - index - 1)}`, MAX_CAPACITY_READINGS - index - 1),
    ),
  ]
  expect(file.data).toEqual({ version: CAPACITY_VERSION, readings: expected })
})

it("merges model and variant scopes through the core resource chain", async () => {
  const { file, shared } = fixture()
  file.data = {
    version: CAPACITY_VERSION,
    readings: [
      entry(A.providerID),
      {
        key: { providerID: A.providerID, modelID: SIBLING.id, variantID: SIBLING.variant },
        reading: { usedRatio: 1, remainingRatio: 0, confidence: "high", observedAt: 1_000 },
      },
    ],
  }
  const view = await readCapacity(shared, [A, SIBLING])
  expect(view.capacity[schedulerHealthKey(A)]).toEqual({ draining: false, exhausted: false })
  expect(view.capacity[schedulerHealthKey(SIBLING)]).toEqual({ draining: false, exhausted: true })
})

it("fails open on malformed telemetry without persisting or logging untrusted content", async () => {
  const { file, shared, time } = fixture()
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  for (const headers of [undefined, null, "secret", [], { "x-codex-primary-used-percent": 95 }])
    await observeCodexHeaders(shared, A.providerID, headers)
  for (const provider of [undefined, "", "x".repeat(129)])
    await observeCodexHeaders(shared, provider, telemetry())
  const throwingHeaders = {
    get secret() {
      throw new Error("secret getter")
    },
  }
  await observeCodexHeaders(shared, A.providerID, throwingHeaders)
  time(-1)
  await observeCodexHeaders(shared, A.providerID, telemetry())
  expect(file.writes).toBe(0)
  expect(log).toHaveBeenCalledTimes(9)
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
})

it("fails open on corrupt or newer persisted state and never overwrites it", async () => {
  const { file, shared } = fixture()
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const malformed = [
    null,
    [],
    { version: 99, readings: [] },
    { version: CAPACITY_VERSION, readings: "secret" },
    { version: CAPACITY_VERSION, readings: [null] },
    { version: CAPACITY_VERSION, readings: [{ ...entry("p"), secret: "secret" }] },
    {
      version: CAPACITY_VERSION,
      readings: [{ ...entry("p"), reading: { ...entry("p").reading, remainingRatio: 2 } }],
    },
    {
      version: CAPACITY_VERSION,
      readings: Array.from({ length: MAX_CAPACITY_READINGS + 1 }, () => entry("p")),
    },
  ]
  for (const raw of malformed) {
    file.data = raw
    expect(await readCapacity(shared, [A])).toEqual({
      capacity: {},
      readings: { [schedulerHealthKey(A)]: null },
    })
    await observeCodexHeaders(shared, A.providerID, telemetry())
    expect(file.data).toBe(raw)
  }
  expect(file.writes).toBe(0)
  expect(log).toHaveBeenCalledTimes(malformed.length * 2)
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
})

it("treats optional store and clock failures as unknown and recovers on a later read", async () => {
  const { file, shared } = fixture()
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  file.failed = true
  await observeCodexHeaders(shared, A.providerID, telemetry())
  expect(await readCapacity(shared, [A])).toEqual({
    capacity: {},
    readings: { [schedulerHealthKey(A)]: null },
  })
  file.failed = false
  await observeCodexHeaders(shared, A.providerID, telemetry())
  expect((await readCapacity(shared, [A])).readings[schedulerHealthKey(A)]).not.toBeNull()
  const brokenClock: SharedCapacity = {
    file,
    clock: () => {
      throw new Error("secret clock")
    },
  }
  await observeCodexHeaders(brokenClock, A.providerID, telemetry())
  expect(await readCapacity(brokenClock, [A])).toEqual({
    capacity: {},
    readings: { [schedulerHealthKey(A)]: null },
  })
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
})
