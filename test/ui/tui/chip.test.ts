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
})
