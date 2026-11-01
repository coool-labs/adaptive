// covers: ["ADP-033", "ADP-054"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  statusSummary,
  mainMenuOptions,
  modeOptions,
  sessionModeOptions,
  MAIN_MENU_ITEMS,
  modelsSummary,
} from "../../../src/ui/tui/menu.js"
import { OPERATING_MODES } from "../../../src/core/scheduler/types.js"
import type { OperatingMode } from "../../../src/core/scheduler/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc/status.js"
import type { SettingsV1 } from "../../../src/state/settings/index.js"

function emptyStatus(): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    receipts: 0,
  }
}

function emptySettings(): SettingsV1 {
  return {
    version: 1,
    mode: "observe",
    tiers: { quick: [], standard: [], advanced: [] },
    pin: null,
    agentTiers: {},
    inviteDismissed: false,
  }
}

describe("main menu", () => {
  it("pins the menu items and puts status first", () => {
    expect([...MAIN_MENU_ITEMS]).toEqual(["status", "models", "mode", "pin", "receipts"])
    const options = mainMenuOptions(emptySettings(), emptyStatus())
    expect(options.map((o) => o.title)).toEqual(["Status", "Models", "Mode", "Pin", "Receipts"])
    for (const option of options) {
      expect(typeof option.description).toBe("string")
      expect(option.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it("summarizes health counts and windowed pressure from the snapshot", () => {
    const busy: TierResourceStatus = {
      ref: { providerID: "p", id: "m" },
      health: "rate_limited",
      breaker: "closed",
      windowed: true,
      windowUntil: 0,
    }
    expect(statusSummary(undefined)).toBe("how every configured model is doing")
    expect(statusSummary(emptyStatus())).toBe("no models configured yet")
    expect(
      statusSummary({ ...emptyStatus(), tiers: { quick: [busy], standard: [], advanced: [busy] } }),
    ).toBe("2 resources · 2 windowed")
    // A healthy inventory omits the windowed note entirely.
    const healthy: TierResourceStatus = { ...busy, windowed: false, health: "healthy" }
    expect(
      statusSummary({ ...emptyStatus(), tiers: { quick: [healthy], standard: [], advanced: [] } }),
    ).toBe("1 resource")
  })

  it("summarizes the configured model lists", () => {
    expect(modelsSummary(emptySettings())).toBe("quick: 0 · standard: 0 · advanced: 0")
    expect(
      modelsSummary({
        ...emptySettings(),
        tiers: {
          quick: [{ providerID: "p", id: "a" }],
          standard: [],
          advanced: [
            { providerID: "p", id: "b" },
            { providerID: "p", id: "c" },
          ],
        },
      }),
    ).toBe("quick: 1 · standard: 0 · advanced: 2")
  })

  it("describes mode and pin from current settings", () => {
    const options = mainMenuOptions(
      { ...emptySettings(), mode: "active", pin: { providerID: "p", id: "m" } },
      emptyStatus(),
    )
    expect(options.find((o) => o.value === "mode")?.description).toBe("currently active")
    expect(options.find((o) => o.value === "pin")?.description).toBe("pinned to p/m")
  })

  it("marks the current operating mode and describes each mode", () => {
    const observe = modeOptions("observe")
    expect(observe.map((o) => o.value)).toEqual([...OPERATING_MODES])
    const current = observe.find((o) => o.value === "observe")
    expect(current?.title).toContain("(current)")
    const active = modeOptions("active").find((o) => o.value === "active")
    expect(active?.title).toContain("(current)")
    expect(modeOptions("off").find((o) => o.value === "observe")?.title).not.toContain("(current)")
  })

  it("is deterministic", () => {
    expect(mainMenuOptions(emptySettings(), emptyStatus())).toEqual(
      mainMenuOptions(emptySettings(), emptyStatus()),
    )
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

describe("session mode menu (ADP-054)", () => {
  it("offers Follow global first, then every mode in order", () => {
    const options = sessionModeOptions({ global: "observe", override: null, effective: "observe" })
    expect(options.map((o) => o.value)).toEqual([
      { kind: "global" },
      { kind: "mode", mode: "off" },
      { kind: "mode", mode: "observe" },
      { kind: "mode", mode: "active" },
    ])
    expect(options[0]?.title).toBe("Follow global (observe)")
    expect(options[0]?.description).toBe("clear this session's override")
  })

  it("marks the override distinctly from the current effective mode", () => {
    const find = (options: ReturnType<typeof sessionModeOptions>, mode: OperatingMode) =>
      options.find((o) => o.value.kind === "mode" && o.value.mode === mode)
    const overridden = sessionModeOptions({
      global: "observe",
      override: "active",
      effective: "active",
    })
    expect(find(overridden, "active")?.title).toBe("active (override)")
    expect(find(overridden, "observe")?.title).toBe("observe")
    // With no override, the inherited global mode carries the current marker.
    const inherited = sessionModeOptions({
      global: "observe",
      override: null,
      effective: "observe",
    })
    expect(find(inherited, "observe")?.title).toBe("observe (current)")
    expect(find(inherited, "active")?.title).toBe("active")
  })

  it("describes each mode like the global menu does", () => {
    const options = sessionModeOptions({ global: "off", override: null, effective: "off" })
    const global = modeOptions("off")
    for (const option of options) {
      if (option.value.kind !== "mode") continue
      const modeIndex = OPERATING_MODES.indexOf(option.value.mode)
      expect(option.description).toBe(global[modeIndex]?.description)
    }
  })
})
