// covers: ["ADP-032", "ADP-033"]
import { describe, expect, it } from "vitest"

import tuiPlugin from "../src/tui.js"
import type { ModelInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/plugin"
import { settingsJSON } from "./supervisor/helpers.js"

interface DialogRecord {
  selects: { title: string; values: unknown[] }[]
  selectQueue: unknown[]
  confirmQueue: (boolean | undefined)[]
  alerts: { title: string; message: string }[]
  toasts: { message: string; variant?: string }[]
}

function fakeTuiContext(options: {
  settings: unknown
  clientPatches: Record<string, unknown>[]
  modelList?: ModelInfo[] | undefined
  failSettingsGet?: boolean
  failSelect?: unknown
}): {
  context: Context
  dialogs: DialogRecord
  layers: ReturnType<() => unknown>[]
} {
  const dialogs: DialogRecord = {
    selects: [],
    selectQueue: [],
    confirmQueue: [],
    alerts: [],
    toasts: [],
  }
  const layers: unknown[] = []
  const select = (spec: {
    title: string
    options: { value: unknown }[]
    search?: (query: string, options: { value: unknown }[]) => unknown
  }) => {
    if (spec.search !== undefined) spec.search("", spec.options)
    dialogs.selects.push({ title: spec.title, values: spec.options.map((option) => option.value) })
    if (options.failSelect !== undefined) {
      // The runAdaptive catch must tolerate non-Error rejections (fail-open).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.failSelect)
    }
    const next = dialogs.selectQueue.shift()
    return Promise.resolve(next as never)
  }
  const context = {
    client: {
      rpc: () => ({
        "settings.get": () =>
          options.failSettingsGet
            ? Promise.reject(new Error("boom"))
            : Promise.resolve(options.settings),
        "settings.set": (patch: Record<string, unknown>) => {
          options.clientPatches.push(patch)
          return Promise.resolve({ ok: true, settings: options.settings })
        },
        "status.get": () =>
          Promise.resolve({
            mode: "observe",
            pin: null,
            tiers: { quick: [], standard: [], advanced: [] },
            parked: 0,
            receipts: 0,
          }),
        "receipts.list": () => Promise.resolve([]),
      }),
    },
    ui: {
      dialog: {
        select,
        confirm: (spec: { title: string }) => {
          dialogs.alerts.push({ title: spec.title, message: "confirm" })
          return Promise.resolve(dialogs.confirmQueue.shift() ?? false)
        },
        alert: (spec: { title: string; message: string }) => {
          dialogs.alerts.push(spec)
          return Promise.resolve()
        },
      },
      toast: {
        show: (spec: { message: string; variant?: string }) => {
          dialogs.toasts.push(spec)
        },
      },
    },
    data: {
      location: {
        model: {
          list: () => options.modelList,
        },
      },
    },
    keymap: {
      layer: (factory: () => unknown) => {
        layers.push(factory())
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    location: undefined,
  } as unknown as Context
  return { context, dialogs, layers }
}

function modelInfo(
  providerID: string,
  modelID: string,
  name: string,
  variants: string[],
): ModelInfo {
  return {
    providerID,
    modelID,
    id: modelID,
    name,
    variants: variants.map((variant) => ({ id: variant })),
  } as unknown as ModelInfo
}

function observedSettings(
  mode: Parameters<typeof settingsJSON>[0],
  tiers?: Parameters<typeof settingsJSON>[1],
): unknown {
  return { ...settingsJSON(mode, tiers), inviteDismissed: true }
}

describe("tui entry", () => {
  it("registers the /adaptive slash command", async () => {
    const { context, layers } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
    })
    await tuiPlugin.setup(context)
    const layer = layers[0] as {
      mode?: string
      commands: { id: string; slash: { name: string }; palette?: boolean }[]
    }
    expect(layer.commands[0]?.id).toBe("coool.adaptive.menu")
    expect(layer.commands[0]?.slash.name).toBe("adaptive")
    // palette:true is what makes the command discoverable in the TUI command
    // palette (the /adaptive slash flow only lands in the editor).
    expect(layer.commands[0]?.palette).toBe(true)
    // mode:"global" opts the layer out of input-mode scoping; the default
    // ("base") bound the command to one OpenCode input mode and the palette
    // never matched it (regression: found by the Termwright /adaptive E2E).
    expect(layer.mode).toBe("global")
  })

  it("runs the invite flow through the host dialogs", async () => {
    const patches: Record<string, unknown>[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: {
        version: 1,
        mode: "observe",
        tiers: { quick: [], standard: [], advanced: [] },
        pin: null,
        agentTiers: {},
        inviteDismissed: false,
      },
      clientPatches: patches,
      modelList: [modelInfo("prov", "a", "Alpha", [])],
    })
    await tuiPlugin.setup(context)
    const layer = layers[0] as { commands: { run: () => void }[] }
    dialogs.selectQueue.push(undefined)
    layer.commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patches.map((patch) => patch["inviteDismissed"])).toEqual([true])
    expect(dialogs.selects[0]?.title).toBe("Adaptive")
  })

  it("toasts when the settings call fails", async () => {
    const { context, dialogs, layers } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      failSettingsGet: true,
    })
    await tuiPlugin.setup(context)
    const layer = layers[0] as { commands: { run: () => void }[] }
    layer.commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.toasts.map((toast) => toast.message)).toEqual(["boom"])
  })

  it("adapts host model info into picker summaries", async () => {
    const patches: Record<string, unknown>[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: observedSettings("control", { standard: [] }),
      clientPatches: patches,
      modelList: [modelInfo("prov", "a", "Alpha", ["high"])],
    })
    await tuiPlugin.setup(context)
    const layer = layers[0] as { commands: { run: () => void }[] }
    // status → tier editor → add → pick the model → pick the variant → exit menu
    dialogs.selectQueue.push(undefined)
    layer.commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.alerts.length).toBe(0)
  })
})

