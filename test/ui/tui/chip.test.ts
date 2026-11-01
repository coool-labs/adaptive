// @vitest-environment jsdom
// covers: ["ADP-033"]
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

function mountSlot(slot: { render: () => unknown }): ChipMount {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => slot.render() as Node, container)
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
