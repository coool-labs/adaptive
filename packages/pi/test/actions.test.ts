import { expect, it } from "vitest"
import { preferencesAction, toolSupportAction, DEFAULT_MODEL_HELP } from "../src/host/actions.js"
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

it("declares tool support per configured model only after an explicit choice and consent", async () => {
  const file = memoryFile()
  const other = { providerID: "other", id: "x" }
  const empty = fakeView()
  await toolSupportAction(empty.view, file, [], [])
  expect(empty.alerts).toEqual([
    { title: "Tool support", message: "No models configured yet — open Models to add some." },
  ])
  const listed = fakeView()
  await toolSupportAction(
    listed.view,
    file,
    [ref, { ...ref, variant: "high" }, other, { providerID: "q", id: "n" }],
    [
      { ...ref, tools: true },
      { ...other, tools: false },
    ],
  )
  expect(listed.selects[0]?.options).toEqual([
    { title: "p/m", value: ref, description: "calls tools" },
    { title: "other/x", value: other, description: "no tool calls" },
    {
      title: "q/n",
      value: { providerID: "q", id: "n" },
      description: "not declared · skipped on tool turns",
    },
  ])
  for (const [choices, confirms] of [
    [[0, undefined], []],
    [[0, 0], [false]],
  ] satisfies [(number | undefined)[], boolean[]][]) {
    await toolSupportAction(fakeView(choices, confirms).view, file, [ref], [])
    expect(file.value()).toBeUndefined()
  }
  await toolSupportAction(fakeView([0, 0], [true]).view, file, [ref], [])
  await toolSupportAction(fakeView([0, 1], [true]).view, file, [other], [])
  const saved = fakeView([0, 1], [true])
  await toolSupportAction(saved.view, file, [ref], [])
  expect(saved.toasts).toEqual([{ message: "Tool capability saved", variant: "success" }])
  expect(file.value()).toEqual({
    models: [
      { providerID: "other", id: "x", tools: false },
      { ...ref, tools: false },
    ],
  })
  await expect(
    toolSupportAction(fakeView([0, 0], [true]).view, memoryFile({ newer: true }), [ref], []),
  ).rejects.toThrow("capabilities")
})

it("resets the actual inherited health blockers", async () => {
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
  await resetResourceHealth(file, ref)
  expect((await readSharedHealth(file)).map((record) => record.key)).toEqual([
    { providerID: "other", modelID: "x" },
  ])
  expect(parseSharedHealth(undefined)).toEqual([])
  expect(() => parseSharedHealth({ version: 2, records: [] })).toThrow("Adaptive health")
})
