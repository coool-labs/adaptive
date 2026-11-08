// covers: ["ADP-028", "ADP-036", "ADP-051", "ADP-054", "ADP-055"]
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
        waiting: [],
        receipts: 0,
      }),
    receipts: () => Promise.resolve([]),
    getSessionMode: () => Promise.resolve(null),
    setSessionMode: () => Promise.resolve(),
    getTierRequest: () => Promise.resolve(null),
    noteTierRequest: () => true,
    setTierRequest: () => Promise.resolve(),
    ...overrides,
  }
}

/**
 * A handler call context whose error factory returns the plain {type,message}
 * shape. The cast stands in for the branded HandlerError: the brand symbol is
 * not exported by @opencode/schema, so a test cannot construct the real one.
 */
type Handlers = ReturnType<typeof adaptiveRpcHandlers>
type SettingsGetContext = Parameters<Handlers["settings.get"]>[1]
function callContext(): SettingsGetContext {
  const error = ((type: string, message: string) => ({
    type,
    message,
  })) as unknown as SettingsGetContext["error"]
  return { error }
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
    await expect(handlers["settings.get"](undefined, callContext())).resolves.toEqual(
      defaultSettings(),
    )
    expect(spy).toHaveBeenCalledOnce()
  })

  it("declares a failed read through the context error factory, not a throw", async () => {
    // Regression: reads used to propagate the raw rejection, which the host
    // turns into a server defect with the generic rpc.internal message — the
    // real cause never reached the surface.
    const handlers = adaptiveRpcHandlers(
      source({ settings: () => Promise.reject(new Error("storage unavailable")) }),
    )
    await expect(handlers["settings.get"](undefined, callContext())).resolves.toEqual({
      type: "internal",
      message: "Error: storage unavailable",
    })
  })

  it("status.get and receipts.list delegate to the source", async () => {
    const receipts = [receipt()]
    const status: StatusSnapshot = {
      mode: "active",
      pin: null,
      tiers: { quick: [], standard: [], advanced: [] },
      parked: 1,
      waiting: [],
      receipts: 1,
    }
    const handlers = adaptiveRpcHandlers(
      source({
        status: () => Promise.resolve(status),
        receipts: () => Promise.resolve(receipts),
      }),
    )
    await expect(handlers["status.get"](undefined, callContext())).resolves.toBe(status)
    await expect(handlers["receipts.list"](undefined, callContext())).resolves.toBe(receipts)
  })

  it("declares a failed read through the context error factory", async () => {
    // Each read surface failing storage resolves the declared internal error
    // instead of throwing into the host (a plain throw becomes a generic
    // rpc.internal defect).
    const handlers = adaptiveRpcHandlers(
      source({
        status: () => Promise.reject(new Error("status unavailable")),
        receipts: () => Promise.reject(new Error("receipts unavailable")),
        getSessionMode: () => Promise.reject(new Error("modes unavailable")),
        getTierRequest: () => Promise.reject(new Error("tiers unavailable")),
      }),
    )
    await expect(handlers["status.get"](undefined, callContext())).resolves.toEqual({
      type: "internal",
      message: "Error: status unavailable",
    })
    await expect(handlers["receipts.list"](undefined, callContext())).resolves.toEqual({
      type: "internal",
      message: "Error: receipts unavailable",
    })
    await expect(
      handlers["session-mode.get"]({ sessionID: "ses_1" }, callContext()),
    ).resolves.toEqual({
      type: "internal",
      message: "Error: modes unavailable",
    })
    await expect(
      handlers["tier-request.get"]({ sessionID: "ses_1" }, callContext()),
    ).resolves.toEqual({
      type: "internal",
      message: "Error: tiers unavailable",
    })
  })

  it("settings.set returns the patch result and emits settings-changed on success", async () => {
    const emit = vi.fn(() => Promise.resolve())
    const result: PatchResult = { ok: true, settings: { ...defaultSettings(), mode: "off" } }
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.resolve(result) }),
      emit,
    )
    await expect(handlers["settings.set"]({ mode: "off" }, callContext())).resolves.toBe(result)
    expect(emit).toHaveBeenCalledWith("settings-changed", { version: result.settings.version })
  })

  it("does not emit when the patch is invalid", async () => {
    const emit = vi.fn()
    const handlers = adaptiveRpcHandlers(
      source({ updateSettings: () => Promise.resolve({ ok: false, errors: ["invalid mode"] }) }),
      emit,
    )
    await expect(
      handlers["settings.set"]({ mode: "bogus" as "off" }, callContext()),
    ).resolves.toEqual({
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
    await expect(handlers["settings.set"]({}, callContext())).resolves.toEqual({
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
    await expect(handlers["settings.set"]({}, callContext())).resolves.toBe(result)
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-emit")
  })

  it("succeeds without an emitter (emit is optional)", async () => {
    const set = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: set }))
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: "off" }, callContext()),
    ).resolves.toEqual({
      ok: true,
    })
    expect(set).toHaveBeenCalledOnce()
  })

  it("matches the rpc definition method names (handler-binding contract)", () => {
    const handlers = adaptiveRpcHandlers(source())
    expect(Object.keys(handlers).sort()).toEqual([
      "receipts.list",
      "session-mode.get",
      "session-mode.set",
      "settings.get",
      "settings.set",
      "status.get",
      "tier-request.get",
      "tier-request.set",
    ])
  })
})

