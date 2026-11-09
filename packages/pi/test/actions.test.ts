import { expect, it } from "vitest"
import {
  healthAction,
  preferencesAction,
  confirmToolCapability,
  DEFAULT_MODEL_HELP,
} from "../src/host/actions.js"
import { parseSharedHealth, readSharedHealth, resetResourceHealth } from "../src/health-actions.js"
import { ResourceHealthRegistry, DEFAULT_HEALTH_CONFIG } from "@coool/adaptive-core/health/index"
import { fakeView } from "./support/view.js"
import { memoryFile } from "./support/memory-file.js"
import { readPreferences } from "../src/preferences.js"

const ref = { providerID: "p", id: "m" }
it("changes notes and pinned escalation only after the corresponding choice/confirmation", async () => {
  const file = memoryFile()
  for (const [choices, confirms] of [
    [[0, undefined], []],
    [[1], [false]],
    [[undefined], []],
  ] satisfies [(number | undefined)[], boolean[]][]) {
    await preferencesAction(fakeView(choices, confirms).view, file)
    expect(file.value()).toBeUndefined()
  }
  await preferencesAction(fakeView([0, 0]).view, file)
  expect((await readPreferences(file)).verbosity).toBe("quiet")
  await preferencesAction(fakeView([1], [true]).view, file)
  expect((await readPreferences(file)).escalateFromPinned).toBe(true)
  await preferencesAction(fakeView([1], [true]).view, file)
  expect((await readPreferences(file)).escalateFromPinned).toBe(false)
  expect(DEFAULT_MODEL_HELP).toContain('"defaultProvider": "adaptive"')
})

it("never writes a tool declaration without consent, and preserves other declarations", async () => {
  const file = memoryFile()
  await confirmToolCapability(fakeView([], [false]).view, file, ref, true)
  expect(file.value()).toBeUndefined()
  await confirmToolCapability(fakeView([], [true]).view, file, ref, true)
  await confirmToolCapability(
    fakeView([], [true]).view,
    file,
    { providerID: "other", id: "x" },
    false,
  )
  await confirmToolCapability(fakeView([], [true]).view, file, ref, false)
  expect(file.value()).toEqual({
    models: [
      { providerID: "other", id: "x", tools: false },
      { ...ref, tools: false },
    ],
  })
  const corrupt = memoryFile({ newer: true })
  await expect(
    confirmToolCapability(fakeView([], [true]).view, corrupt, ref, true),
  ).rejects.toThrow("capabilities")
})

it("resets the actual inherited health blockers only with confirmation", async () => {
  const registry = new ResourceHealthRegistry(() => 100, DEFAULT_HEALTH_CONFIG)
  registry.observe({
    kind: "failure",
    key: { providerID: "p" },
    category: "quota_exhausted",
    definitive: true,
    retryAfterMs: 1000,
  })
  registry.observe({ kind: "success", key: { providerID: "other", modelID: "x" } })
  const serialized: unknown = JSON.parse(
    JSON.stringify({ version: 1, records: registry.snapshot() }),
  )
  const file = memoryFile(serialized)
  const before = file.value()
  const reset = (model: typeof ref) => resetResourceHealth(file, model)
  await healthAction(fakeView().view, [ref], reset)
  await healthAction(fakeView([0], [false]).view, [ref], reset)
  expect(file.value()).toBe(before)
  await healthAction(fakeView([0], [true]).view, [ref], reset)
  expect((await readSharedHealth(file)).every((record) => record.key.providerID !== "p")).toBe(true)
  expect(parseSharedHealth(undefined)).toEqual([])
  expect(() => parseSharedHealth({ version: 2, records: [] })).toThrow("Adaptive health")
})
