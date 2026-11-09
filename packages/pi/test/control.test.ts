// covers: ["ADP-028", "ADP-054", "ADP-055", "ADP-062"]
import { expect, it } from "vitest"
import { controlApi, type ControlOptions } from "../src/host/control.js"
import { memoryFile } from "./support/memory-file.js"
import { fakeApi } from "./support/api.js"
import type { BranchEntry } from "../src/task.js"

function setup() {
  const settings = memoryFile()
  const branch: BranchEntry[] = []
  let model: { provider: string; id: string } | undefined = { provider: "p", id: "m" }
  let manual: { providerID: string; id: string } | undefined = { providerID: "p", id: "m" }
  let idle = true
  let canSelect = true
  const selected: unknown[] = []
  const options: ControlOptions = {
    settings,
    receipts: memoryFile(),
    sessionID: "s",
    branch: () => branch,
    model: () => model,
    manualModel: () => manual,
    selectModel: (target) => {
      selected.push(target)
      if (canSelect) model = { provider: target.providerID, id: target.id }
      return Promise.resolve(canSelect)
    },
    append: (type, data) => branch.push({ type: "custom", customType: type, data }),
    idle: () => idle,
    status: fakeApi().api.status,
  }
  return {
    api: controlApi(options),
    options,
    branch,
    selected,
    setIdle: (value: boolean) => {
      idle = value
    },
    setManual: (value: typeof manual) => {
      manual = value
    },
    setModel: (value: typeof model) => {
      model = value
    },
    setCanSelect: (value: boolean) => {
      canSelect = value
    },
  }
}

it("binds settings, status and receipts, keeping manual observation as the default", async () => {
  const state = setup()
  expect((await state.api.settings()).mode).toBe("observe")
  expect(await state.api.sessionMode("s")).toBeNull()
  expect(await state.api.setSettings({ mode: "off" })).toMatchObject({ ok: true })
  expect((await state.api.status()).tiers).toEqual({ quick: [], standard: [], advanced: [] })
  expect(await state.api.receipts()).toEqual([])
  expect(await state.api.setSessionMode("s", "active")).toEqual({ ok: true })
  expect(state.selected).toEqual([{ providerID: "adaptive", id: "auto" }])
  expect(await state.api.sessionMode("s")).toBe("active")
  expect(await state.api.setSessionMode("s", "observe")).toEqual({ ok: true })
  expect(state.selected.at(-1)).toEqual({ providerID: "p", id: "m" })
  expect(await state.api.sessionMode("s")).toBe("observe")
  expect(await state.api.setSessionMode("s", null)).toEqual({ ok: true })
  expect(await state.api.sessionMode("s")).toBeNull()
  expect(await state.api.setSessionMode("s", "off")).toEqual({ ok: true })
})

it("rejects foreign sessions, busy switches, missing baselines and failed selections", async () => {
  const state = setup()
  await expect(state.api.sessionMode("other")).rejects.toThrow("sessionID")
  await expect(state.api.tierRequest("other")).rejects.toThrow("sessionID")
  expect(await state.api.setSessionMode("other", "active")).toMatchObject({ ok: false })
  expect(await state.api.setTierRequest("other", "quick")).toMatchObject({ ok: false })
  expect(await state.api.setTierRequest("s", "bad")).toMatchObject({ ok: false })
  state.setIdle(false)
  expect(await state.api.setSessionMode("s", "active")).toMatchObject({ ok: false })
  state.setIdle(true)
  state.setModel({ provider: "adaptive", id: "auto" })
  state.setManual(undefined)
  expect(await state.api.setSessionMode("s", "off")).toMatchObject({ ok: false })
  state.setCanSelect(false)
  expect(await state.api.setSessionMode("s", "active")).toMatchObject({ ok: false })
  state.setModel(undefined)
  expect(await state.api.setSessionMode("s", "observe")).toMatchObject({ ok: true })
  expect(state.branch).toHaveLength(1)
})

it("records nullable tier requests as branch metadata and follows the global mode on clear", async () => {
  const state = setup()
  expect(await state.api.tierRequest("s")).toBeNull()
  expect(await state.api.setTierRequest("s", "advanced")).toEqual({ ok: true })
  expect(await state.api.tierRequest("s")).toBe("advanced")
  expect(await state.api.setTierRequest("s", null)).toEqual({ ok: true })
  expect(await state.api.tierRequest("s")).toBeNull()
  await state.api.setSettings({ mode: "active" })
  expect(await state.api.setSessionMode("s", null)).toEqual({ ok: true })
  expect(state.selected.at(-1)).toEqual({ providerID: "adaptive", id: "auto" })
})
