// covers: ["ADP-028", "ADP-036", "ADP-051"]
import { afterEach, describe, expect, it, vi } from "vitest"
import { adaptiveRpcHandlers, type AdaptiveRpcSource } from "../../src/rpc/handlers.js"
import type { PatchResult, SettingsPatch } from "../../src/state/settings/types.js"
import type { SettingsV1 } from "../../src/state/settings/index.js"
import { defaultSettings } from "../../src/state/settings/index.js"
import type { Receipt } from "../../src/state/receipts/types.js"
import type { StatusSnapshot } from "../../src/rpc/status.js"

function source(overrides: Partial<AdaptiveRpcSource> = {}): AdaptiveRpcSource {
  return {
    settings: () => Promise.resolve(defaultSettings()),
    updateSettings: (patch: SettingsPatch) =>
      Promise.resolve({
        ok: true,
        settings: {
          ...defaultSettings(),
          mode: (patch as { mode?: SettingsV1["mode"] }).mode ?? defaultSettings().mode,
        },
      }),
    status: () =>
      Promise.resolve({
        mode: "observe",
        pin: null,
        tiers: { quick: [], standard: [], advanced: [] },
        parked: 0,
        receipts: 0,
      }),
    receipts: () => Promise.resolve([]),
    ...overrides,
  }
}

function receipt(): Receipt {
  return {
    id: 1,
    at: 100,
    sessionID: "s1",
    decision: { kind: "defer", reason: "routing-defer" },
  }
}

describe("adaptiveRpcHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("settings.get delegates to the source", async () => {
    const spy = vi.fn(() => Promise.resolve(defaultSettings()))
    const handlers = adaptiveRpcHandlers(source({ settings: spy }))
    await expect(handlers["settings.get"](undefined)).resolves.toEqual(defaultSettings())
    expect(spy).toHaveBeenCalledOnce()
  })

  it("status.get and receipts.list delegate to the source", async () => {
    const receipts = [receipt()]
    const status: StatusSnapshot = {
      mode: "control",
      pin: null,
      tiers: { quick: [], standard: [], advanced: [] },
      parked: 1,
      receipts: 1,
    }
    const handlers = adaptiveRpcHandlers(
      source({
        status: () => Promise.resolve(status),
        receipts: () => Promise.resolve(receipts),
      }),
    )
    await expect(handlers["status.get"](undefined)).resolves.toBe(status)
    await expect(handlers["receipts.list"](undefined)).resolves.toBe(receipts)
  })

  it("settings.set returns the patch result and emits settings-changed on success", async () => {
    const emit = vi.fn(() => Promise.resolve())
    const result: PatchResult = { ok: true, settings: { ...defaultSettings(), mode: "off" } }
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.resolve(result) }),
      emit,
    )
    await expect(handlers["settings.set"]({ mode: "off" })).resolves.toBe(result)
    expect(emit).toHaveBeenCalledWith("settings-changed", { version: result.settings.version })
  })

  it("does not emit when the patch is invalid", async () => {
    const emit = vi.fn()
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.resolve({ ok: false, errors: ["invalid mode"] }) }),
      emit,
    )
    await expect(handlers["settings.set"]({ mode: "bogus" as "off" })).resolves.toEqual({
      ok: false,
      errors: ["invalid mode"],
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it("degrades an internal failure to an error patch result", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.reject(new Error("boom")) }),
      undefined,
    )
    await expect(handlers["settings.set"]({})).resolves.toEqual({
      ok: false,
      errors: ["internal error"],
    })
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-set")
  })

  it("logs emit failures without losing the patch result", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const result: PatchResult = { ok: true, settings: defaultSettings() }
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.resolve(result) }),
      () => Promise.reject(new Error("emit boom")),
    )
    await expect(handlers["settings.set"]({})).resolves.toBe(result)
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-emit")
  })

  it("matches the rpc definition method names (handler-binding contract)", () => {
    const handlers = adaptiveRpcHandlers(source())
    expect(Object.keys(handlers).sort()).toEqual([
      "receipts.list",
      "settings.get",
      "settings.set",
      "status.get",
    ])
  })
})
