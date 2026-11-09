// covers: ["ADP-020", "ADP-056", "ADP-059"]
import { expect, it } from "vitest"
import { dispatchCapacity } from "../src/host/dispatch-capacity.js"
import { readCapacity } from "../src/capacity.js"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import { memoryFile } from "./memory-file.js"

it("attributes response headers only to an unambiguous dispatched physical provider", async () => {
  const shared = { file: memoryFile(), clock: () => 1_000 }
  const dispatch = dispatchCapacity(shared)
  const headers = {
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "60",
  }
  await dispatch.response(headers)
  expect(shared.file.value()).toBeUndefined()
  dispatch.selected("physical-codex")
  await dispatch.response(headers)
  const ref = { providerID: "physical-codex", id: "model" }
  expect((await readCapacity(shared, [ref])).capacity[schedulerHealthKey(ref)]).toMatchObject({
    exhausted: true,
  })
  dispatch.clear()
  dispatch.selected("first")
  dispatch.selected("overlapping")
  await dispatch.response(headers)
  expect(
    (await readCapacity(shared, [{ providerID: "overlapping", id: "model" }])).capacity,
  ).toEqual({})
  dispatch.clear()
  await dispatch.response(headers)
})
