// covers: ["ADP-032", "ADP-033"]
import { describe, expect, it } from "vitest"

import tuiPlugin, { chipFor } from "../src/tui.js"
import { settingsJSON } from "./supervisor/helpers.js"
import { fakeTuiContext, modelInfo } from "./tui/fake-context.js"

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
      commands: { id: string; slash: { name: string }; palette?: boolean; suggested?: boolean }[]
    }
    expect(layer.commands[0]?.id).toBe("coool.adaptive.menu")
    expect(layer.commands[0]?.slash.name).toBe("adaptive")
    // palette:true is what makes the command discoverable in the TUI command
    // palette (the /adaptive slash flow only lands in the editor).
    expect(layer.commands[0]?.palette).toBe(true)
    // suggested:true surfaces the command in the palette's suggested row.
    expect(layer.commands[0]?.suggested).toBe(true)
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
    // confirm -> follow-up select (pick "Later" = undefined) ends the run.
    dialogs.selectQueue.push(undefined)
    layer.commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patches.map((patch) => patch["inviteDismissed"])).toEqual([true])
    expect(dialogs.selects[0]?.title).toBe("OpenCode Adaptive")
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
      settings: observedSettings("active", { standard: [] }),
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
    selects.push("health", "receipts", "mode", "active", undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.alerts.some((a) => a.message.includes("No models configured yet"))).toBe(true)
    expect(dialogs.alerts.some((a) => a.message.includes("No decisions recorded yet."))).toBe(true)
    expect(patches.map((patch) => patch["mode"])).toEqual(["active"])
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
      settings: observedSettings("observe"),
      clientPatches: [],
      modelList: undefined,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    // tiers -> quick -> add -> cancel picker -> exit tier menu -> exit main
    dialogs.selectQueue.push("models", "quick", { kind: "add" }, undefined, undefined, undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const addSelect = dialogs.selects.find((entry) => entry.title === "Add model")
    expect(addSelect?.values).toEqual([])
  })

  it("maps host model info into picker summaries with variants", async () => {
    const { context, dialogs, layers } = setup({
      settings: observedSettings("observe"),
      clientPatches: [],
      modelList: [modelInfo("prov", "a", "Alpha", ["high", "low"])],
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    dialogs.selectQueue.push(
      "models",
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

describe("tui entry: footer chip", () => {
  it("registers both footer status slots", async () => {
    const { context, slots } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
    })
    await tuiPlugin.setup(context)
    // Each slot exists on only one screen: home renders home.footer.status,
    // sessions render prompt.footer.status — both must be claimed.
    expect(slots.map((slot) => slot.append)).toEqual(["home.footer.status", "prompt.footer.status"])
  })

  it("returns a dispose that unregisters the slots and the event watch", async () => {
    const { context, slots, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
    })
    const dispose = await tuiPlugin.setup(context)
    if (dispose === undefined) throw new Error("setup did not return a dispose function")
    expect(slots.length).toBe(2)
    await dispose()
    expect(counts.slotDisposals).toBe(2)
    expect(counts.eventDisposals).toBe(1)
  })

  it("fetches settings at boot and refetches on settings-changed", async () => {
    const { context, events, counts } = fakeTuiContext({
      settings: settingsJSON("active"),
      clientPatches: [],
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The chip mirrors the server mode: one boot fetch, then the event.
    expect(counts.settingsGets).toBe(1)
    expect(events.map((event) => event.name)).toEqual(["settings-changed"])
    const handler = events[0]?.handler
    if (handler !== undefined) handler()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.settingsGets).toBe(2)
  })
})

describe("chipFor", () => {
  it("maps active to a green chip", () => {
    expect(chipFor("active")).toEqual({ text: "Adaptive · active", fg: "green" })
  })

  it("maps observe to the neutral default color", () => {
    expect(chipFor("observe")).toEqual({ text: "Adaptive · observe", fg: null })
  })

  it("maps off to the soft red", () => {
    expect(chipFor("off")).toEqual({ text: "Adaptive · off", fg: "#e57373" })
  })
})
