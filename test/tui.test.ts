// covers: ["ADP-032", "ADP-033", "ADP-054", "ADP-055"]
import { describe, expect, it } from "vitest"

import tuiPlugin, { chipFor } from "../src/tui.js"
import { settingsJSON } from "./supervisor/helpers.js"
import { fakeTuiContext, modelInfo } from "./tui/fake-context.js"
import type { OperatingMode } from "../src/core/scheduler/types.js"

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
    // menu: status -> receipts -> mode -> global target -> change -> exit
    selects.push("status", "receipts", "mode", "global", "active", undefined)
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

  it.each([new Error("receipt dialog broke"), "receipt dialog broke"])(
    "toasts and stops the receipts flow when the paged host dialog rejects with %s",
    async (failure) => {
      const patches: Record<string, unknown>[] = []
      const { context, dialogs, layers } = setup({
        settings: observedSettings("observe"),
        clientPatches: patches,
        failPagedSelect: failure,
        receipts: [
          {
            id: 1,
            at: 0,
            sessionID: "session",
            decision: { kind: "defer", reason: "routing-defer" },
          },
        ],
      })
      await tuiPlugin.setup(context)
      const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
      if (run === undefined) throw new Error("slash command was not registered")
      dialogs.selectQueue.push("receipts", "mode")
      run()
      // Drain the bounded async UI flow without real timers.
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
      expect(dialogs.toasts).toEqual([{ message: "receipt dialog broke", variant: "error" }])
      expect(dialogs.selects.map((select) => select.title)).toEqual([
        "Adaptive (observe)",
        "Receipts (1, newest first)",
      ])
      expect(dialogs.selectQueue).toEqual(["mode"])
      expect(patches).toEqual([])
    },
  )

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
      { providerID: "prov", modelID: "a", name: "Alpha", variants: ["high", "low"] },
      { variant: "high" },
      undefined,
      undefined,
    )
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const addSelect = dialogs.selects.find((entry) => entry.title === "Add model")
    expect(addSelect?.values).toEqual([
      { providerID: "prov", modelID: "a", name: "Alpha", variants: ["high", "low"] },
    ])
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
    expect(counts.eventDisposals).toBe(2)
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
    expect(events.map((event) => event.name)).toEqual(["settings-changed", "session-mode-changed"])
    const handler = events[0]?.handler
    if (handler !== undefined) handler({ data: { version: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.settingsGets).toBe(2)
  })

  it("refetches a session's override on the session-mode-changed event", async () => {
    const { context, events, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      route: { type: "session", sessionID: "ses_1" },
      sessionMode: "active",
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.sessionModeGets).toBe(0)
    const handler = events.find((event) => event.name === "session-mode-changed")?.handler
    if (handler === undefined) throw new Error("session-mode-changed watch was not registered")
    handler({ data: { sessionID: "ses_1" } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.sessionModeGets).toBe(1)
    // A malformed payload is ignored (fail-open) instead of steering a bogus
    // session.
    handler({ data: { sessionID: 7 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.sessionModeGets).toBe(1)
  })

  it("refetches cached overrides when the global settings change", async () => {
    const { context, events, slots, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      sessionMode: "active",
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A chip render for the session warms the override cache.
    const slot = slots[1]
    if (slot === undefined) throw new Error("no prompt slot was claimed")
    const node = slot.render({ sessionID: "ses_1", mode: "normal", showDetails: false })
    if (!(node instanceof Element)) throw new Error("the slot did not render a node")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(counts.sessionModeGets).toBe(1)
    const handler = events.find((event) => event.name === "settings-changed")?.handler
    if (handler === undefined) throw new Error("settings-changed watch was not registered")
    handler({ data: { version: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The cached override is refreshed so a stale mirror cannot stick.
    expect(counts.sessionModeGets).toBe(2)
  })
})

describe("tui entry: session-scoped flows (ADP-054)", () => {
  it("passes the open session into the flows and steers its override", async () => {
    const patches: Record<string, unknown>[] = []
    const sessionPatches: { sessionID: string; mode: OperatingMode | null }[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: observedSettings("observe"),
      clientPatches: patches,
      route: { type: "session", sessionID: "ses_1" },
      sessionMode: "active",
      sessionModePatches: sessionPatches,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    // The menu is titled after the session's EFFECTIVE mode (override active),
    // and the mode menu steers the session, not the global settings.
    dialogs.selectQueue.push("mode", "session", { kind: "mode", mode: "observe" }, undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.selects[0]?.title).toBe("Adaptive (active)")
    expect(sessionPatches).toEqual([{ sessionID: "ses_1", mode: "observe" }])
    expect(patches).toEqual([])
  })

  it("runs the global mode menu when the command is opened on home", async () => {
    const patches: Record<string, unknown>[] = []
    const sessionPatches: { sessionID: string; mode: OperatingMode | null }[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: observedSettings("observe"),
      clientPatches: patches,
      sessionModePatches: sessionPatches,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    dialogs.selectQueue.push("mode", "global", "active", undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(patches.map((patch) => patch["mode"])).toEqual(["active"])
    expect(sessionPatches).toEqual([])
  })

  it("passes the open session into the tier flow and pins its request (ADP-055)", async () => {
    const patches: Record<string, unknown>[] = []
    const tierPatches: { sessionID: string; tier: string | null }[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: observedSettings("observe"),
      clientPatches: patches,
      route: { type: "session", sessionID: "ses_1" },
      tierRequestPatches: tierPatches,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    // The tier menu steers the session's request, not the global settings.
    dialogs.selectQueue.push("tier", { kind: "tier", tier: "quick" }, undefined)
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tierPatches).toEqual([{ sessionID: "ses_1", tier: "quick" }])
    expect(patches).toEqual([])
  })

  it("carries the TUI location on every rpc call (project-local installs)", async () => {
    // Regression: rpc handlers resolve per location, so a location-less call
    // never reaches a project-local plugin's handlers ("RPC is unavailable").
    const location = { directory: "/work/project" }
    const rpcCalls: { method: string; options: unknown }[] = []
    const { context, dialogs, layers } = fakeTuiContext({
      settings: observedSettings("observe"),
      clientPatches: [],
      route: { type: "session", sessionID: "ses_1" },
      location,
      rpcCalls,
    })
    await tuiPlugin.setup(context)
    const run = (layers[0] as { commands: { run: () => void }[] }).commands[0]?.run
    if (run === undefined) throw new Error("slash command was not registered")
    dialogs.selectQueue.push(
      "status",
      "receipts",
      "mode",
      "session",
      { kind: "mode", mode: "active" },
      "tier",
      { kind: "tier", tier: "quick" },
      "mode",
      "global",
      "active",
      undefined,
    )
    run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(new Set(rpcCalls.map((call) => call.method))).toEqual(
      new Set([
        "settings.get",
        "settings.set",
        "status.get",
        "receipts.list",
        "session-mode.get",
        "session-mode.set",
        "tier-request.get",
        "tier-request.set",
      ]),
    )
    expect(
      rpcCalls.every((call) => JSON.stringify(call.options) === JSON.stringify({ location })),
    ).toBe(true)
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