describe("adaptiveRpcHandlers: session-mode (ADP-054)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("session-mode.get delegates to the source", async () => {
    const spy = vi.fn((sessionID: string) =>
      Promise.resolve(sessionID === "ses_1" ? ("active" as const) : null),
    )
    const handlers = adaptiveRpcHandlers(source({ getSessionMode: spy }))
    await expect(
      handlers["session-mode.get"]({ sessionID: "ses_1" }, callContext()),
    ).resolves.toEqual({
      mode: "active",
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toBe("ses_1")
  })

  it("session-mode.set persists and emits session-mode-changed on success", async () => {
    const set = vi.fn(() => Promise.resolve())
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: set }), emit)
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: "active" }, callContext()),
    ).resolves.toEqual({
      ok: true,
    })
    expect(set).toHaveBeenCalledWith("ses_1", "active")
    expect(emit).toHaveBeenCalledWith("session-mode-changed", { sessionID: "ses_1" })
  })

  it("clearing the override emits the change event too", async () => {
    const set = vi.fn(() => Promise.resolve())
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: set }), emit)
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: null }, callContext()),
    ).resolves.toEqual({
      ok: true,
    })
    expect(set).toHaveBeenCalledWith("ses_1", null)
    expect(emit).toHaveBeenCalledWith("session-mode-changed", { sessionID: "ses_1" })
  })

  it("rejects an out-of-bounds sessionID without calling the source", async () => {
    const set = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: set }))
    for (const sessionID of ["", "x".repeat(129)]) {
      await expect(
        handlers["session-mode.set"]({ sessionID, mode: "off" }, callContext()),
      ).resolves.toEqual({
        ok: false,
        errors: ["sessionID must be a non-empty string of at most 128 characters"],
      })
    }
    expect(set).not.toHaveBeenCalled()
  })

  it("rejects an unknown mode without calling the source", async () => {
    const set = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: set }))
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: "bogus" as "off" }, callContext()),
    ).resolves.toEqual({
      ok: false,
      errors: ["mode must be one of off, observe, active or null"],
    })
    expect(set).not.toHaveBeenCalled()
  })

  it("does not emit when the write fails internally", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(
      source({ setSessionMode: () => Promise.reject(new Error("storage down")) }),
      emit,
    )
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: "off" }, callContext()),
    ).resolves.toEqual({
      ok: false,
      errors: ["internal error"],
    })
    expect(emit).not.toHaveBeenCalled()
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-set")
  })

  it("logs emit failures without losing the set result", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const handlers = adaptiveRpcHandlers(source({ setSessionMode: () => Promise.resolve() }), () =>
      Promise.reject(new Error("emit boom")),
    )
    await expect(
      handlers["session-mode.set"]({ sessionID: "ses_1", mode: "off" }, callContext()),
    ).resolves.toEqual({
      ok: true,
    })
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-emit")
  })
})

