// @vitest-environment jsdom
// covers: ["ADP-033", "ADP-054"]
// The chip's slot render callback is a JSX closure: it runs on the host's
// terminal renderer, which cannot start headless. The renderable shapes are
// mounted here through solid-dom (the same pattern gui.test.ts uses); the
// accent-colored span variant cannot execute even there (jsdom mangles the
// intrinsic <text><span> template), so its color decision is pinned by the
// chipFor tests in test/tui.test.ts and the compiled runtime by the
// dist-content test.
import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"

import tuiPlugin from "../../../src/tui.js"
import { fakeTuiContext } from "../../tui/fake-context.js"
import { settingsJSON } from "../../supervisor/helpers.js"

type ChipMount = HTMLElement & { dispose: () => void }

/** One configured model: keeps the mode chip (the setup hint needs empty tiers). */
function configuredStatus(): unknown {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [{ ref: { providerID: "prov", id: "a" } }], advanced: [] },
    parked: 0,
    waiting: [],
    receipts: 0,
  }
}

function mountSlot(slot: { render: (input?: unknown) => unknown }, input?: unknown): ChipMount {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => slot.render(input) as Node, container)
  return Object.assign(container, { dispose })
}

describe("the footer status chip render", () => {
  it("renders the observe chip without an accent color", async () => {
    const { context, slots } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      status: configuredStatus(),
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const slot = slots[0]
    if (slot === undefined) throw new Error("no slot was claimed")
    const container = mountSlot(slot)
    await Promise.resolve()
    expect(container.textContent).toBe("Adaptive · observe")
    expect(container.querySelector("span")).toBeNull()
    container.dispose()
  })

  it("keeps the chip hidden when the settings payload carries an unknown mode", async () => {
    const { context, slots } = fakeTuiContext({
      settings: { ...settingsJSON("observe"), mode: "bogus" },
      clientPatches: [],
      status: configuredStatus(),
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const slot = slots[0]
    if (slot === undefined) throw new Error("no slot was claimed")
    const container = mountSlot(slot)
    await Promise.resolve()
    // An unparseable mode must not crash the boot fetch nor render a chip.
    expect(container.textContent).toBe("")
    container.dispose()
  })

  it("renders nothing while the boot fetch keeps failing and caps its retries", async () => {
    vi.useFakeTimers()
    try {
      const { context, slots, counts } = fakeTuiContext({
        settings: settingsJSON("observe"),
        clientPatches: [],
        failSettingsGet: true,
      })
      await tuiPlugin.setup(context)
      // Drive the bounded boot retry (2s apart, five retries) with fake
      // timers: after the cap the chip stays hidden until the next
      // settings-changed event refreshes it.
      for (let tick = 0; tick < 12; tick++) {
        await vi.advanceTimersByTimeAsync(2_000)
      }
      expect(counts.settingsGets).toBe(6)
      const slot = slots[0]
      if (slot === undefined) throw new Error("no slot was claimed")
      const container = mountSlot(slot)
      await Promise.resolve()
      expect(container.textContent).toBe("")
      container.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("the prompt chip's session mode (ADP-054)", () => {
  const PROMPT_INPUT = { sessionID: "ses_1", mode: "normal", showDetails: false }

  /**
   * The session chip is asserted through direct render calls, not mounts:
   * every non-observe chip shape carries the accent span that jsdom cannot
   * even construct (see the file header), so only the neutral observe shape
   * is renderable here. The fetch/cache behavior is pinned through the rpc
   * call counts instead.
   */
  function renderSessionChip(slot: { render: (input?: unknown) => unknown }): Element {
    const node = slot.render(PROMPT_INPUT)
    if (!(node instanceof Element)) throw new Error("the slot did not render a node")
    return node
  }

  it("fetches the session's override on the first render and caches it", async () => {
    const { context, slots, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      sessionMode: "observe",
      status: configuredStatus(),
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const slot = slots[1]
    if (slot === undefined) throw new Error("no prompt slot was claimed")
    expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    expect(counts.sessionModeGets).toBe(1)
    // The second render hits the cache: no second fetch.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    expect(counts.sessionModeGets).toBe(1)
  })

  it("falls back to the global mode when the override fetch fails", async () => {
    const { context, slots, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      failSessionModeGet: true,
      status: configuredStatus(),
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const slot = slots[1]
    if (slot === undefined) throw new Error("no prompt slot was claimed")
    expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    // The failed fetch cached "follow global": no retry loop per render.
    expect(counts.sessionModeGets).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    expect(counts.sessionModeGets).toBe(1)
  })

  it("shows the global mode for a session without an override", async () => {
    const { context, slots, counts } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      sessionMode: null,
      status: configuredStatus(),
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const slot = slots[1]
    if (slot === undefined) throw new Error("no prompt slot was claimed")
    expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    expect(counts.sessionModeGets).toBe(1)
  })

  it("renders nothing while the global mode itself is unknown", async () => {
    vi.useFakeTimers()
    try {
      const { context, slots } = fakeTuiContext({
        settings: settingsJSON("observe"),
        clientPatches: [],
        failSettingsGet: true,
        sessionMode: "observe",
        // A configured tier: this test is about the cached override, not the setup hint.
        status: configuredStatus(),
      })
      await tuiPlugin.setup(context)
      for (let tick = 0; tick < 12; tick++) {
        await vi.advanceTimersByTimeAsync(2_000)
      }
      const slot = slots[1]
      if (slot === undefined) throw new Error("no prompt slot was claimed")
      // First render: the override fetch is still in flight and the global
      // mode is unknown — nothing to show.
      expect(renderSessionChip(slot).textContent).toBe("")
      await vi.advanceTimersByTimeAsync(0)
      // Once the override is cached, the chip shows it even though the
      // global mode stayed unknown.
      expect(renderSessionChip(slot).textContent).toBe("Adaptive · observe")
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders the status table dialog as one text node per line", async () => {
    const status = {
      mode: "observe",
      pin: null,
      tiers: {
        quick: [],
        standard: [
          {
            ref: { providerID: "prov", id: "m1" },
            health: "healthy",
            breaker: "closed",
            windowed: false,
            windowUntil: null,
          },
        ],
        advanced: [],
      },
      parked: 0,
      receipts: 0,
    }
    const { context, dialogs, layers } = fakeTuiContext({
      settings: {
        ...settingsJSON("observe"),
        tiers: { quick: [], standard: [{ providerID: "prov", id: "m1" }], advanced: [] },
      },
      clientPatches: [],
      status,
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Drive the status flow far enough to open the custom table dialog:
    // the invitation's follow-up select takes the first queued pick (true =
    // "Open the menu now"), then the main menu opens the status view.
    dialogs.selectQueue.push(true, "status")
    ;(layers[0] as { commands: { run: () => void }[] }).commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shown = dialogs.shows.at(-1)
    if (shown === undefined) throw new Error("the status table dialog never opened")
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(() => shown.render() as Node, container)
    await Promise.resolve()
    // jsdom collapses the opentui intrinsic tree (the same parser mangling
    // the chip's span test hits), so the assertion is on the text content:
    // the title line plus the aligned rows from statusTable (whose column
    // layout the statusTable unit tests pin).
    const text = container.textContent
    expect(text).toContain("Status")
    expect(text).toContain("MODEL")
    // The esc hint sits in the title row's right corner.
    expect(text).toContain("esc")
    // Closing the dialog (Escape on the host side) resolves the view's
    // promise through the onClose handoff.
    shown.onClose?.()
    dispose()
    // The default dialog column is too narrow for the column grid — the
    // table dialog is widened to xlarge right after it opens.
    expect(dialogs.sets).toEqual([{ size: "xlarge" }])
  })

  it("wires the receipts footer actions through the host select dialog", async () => {
    const receipts = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      at: 1_000,
      sessionID: `s${String(index)}`,
      decision: { kind: "defer", reason: "routing-defer" },
    }))
    const { context, dialogs, layers } = fakeTuiContext({
      settings: settingsJSON("observe"),
      clientPatches: [],
      receipts,
    })
    await tuiPlugin.setup(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Open the receipts browser: invitation follow-up (true = open the menu)
    // then the receipts entry. The paged select stays pending like the real
    // host's; the test flips pages through the recorded footer actions.
    dialogs.selectQueue.push(true, "receipts")
    ;(layers[0] as { commands: { run: () => void }[] }).commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const paged = dialogs.selects.at(-1)
    if (paged?.actions?.length === undefined) {
      throw new Error("the paged receipts select never opened")
    }
    // The option list carries ONLY receipt lines (20 of 25); paging is a
    // footer action, not a list entry.
    expect(paged.title).toBe("Receipts (25, newest first)")
    expect(paged.values).toHaveLength(20)
    expect(paged.actions.map((action) => action.title)).toEqual(["Next page"])
    // Triggering the footer action clears the host dialog and flips to the
    // next page.
    paged.actions[0]?.onTrigger()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.clears).toBe(1)
    const page2 = dialogs.selects.at(-1)
    if (page2?.actions?.length === undefined) {
      throw new Error("page two never opened")
    }
    expect(page2.values).toHaveLength(5)
    expect(page2.actions.map((action) => action.title)).toEqual(["Previous page"])
    page2.actions[0]?.onTrigger()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialogs.clears).toBe(2)
    // Back on page one: full list and the "Next page" action again.
    expect(dialogs.selects.at(-1)?.values).toHaveLength(20)
    expect(dialogs.selects.at(-1)?.actions?.map((action) => action.title)).toEqual(["Next page"])
    // End the browser loop: the queued pick (undefined) leaves it, and the
    // menu loop exits on its own empty queue.
    dialogs.pagedResolvers.at(-1)?.(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