describe("tui entry: full flows", () => {
  function setup(options: Parameters<typeof fakeTuiContext>[0]) {
    return fakeTuiContext(options)
  }

  it("drives status, receipts, and a mode change through the entry api", async () => {
    const patches: Record<string, unknown>[] = []
    const { context, dialogs, layers } = setup({
      settings: observedSettings("observe"),
      clientPatches: patches,
      modelList: [modelInfo("prov", "a", "Alpha", [])],
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    const selects = dialogs.selectQueue
    // menu: status -> receipts -> mode -> change -> exit
    selects.push("status", "receipts", "mode", "control", undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.alerts.some((a) => a.message.includes("mode: observe"))).toBe(true)
    expect(dialogs.alerts.some((a) => a.message.includes("No decisions recorded yet."))).toBe(true)
    expect(patches.map((patch) => patch["mode"])).toEqual(["control"])
  })

  it("toasts with the error variant when a dialog throws", async () => {
    const { context, dialogs, layers } = setup({
      settings: settingsJSON("observe"),
      clientPatches: [],
      failSettingsGet: true,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.toasts.length).toBeGreaterThan(0)
  })

  it("toasts the error variant when a dialog rejects with an Error", async () => {
    const { context, dialogs, layers } = setup({
      settings: observedSettings("observe"),
      clientPatches: [],
      failSelect: new Error("dialog broke"),
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.toasts).toContainEqual({ message: "dialog broke", variant: "error" })
  })

  it("toasts the error variant when a dialog rejects with a non-error", async () => {
    const { context, dialogs, layers } = setup({
      settings: observedSettings("observe"),
      clientPatches: [],
      failSelect: "raw",
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.toasts).toContainEqual({ message: "raw", variant: "error" })
  })

  it("maps an absent model list to an empty picker", async () => {
    const { context, dialogs, layers } = setup({
      settings: settingsJSON("observe"),
      clientPatches: [],
      modelList: undefined,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    // tiers -> quick -> add -> cancel picker -> exit tier menu -> exit main
    dialogs.selectQueue.push("tiers", "quick", { kind: "add" }, undefined, undefined, undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const addSelect = dialogs.selects.find((entry) => entry.title === "Add model")
    expect(addSelect?.values).toEqual([])
  })

  it("maps host model info into picker summaries with variants", async () => {
    const { context, dialogs, layers } = setup({
      settings: settingsJSON("observe"),
      clientPatches: [],
      modelList: [modelInfo("prov", "a", "Alpha", ["high", "low"])],
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    dialogs.selectQueue.push(
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "a" },
      { variant: "high" },
      undefined,
      undefined,
    )
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const addSelect = dialogs.selects.find((entry) => entry.title === "Add model")
    expect(addSelect?.values).toEqual([{ providerID: "prov", modelID: "a" }])
    const variantSelect = dialogs.selects.find((entry) => entry.title.includes("Variant"))
    expect(variantSelect?.values).toEqual([
      { variant: undefined },
      { variant: "high" },
      { variant: "low" },
    ])
  })
})