describe("adaptiveRpcHandlers: tier-request (ADP-055)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("tier-request.get delegates to the source", async () => {
    const spy = vi.fn((sessionID: string) =>
      Promise.resolve(sessionID === "ses_1" ? ("advanced" as const) : null),
    )
    const handlers = adaptiveRpcHandlers(source({ getTierRequest: spy }))
    await expect(
      handlers["tier-request.get"]({ sessionID: "ses_1" }, callContext()),
    ).resolves.toEqual({
      tier: "advanced",
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toBe("ses_1")
  })

  it("tier-request.set records the tier and emits tier-request-changed on success", async () => {
    const note = vi.fn(() => true)
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ noteTierRequest: note }), emit)
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: "advanced" }, callContext()),
    ).resolves.toEqual({
      ok: true,
    })
    expect(note).toHaveBeenCalledWith("ses_1", "advanced")
    expect(emit).toHaveBeenCalledWith("tier-request-changed", { sessionID: "ses_1" })
  })

  it("clearing the request (null) delegates to setTierRequest and emits", async () => {
    const set = vi.fn(() => Promise.resolve())
    const note = vi.fn(() => true)
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(
      source({ setTierRequest: set, noteTierRequest: note }),
      emit,
    )
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: null }, callContext()),
    ).resolves.toEqual({ ok: true })
    expect(set).toHaveBeenCalledWith("ses_1", null)
    expect(note).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith("tier-request-changed", { sessionID: "ses_1" })
  })

  it("rejects an out-of-bounds sessionID without calling the source", async () => {
    const note = vi.fn(() => true)
    const set = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ noteTierRequest: note, setTierRequest: set }))
    for (const sessionID of ["", "x".repeat(129)]) {
      await expect(
        handlers["tier-request.set"]({ sessionID, tier: "quick" }, callContext()),
      ).resolves.toEqual({
        ok: false,
        errors: ["sessionID must be a non-empty string of at most 128 characters"],
      })
    }
    expect(note).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it("rejects an unknown tier without calling the source", async () => {
    const note = vi.fn(() => true)
    const handlers = adaptiveRpcHandlers(source({ noteTierRequest: note }))
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: "bogus" }, callContext()),
    ).resolves.toEqual({
      ok: false,
      errors: ["tier must be one of quick, standard, advanced or null"],
    })
    expect(note).not.toHaveBeenCalled()
  })

  it("degrades a failed note (false) to an error result", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(source({ noteTierRequest: () => false }), emit)
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: "quick" }, callContext()),
    ).resolves.toEqual({ ok: false, errors: ["internal error"] })
    expect(emit).not.toHaveBeenCalled()
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-set")
  })

  it("does not emit when the clear fails internally", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const emit = vi.fn(() => Promise.resolve())
    const handlers = adaptiveRpcHandlers(
      source({ setTierRequest: () => Promise.reject(new Error("storage down")) }),
      emit,
    )
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: null }, callContext()),
    ).resolves.toEqual({ ok: false, errors: ["internal error"] })
    expect(emit).not.toHaveBeenCalled()
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-set")
  })

  it("logs emit failures without losing the set result", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const handlers = adaptiveRpcHandlers(
      source({
        noteTierRequest: () => true,
        setTierRequest: () => Promise.resolve(),
      }),
      () => Promise.reject(new Error("emit boom")),
    )
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: null }, callContext()),
    ).resolves.toEqual({ ok: true })
    expect(spy.mock.calls[0]?.[0]).toContain("[coool.adaptive] rpc-emit")
  })

  it("succeeds without an emitter (emit is optional)", async () => {
    const note = vi.fn(() => true)
    const handlers = adaptiveRpcHandlers(source({ noteTierRequest: note }))
    await expect(
      handlers["tier-request.set"]({ sessionID: "ses_1", tier: "standard" }, callContext()),
    ).resolves.toEqual({ ok: true })
    expect(note).toHaveBeenCalledOnce()
  })
})
