import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { mainMenuOptions, modeOptions, MAIN_MENU_ITEMS } from "../../../src/ui/tui/menu.js"
import { OPERATING_MODES } from "../../../src/core/scheduler/types.js"
import type { OperatingMode } from "../../../src/core/scheduler/types.js"

describe("main menu", () => {
  it("pins the menu items and returns one option per item", () => {
    expect([...MAIN_MENU_ITEMS]).toEqual(["status", "mode", "tiers", "pin", "receipts"])
    const options = mainMenuOptions()
    expect(options.map((o) => o.value)).toEqual([...MAIN_MENU_ITEMS])
    for (const option of options) {
      expect(typeof option.title).toBe("string")
      expect(option.title.length).toBeGreaterThan(0)
      expect(typeof option.description).toBe("string")
    }
  })

  it("marks the current operating mode and describes each mode", () => {
    const observe = modeOptions("observe")
    expect(observe.map((o) => o.value)).toEqual([...OPERATING_MODES])
    const current = observe.find((o) => o.value === "observe")
    expect(current?.title).toContain("(current)")
    const control = modeOptions("control").find((o) => o.value === "control")
    expect(control?.title).toContain("(current)")
    expect(modeOptions("off").find((o) => o.value === "observe")?.title).not.toContain("(current)")
  })

  it("is deterministic", () => {
    expect(mainMenuOptions()).toEqual(mainMenuOptions())
    expect(modeOptions("off")).toEqual(modeOptions("off"))
  })

  it("covers every operating mode", () => {
    fc.assert(
      fc.property(fc.constantFrom(...OPERATING_MODES), (mode: OperatingMode) => {
        expect(modeOptions(mode)).toHaveLength(OPERATING_MODES.length)
      }),
      { numRuns: 20 },
    )
  })
})
