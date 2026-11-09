// covers: ["ADP-024", "ADP-056", "ADP-059", "ADP-062"]
import { expect, it } from "vitest"
import { ResourceHealthRegistry, DEFAULT_HEALTH_CONFIG } from "@coool/adaptive-core/health/index"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { readParked, readStatus } from "../src/host/status.js"
import { memoryFile } from "./support/memory-file.js"

it("shows inherited health and fresh capacity readings, never scheduler signals or stale estimates", async () => {
  const registry = new ResourceHealthRegistry(() => 1000, DEFAULT_HEALTH_CONFIG)
  registry.observe({
    kind: "failure",
    key: { providerID: "p" },
    category: "quota_exhausted",
    definitive: true,
    retryAfterMs: 5000,
  })
  const raw: unknown = JSON.parse(JSON.stringify({ version: 1, records: registry.snapshot() }))
  const sources = {
    settings: () =>
      Promise.resolve({
        ...defaultSettings(),
        tiers: {
          quick: [{ providerID: "other", id: "m" }],
          standard: [{ providerID: "p", id: "m", variant: "high" }],
          advanced: [],
        },
      }),
    health: { file: memoryFile(raw), clock: () => 1000, newId: () => "probe" },
    capacity: {
      file: memoryFile({
        version: 1,
        readings: [
          {
            key: { providerID: "p" },
            reading: {
              usedRatio: 0.824,
              resetAt: 6000,
              observedAt: 1000,
              confidence: "high",
              evidence: "codex-headers",
            },
          },
        ],
      }),
      clock: () => 1000,
    },
    receipts: memoryFile(),
    parked: memoryFile(),
    effectiveMode: () => "observe" as const,
  }
  const status = await readStatus(sources)
  expect(status.tiers.standard[0]).toMatchObject({
    health: "quota_exhausted",
    usedPercent: 82,
    resetAt: 6000,
  })
  expect(status.tiers.quick[0]).toMatchObject({
    health: "healthy",
    usedPercent: null,
    resetAt: null,
  })
  expect(
    await readStatus({ ...sources, capacity: { ...sources.capacity, clock: () => 1_000_000_000 } }),
  ).toMatchObject({ tiers: { standard: [{ usedPercent: null, resetAt: null }] } })
  const parked = memoryFile({
    version: 1,
    records: [
      { session: "s", tier: "standard", token: "t", due: 6000, wakes: 0, claimed: false },
      { session: "claimed", tier: "quick", token: "c", due: 5000, wakes: 1, claimed: true },
    ],
  })
  expect(await readStatus({ ...sources, parked })).toMatchObject({
    parked: 1,
    waiting: [{ sessionID: "s", tier: "standard", resumeAt: 6000 }],
  })
})

it("reads parked state strictly without repairing or dispatching anything", async () => {
  expect(await readParked(memoryFile())).toEqual([])
  for (const raw of [
    null,
    { version: 2, records: [] },
    { version: 1, records: null },
    { version: 1, records: [null] },
    { version: 1, records: Array.from({ length: 513 }, () => null) },
  ]) {
    const file = memoryFile(raw)
    await expect(readParked(file)).rejects.toThrow("Adaptive parked")
    expect(file.value()).toBe(raw)
  }
})
