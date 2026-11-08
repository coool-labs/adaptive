// covers: ["ADP-032", "ADP-033", "ADP-054", "ADP-055"]
import { describe, expect, it } from "vitest"

import { INVITE_MESSAGE, runAdaptive } from "../../src/flow/controller.js"
import { OPENCODE_COPY } from "../host-copy.js"
const INVITE_TITLE = OPENCODE_COPY.inviteTitle
import { errorText } from "../../src/flow/options.js"
import { applyPatch } from "../../src/state/settings/index.js"
import { STATUS_EMPTY_MESSAGE, statusTable } from "../../src/flow/status.js"
import type { Receipt } from "../../src/state/receipts/index.js"
import type { SettingsPatch, SettingsV1 } from "../../src/state/settings/index.js"
import type { PatchResult } from "../../src/state/settings/index.js"
import type { AdaptiveApi, AdaptiveView } from "../../src/flow/controller.js"
import type { ModelSummary, TierEditorChoice } from "../../src/flow/tiers.js"
import type { TierName } from "../../src/routing/tier-policy/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../src/status.js"

interface FakeView extends AdaptiveView {
  selectQueue: unknown[]
  confirmQueue: (boolean | undefined)[]
  alerts: { title: string; message: string }[]
  tables: { title: string; lines: string[] }[]
  toasts: { message: string; variant?: string }[]
  selects: string[]
  selectOptions: { title: string; value: unknown; description?: string }[][]
  pagedSpecs: {
    title: string
    options: { title: string; value: unknown }[]
    actions: { title: string; value: string; bind: string }[]
  }[]
}

function fakeView(): FakeView {
  const state = {
    selectQueue: [] as unknown[],
    confirmQueue: [] as (boolean | undefined)[],
    alerts: [] as { title: string; message: string }[],
    tables: [] as { title: string; lines: string[] }[],
    toasts: [] as { message: string; variant?: string }[],
    selects: [] as string[],
    selectOptions: [] as { title: string; value: unknown; description?: string }[][],
    pagedSpecs: [] as {
      title: string
      options: { title: string; value: unknown }[]
      actions: { title: string; value: string; bind: string }[]
    }[],
  }
  const view: AdaptiveView = {
    select: (spec) => {
      state.selects.push(spec.title)
      state.selectOptions.push(spec.options.map((option) => ({ ...option })))
      const next = state.selectQueue.shift()
      return next as never
    },
    selectPaged: (spec) => {
      state.selects.push(spec.title)
      state.pagedSpecs.push({
        title: spec.title,
        options: spec.options.map((option) => ({ ...option })),
        actions: spec.actions.map((action) => ({ ...action })),
      })
      const next = state.selectQueue.shift()
      if (next === "next" || next === "prev") {
        return Promise.resolve({ picked: undefined, action: next })
      }
      return Promise.resolve({ picked: next as never, action: undefined })
    },
    confirm: (spec) => {
      expect(spec.title.length).toBeGreaterThan(0)
      return Promise.resolve(state.confirmQueue.shift())
    },
    alert: (spec) => {
      state.alerts.push(spec)
      return Promise.resolve()
    },
    table: (spec) => {
      state.tables.push(spec)
      return Promise.resolve()
    },
    toast: (message, variant) => {
      state.toasts.push({ message, variant })
    },
  }
  return Object.assign(view, state)
}

function settings(overrides: Partial<SettingsV1> = {}): SettingsV1 {
  return {
    version: 1,
    mode: "observe",
    tiers: { quick: [], standard: [], advanced: [] },
    pin: null,
    agentTiers: {},
    inviteDismissed: true,
    ...overrides,
  }
}

/** A server-side store: field absence in the patch means "leave unchanged". */
function patched(base: SettingsV1, patch: SettingsPatch): SettingsV1 {
  const applied = applyPatch(base, patch)
  if (!applied.ok) throw new Error("test fixture sent an invalid patch")
  return applied.settings
}

function statusSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    waiting: [],
    receipts: 0,
    ...overrides,
  }
}

function resource(overrides: Partial<TierResourceStatus> = {}): TierResourceStatus {
  return {
    ref: { providerID: "prov", id: "m1" },
    health: "rate_limited",
    breaker: "closed",
    windowed: true,
    windowUntil: null,
    usedPercent: null,
    resetAt: null,
    ...overrides,
  }
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 1,
    at: 1_000,
    sessionID: "s1",
    decision: { kind: "defer", reason: "routing-defer" },
    ...overrides,
  }
}

function fakeApi(overrides: Partial<AdaptiveApi> = {}, patches: SettingsPatch[] = []): AdaptiveApi {
  const api: AdaptiveApi = {
    settings: () => Promise.resolve(settings()),
    setSettings: (patch) => {
      patches.push(patch)
      return Promise.resolve({ ok: true, settings: settings() } satisfies PatchResult)
    },
    status: () => Promise.resolve(statusSnapshot()),
    receipts: () => Promise.resolve([] as Receipt[]),
    sessionMode: () => Promise.resolve(null),
    setSessionMode: () => Promise.resolve({ ok: true }),
    tierRequest: () => Promise.resolve(null),
    setTierRequest: () => Promise.resolve({ ok: true }),
  }
  return Object.assign(api, overrides)
}

function failingApi(key: "settings" | "status" | "receipts", error: Error): AdaptiveApi {
  return fakeApi({ [key]: () => Promise.reject(error) })
}

function rejectingPatchApi(errors: string[]): AdaptiveApi {
  return fakeApi({
    setSettings: () => Promise.resolve({ ok: false, errors } satisfies PatchResult),
  })
}

function resourceChoice(index: number): TierEditorChoice {
  return { kind: "resource", index, ref: { providerID: "prov", id: "abc"[index] ?? "a" } }
}

function envWith(
  overrides: Partial<AdaptiveApi> = {},
  patches: SettingsPatch[] = [],
): { e: ReturnType<typeof env>; api: AdaptiveApi; patches: SettingsPatch[] } {
  const api = fakeApi(overrides, patches)
  return { e: env({ api }), api, patches }
}

function models(): ModelSummary[] {
  return [
    { providerID: "prov", modelID: "a", name: "Alpha", variants: ["high"] },
    { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
  ]
}

function env(
  overrides: {
    api?: AdaptiveApi
    view?: FakeView
    models?: ModelSummary[]
    sessionID?: string
    copy?: typeof OPENCODE_COPY
  } = {},
) {
  return {
    copy: overrides.copy ?? OPENCODE_COPY,
    api: overrides.api ?? fakeApi(),
    view: overrides.view ?? fakeView(),
    models: () => overrides.models ?? models(),
    ...(overrides.sessionID !== undefined ? { sessionID: overrides.sessionID } : {}),
  }
}

const EXIT = [undefined]

describe("controller: admission failures", () => {
  it("toasts a string failure via String()", async () => {
    const e = env({
      api: fakeApi({
        // The failure boundary must tolerate non-Error rejections (fail-open).
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        settings: () => Promise.reject("raw-rejection"),
      }),
    })
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["raw-rejection"])
  })
})

describe("errorText", () => {
  it("uses the message for Errors and String() for the rest", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
    expect(errorText("raw")).toBe("raw")
    expect(errorText(42)).toBe("42")
  })
})

describe("controller: admission failures (errors)", () => {
  it("toasts an error when settings cannot load", async () => {
    const e = env({ api: failingApi("settings", new Error("boom")) })
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["boom"])
    expect(e.view.selectQueue.length).toBe(0)
  })
})

describe("controller: invite flow", () => {
  it("shows the invite once, offers the menu, and records dismissal", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(settings({ inviteDismissed: false })),
    })
    e.view.confirmQueue.push(true)
    e.view.selectQueue.push(true, ...EXIT)
    await runAdaptive(e)
    expect(patches[0]).toEqual({ inviteDismissed: true })
    expect(e.view.toasts.some((t) => t.message === "Settings saved")).toBe(true)
    // The invitation follow-up is a select, not a dead-end confirm.
    expect(e.view.selectOptions[0]?.map((o) => o.title)).toEqual(["Open the menu now", "Later"])
  })

  it("records dismissal regardless of the confirm answer", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(settings({ inviteDismissed: false })),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(patches[0]).toEqual({ inviteDismissed: true })
  })

  it("keeps the loaded settings when the dismissal patch is rejected", async () => {
    const e = env({
      api: fakeApi({
        settings: () => Promise.resolve(settings({ inviteDismissed: false })),
        setSettings: () =>
          Promise.resolve({ ok: false, errors: ["invalid inviteDismissed"] } satisfies PatchResult),
      }),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.message).toContain("invalid inviteDismissed")
    expect(e.view.selects).toEqual([INVITE_TITLE])
  })

  it("skips the invite when already dismissed", async () => {
    const e = env()
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(e.view.confirmQueue.length).toBe(0)
  })

  it("pins the invite text", () => {
    expect(INVITE_TITLE).toBe("OpenCode Adaptive")
    expect(INVITE_MESSAGE).toMatch(/observe/i)
  })

  it("uses the host's invitation title", async () => {
    const e = env({
      copy: { ...OPENCODE_COPY, inviteTitle: "Test Adaptive" },
      api: fakeApi({ settings: () => Promise.resolve(settings({ inviteDismissed: false })) }),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push(undefined)
    await runAdaptive(e)
    expect(e.view.selects).toEqual(["Test Adaptive"])
  })
})

describe("controller: main menu", () => {
  it("exits immediately on a nil choice", async () => {
    const e = env()
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })
})

describe("controller: status branch", () => {
  it("shows every configured model as a table, then returns to the menu", async () => {
    const snapshot = statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } })
    const e = env({ api: fakeApi({ status: () => Promise.resolve(snapshot) }) })
    e.view.selectQueue.push("status", ...EXIT)
    await runAdaptive(e)
    expect(e.view.tables).toHaveLength(1)
    expect(e.view.tables[0]?.title).toBe("Status")
    expect(e.view.tables[0]?.lines).toEqual(statusTable(snapshot))
    // The table is the whole view: no per-resource selection follows — the
    // loop returns straight to the main menu (whose pick then exits).
    expect(e.view.selects).toEqual(["Adaptive (observe)", "Adaptive (observe)"])
  })

  it("shows the empty state when nothing is configured", async () => {
    const e = env()
    e.view.selectQueue.push("status", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.message).toBe(STATUS_EMPTY_MESSAGE)
  })

  it("toasts when the status page cannot load, while the menu stays silent", async () => {
    const e = env({ api: failingApi("status", new Error("down")) })
    e.view.selectQueue.push("status", ...EXIT)
    await runAdaptive(e)
    // The menu descriptions degrade silently; the status view's own fetch toasts.
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
  })
})

describe("controller: mode branch", () => {
  it("leaves the current mode untouched", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "global", "observe", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("applies a mode change", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "global", "active", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "active" }])
  })

  it("aborts when the mode dialog is cancelled", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "global", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })
})

describe("controller: session-mode branch (ADP-054)", () => {
  function sessionApi(overrides: Partial<AdaptiveApi> = {}, sets: unknown[] = []): AdaptiveApi {
    return fakeApi({
      setSessionMode: (sessionID, mode) => {
        sets.push({ sessionID, mode })
        return Promise.resolve({ ok: true })
      },
      ...overrides,
    })
  }

  it("titles the menu after the session's effective mode", async () => {
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({ sessionMode: () => Promise.resolve("active") }),
    })
    e.view.selectQueue.push(undefined)
    await runAdaptive(e)
    expect(e.view.selects[0]).toBe("Adaptive (active)")
  })

  it("falls back to the global mode when the override fetch fails", async () => {
    const e = env({
      sessionID: "ses_1",
      // The failure boundary must tolerate non-Error rejections (fail-open).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      api: fakeApi({ sessionMode: () => Promise.reject("raw") }),
    })
    e.view.selectQueue.push(undefined)
    await runAdaptive(e)
    expect(e.view.selects[0]).toBe("Adaptive (observe)")
    expect(e.view.toasts.map((t) => t.message)).toEqual(["raw"])
  })

  it("offers Follow global first, then the modes with override/current markers", async () => {
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({ sessionMode: () => Promise.resolve("active") }),
    })
    e.view.selectQueue.push("mode", "session", undefined, undefined)
    await runAdaptive(e)
    const options = e.view.selectOptions[2]
    if (options === undefined) throw new Error("mode menu was not shown")
    expect(options.map((option) => option.title)).toEqual([
      "Follow global (observe)",
      "off",
      "observe",
      "active (override)",
    ])
    expect(options[0]?.value).toEqual({ kind: "global" })
  })

  it("marks the inherited global mode as current when no override is set", async () => {
    const e = env({ sessionID: "ses_1" })
    e.view.selectQueue.push("mode", "session", undefined, undefined)
    await runAdaptive(e)
    expect(e.view.selectOptions[2]?.map((option) => option.title)).toEqual([
      "Follow global (observe)",
      "off",
      "observe (current)",
      "active",
    ])
  })

  it("picking a mode patches the session override, not the global settings", async () => {
    const sets: unknown[] = []
    const patches: SettingsPatch[] = []
    const e = env({
      sessionID: "ses_1",
      api: sessionApi(
        {
          setSettings: (patch) => {
            patches.push(patch)
            return Promise.resolve({ ok: true, settings: settings() } satisfies PatchResult)
          },
        },
        sets,
      ),
    })
    e.view.selectQueue.push("mode", "session", { kind: "mode", mode: "active" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", mode: "active" }])
    expect(patches).toEqual([])
    // The menu retitles to the new effective mode.
    expect(e.view.selects).toContain("Adaptive (active)")
  })

  it("picking Follow global clears the override", async () => {
    const sets: unknown[] = []
    const e = env({
      sessionID: "ses_1",
      api: sessionApi({ sessionMode: () => Promise.resolve("off") }, sets),
    })
    e.view.selectQueue.push("mode", "session", { kind: "global" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", mode: null }])
    expect(e.view.selects[0]).toBe("Adaptive (off)")
    // Back to following global: the menu retitles to the global mode.
    expect(e.view.selects[3]).toBe("Adaptive (observe)")
  })

  it("picking Global mode… patches the global settings and keeps the override", async () => {
    const sets: unknown[] = []
    const patches: SettingsPatch[] = []
    // No override: the session follows the global mode, so the retitled menu
    // shows the patched global mode. The store is stateful: settings.get
    // reflects the applied patch, exactly like the real server.
    let current = settings()
    const e = env({
      sessionID: "ses_1",
      api: sessionApi(
        {
          settings: () => Promise.resolve(current),
          setSettings: (patch) => {
            patches.push(patch)
            current = patched(current, patch)
            return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
          },
        },
        sets,
      ),
    })
    e.view.selectQueue.push("mode", "global", "active", undefined)
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "active" }])
    // The override state was deliberately untouched by the global change.
    expect(sets).toEqual([])
    // The menu retitles to the session's effective mode, which still
    // follows the (now active) global mode.
    expect(e.view.selects).toContain("Adaptive (active)")
  })

  it("a global pick equal to the current global mode is a no-op", async () => {
    const sets: unknown[] = []
    const patches: SettingsPatch[] = []
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({}, patches),
    })
    e.api.setSessionMode = (sessionID, mode) => {
      sets.push({ sessionID, mode })
      return Promise.resolve({ ok: true })
    }
    e.view.selectQueue.push("mode", "global", "observe", undefined)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(sets).toEqual([])
  })

  it("escape on the global mode list leaves everything untouched", async () => {
    const sets: unknown[] = []
    const patches: SettingsPatch[] = []
    const e = env({ sessionID: "ses_1", api: fakeApi({}, patches) })
    e.api.setSessionMode = (sessionID, mode) => {
      sets.push({ sessionID, mode })
      return Promise.resolve({ ok: true })
    }
    e.view.selectQueue.push("mode", "global", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(sets).toEqual([])
  })

  it("a rejected global patch alerts and keeps the session state", async () => {
    const sets: unknown[] = []
    const e = env({
      sessionID: "ses_1",
      api: sessionApi(
        {
          sessionMode: () => Promise.resolve(null),
          setSettings: () =>
            Promise.resolve({ ok: false, errors: ["mode refused"] } satisfies PatchResult),
        },
        sets,
      ),
    })
    e.view.selectQueue.push("mode", "global", "active", undefined)
    await runAdaptive(e)
    expect(e.view.alerts).toContainEqual({ title: "Invalid settings", message: "mode refused" })
    expect(sets).toEqual([])
  })

  it("escape on the target select reopens the menu without a mode list", async () => {
    const sets: unknown[] = []
    const patches: SettingsPatch[] = []
    const e = env({ sessionID: "ses_1", api: fakeApi({}, patches) })
    e.api.setSessionMode = (sessionID, mode) => {
      sets.push({ sessionID, mode })
      return Promise.resolve({ ok: true })
    }
    e.view.selectQueue.push("mode", "session", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(sets).toEqual([])
    // The menu, the target select, and the session list re-shown before the
    // menu again.
    expect(e.view.selects).toEqual([
      "Adaptive (observe)",
      "Operating mode",
      "This session's mode",
      "Adaptive (observe)",
    ])
  })

  it("does not re-patch when the pick changes nothing", async () => {
    const sets: unknown[] = []
    const e = env({ sessionID: "ses_1", api: sessionApi({}, sets) })
    // No override yet: Follow global is a no-op. Then picking the effective
    // mode again is also a no-op.
    e.view.selectQueue.push(
      "mode",
      "session",
      { kind: "global" },
      "mode",
      "session",
      { kind: "mode", mode: "observe" },
      undefined,
    )
    await runAdaptive(e)
    expect(sets).toEqual([])
  })

  it("alerts on an invalid override result", async () => {
    const e = env({
      sessionID: "ses_1",
      api: sessionApi({
        setSessionMode: () =>
          Promise.resolve({
            ok: false,
            errors: ["mode must be one of off, observe, active or null"],
          }),
      }),
    })
    e.view.selectQueue.push("mode", "session", { kind: "mode", mode: "active" }, undefined)
    await runAdaptive(e)
    expect(e.view.alerts).toContainEqual({
      title: "Invalid settings",
      message: "mode must be one of off, observe, active or null",
    })
  })

  it("toasts when the override write fails", async () => {
    const e = env({
      sessionID: "ses_1",
      api: sessionApi({ setSessionMode: () => Promise.reject(new Error("storage down")) }),
    })
    e.view.selectQueue.push("mode", "session", { kind: "mode", mode: "active" }, undefined)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["storage down"])
  })

  it("escape on the home target select reopens the menu without a mode list", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(e.view.selects).toEqual(["Adaptive (observe)", "Operating mode", "Adaptive (observe)"])
  })

  it("alerts on home when This session… is picked and repeats the target question", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "session", "global", "observe", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(e.view.alerts).toContainEqual({
      title: "This session",
      message:
        "This session's mode can only be changed inside a session. Open a session and run /adaptive from there.",
    })
    // The target question is re-shown after the alert, so the user can pick
    // the global target without leaving the menu.
    expect(e.view.selects).toEqual([
      "Adaptive (observe)",
      "Operating mode",
      "Operating mode",
      "Global mode",
      "Adaptive (observe)",
    ])
  })

  it("keeps the global mode menu when no session is open", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "global", "active", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "active" }])
    // The global menu has no Follow global entry.
    expect(e.view.selectOptions[2]?.map((option) => option.title)).toEqual([
      "off",
      "observe (current)",
      "active",
    ])
  })

  it("toasts the saved feedback only on the first save of a dialog session", async () => {
    // The invitation dismissal is the dialog session's first save; the
    // later override save stays silent.
    const sets: unknown[] = []
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        settings: () => Promise.resolve({ ...settings(), inviteDismissed: false }),
        sessionMode: () => Promise.resolve("off"),
        setSessionMode: (sessionID, mode) => {
          sets.push({ sessionID, mode })
          return Promise.resolve({ ok: true })
        },
      }),
    })
    e.view.confirmQueue.push(true)
    e.view.selectQueue.push(true, "mode", "session", { kind: "global" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", mode: null }])
    expect(e.view.toasts).toEqual([{ message: "Settings saved", variant: "success" }])
  })

  it("leaves the override untouched when clearing it fails", async () => {
    const e = env({
      sessionID: "ses_1",
      api: sessionApi({
        sessionMode: () => Promise.resolve("off"),
        setSessionMode: () => Promise.reject(new Error("storage down")),
      }),
    })
    e.view.selectQueue.push("mode", "session", { kind: "global" }, undefined)
    await runAdaptive(e)
    // The menu stays titled after the (still set) override.
    expect(e.view.selects[0]).toBe("Adaptive (off)")
    expect(e.view.toasts.map((t) => t.message)).toEqual(["storage down"])
  })
})

describe("controller: settings fetch failures inside menu loops", () => {
  it("a failing menu-loop settings refetch degrades silently without a toast", async () => {
    // runMenu refreshes settings+status per pass and swallows fetch failures
    // (no toast spam); the menu still renders on the last known values. The
    // entry read succeeds; the loop's refetch fails.
    let settingsCalls = 0
    const e = env({
      api: fakeApi({
        settings: () => {
          settingsCalls += 1
          return settingsCalls === 1
            ? Promise.resolve(settings())
            : Promise.reject(new Error("settings down"))
        },
      }),
    })
    e.view.selectQueue.push("tier", undefined)
    await runAdaptive(e)
    expect(e.view.selects[0]).toBe("Adaptive (observe)")
    expect(e.view.toasts).toEqual([])
  })

  it("the tier editor exits with the last confirmed save when a refetch fails", async () => {
    // Entry read and the editor's first pass succeed; the editor's SECOND
    // pass (after exiting its first tier view) fails: tryApi toasts, the
    // editor returns the last confirmed snapshot, and the menu re-renders.
    let settingsCalls = 0
    const e = env({
      api: fakeApi({
        settings: () => {
          settingsCalls += 1
          return settingsCalls <= 2
            ? Promise.resolve(settings())
            : Promise.reject(new Error("settings down"))
        },
      }),
    })
    e.view.selectQueue.push("models", "tier", undefined, undefined)
    await runAdaptive(e)
    expect(e.view.toasts).toEqual([{ message: "settings down", variant: "error" }])
    expect(e.view.selects.at(-1)).toBe("Adaptive (observe)")
  })
})

describe("controller: session tier-request branch (ADP-055)", () => {
  it("alerts on home when Tier is picked and returns to the menu", async () => {
    const e = env({})
    e.view.selectQueue.push("tier", undefined)
    await runAdaptive(e)
    expect(e.view.alerts).toContainEqual({
      title: "This session",
      message:
        "This session's tier request can only be changed inside a session. Open a session and run /adaptive from there.",
    })
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("offers Follow routing ladder first, then the tiers with the pinned one marked", async () => {
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({ tierRequest: () => Promise.resolve("quick" as const) }),
    })
    e.view.selectQueue.push("tier", undefined, undefined)
    await runAdaptive(e)
    const options = e.view.selectOptions[1]
    if (options === undefined) throw new Error("tier menu was not shown")
    expect(options.map((option) => option.title)).toEqual([
      "Follow routing ladder",
      "quick (pinned)",
      "standard",
      "advanced",
    ])
    expect(options[0]?.value).toEqual({ kind: "ladder" })
  })

  it("picking a tier pins the session's request and retitles the menu entry", async () => {
    const sets: unknown[] = []
    let pinned: TierName | null = null
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        tierRequest: () => Promise.resolve(pinned),
        setTierRequest: (sessionID, tier) => {
          pinned = tier as TierName | null
          sets.push({ sessionID, tier })
          return Promise.resolve({ ok: true })
        },
      }),
    })
    e.view.selectQueue.push("tier", { kind: "tier", tier: "advanced" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", tier: "advanced" }])
    // The menu re-rendered after the pin: the last main-menu render shows it.
    const reRendered = e.view.selectOptions[2]
    expect(reRendered?.find((option) => option.value === "tier")?.description).toBe(
      "pinned to advanced — steers this session",
    )
  })

  it("picking Follow routing ladder clears the request", async () => {
    const sets: unknown[] = []
    let pinned: TierName | null = "quick"
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        tierRequest: () => Promise.resolve(pinned),
        setTierRequest: (sessionID, tier) => {
          pinned = tier as TierName | null
          sets.push({ sessionID, tier })
          return Promise.resolve({ ok: true })
        },
      }),
    })
    e.view.selectQueue.push("tier", { kind: "ladder" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", tier: null }])
    // The menu re-rendered after the clear: the null result must survive the
    // per-loop fetch (not be coerced to undefined) so the description says the
    // ladder decides again.
    const reRendered = e.view.selectOptions[2]
    expect(reRendered?.find((option) => option.value === "tier")?.description).toBe(
      "not pinned — the routing ladder decides",
    )
  })

  it("picking the already-pinned tier is a no-op", async () => {
    const sets: unknown[] = []
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        tierRequest: () => Promise.resolve("standard"),
        setTierRequest: (sessionID, tier) => {
          sets.push({ sessionID, tier })
          return Promise.resolve({ ok: true })
        },
      }),
    })
    e.view.selectQueue.push("tier", { kind: "tier", tier: "standard" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([])
  })

  it("toasts Settings saved only on the first tier save of a dialog session", async () => {
    let pinned: TierName | null = null
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        tierRequest: () => Promise.resolve(pinned),
        setTierRequest: (_sessionID, tier) => {
          // The controller's API surface passes the tier as a raw string; the
          // RPC layer validates it, so this fixture narrows it to TierName.
          pinned = tier as TierName | null
          return Promise.resolve({ ok: true })
        },
      }),
    })
    e.view.selectQueue.push(
      "tier",
      { kind: "tier", tier: "quick" },
      "tier",
      { kind: "tier", tier: "advanced" },
      undefined,
    )
    await runAdaptive(e)
    expect(e.view.toasts.filter((t) => t.message === "Settings saved")).toHaveLength(1)
  })

  it("alerts on an invalid tier-request result", async () => {
    const sets: unknown[] = []
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({
        setTierRequest: (sessionID, tier) => {
          sets.push({ sessionID, tier })
          return Promise.resolve({ ok: false, errors: ["tier refused"] })
        },
      }),
    })
    e.view.selectQueue.push("tier", { kind: "tier", tier: "quick" }, undefined)
    await runAdaptive(e)
    expect(sets).toEqual([{ sessionID: "ses_1", tier: "quick" }])
    expect(e.view.alerts).toContainEqual({ title: "Invalid tier request", message: "tier refused" })
  })

  it("toasts when the request fetch fails and skips the menu", async () => {
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({ tierRequest: () => Promise.reject(new Error("raw")) }),
    })
    e.view.selectQueue.push("tier", undefined)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["raw"])
  })

  it("toasts when the request write fails and stays in the menu", async () => {
    const e = env({
      sessionID: "ses_1",
      api: fakeApi({ setTierRequest: () => Promise.reject(new Error("storage down")) }),
    })
    e.view.selectQueue.push("tier", { kind: "tier", tier: "quick" }, undefined)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["storage down"])
  })
})

describe("controller: tiers branch", () => {
  it.each([false, true])(
    "retains saved tiers after leaving the editor (status failure: %s)",
    async (failStatus) => {
      let current = settings()
      let writes = 0
      const api = fakeApi({
        settings: () => Promise.resolve(current),
        setSettings: (patch) => {
          current = patched(current, patch)
          writes += 1
          return Promise.resolve({ ok: true, settings: current })
        },
        status: () => {
          if (failStatus && writes === 1) {
            writes += 1
            return Promise.reject(new Error("status unavailable"))
          }
          return Promise.resolve(statusSnapshot())
        },
      })
      const e = env({ api })
      e.view.selectQueue.push(
        "models",
        "standard",
        { kind: "add" },
        { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
        undefined, // Escape the tier page: back to the tier list.
        "quick",
        { kind: "add" },
        { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
        undefined,
        undefined,
        "pin",
        undefined,
        undefined,
      )
      await runAdaptive(e)
      expect(current.tiers.standard).toEqual([{ providerID: "prov", id: "b" }])
      expect(current.tiers.quick).toEqual([{ providerID: "prov", id: "b" }])
      const menu = e.view.selectOptions.find(
        (options) =>
          options.some((option) => option.value === "mode") &&
          options.some((option) => option.description === "quick: 1 · standard: 1 · advanced: 0"),
      )
      expect(menu).toBeDefined()
      const pinIndex = e.view.selects.indexOf("Pin")
      expect(e.view.selectOptions[pinIndex]?.map((option) => option.title)).toContain(
        "prov/b (standard)",
      )
    },
  )

  it("serves the editor from fresh server settings, not the boot-time copy", async () => {
    // One server-side store: a write from outside this dialog (another
    // surface, another session) lands between the boot fetch and the first
    // editor pass. The editor must re-read the store instead of pairing the
    // stale boot snapshot with the fresh status, or its add-patch clobbers
    // the out-of-band resource.
    let current = settings()
    let reads = 0
    const writes: SettingsPatch[] = []
    const api = fakeApi({
      settings: () => {
        reads += 1
        if (reads >= 2) {
          current = {
            ...current,
            mode: "active",
            tiers: { ...current.tiers, standard: [{ providerID: "other", id: "x" }] },
          }
        }
        return Promise.resolve(current)
      },
      setSettings: (patch) => {
        writes.push(patch)
        current = patched(current, patch)
        return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
      },
    })
    const e = env({ api })
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
      ...EXIT,
    )
    await runAdaptive(e)
    const editorIndex = e.view.selects.indexOf("Tier: standard")
    expect(editorIndex).toBeGreaterThan(0)
    // The out-of-band resource shows up in the editor rows (fresh settings).
    expect(e.view.selectOptions[editorIndex]?.map((option) => option.title)).toContain("other/x")
    // The add-patch is built from the fresh list: the out-of-band resource
    // survives, it is not clobbered back to the boot-time copy.
    const firstWrite = writes[0]
    if (firstWrite?.tiers === undefined) {
      throw new Error("the editor never wrote a tiers patch")
    }
    expect(firstWrite.tiers.standard).toEqual([
      { providerID: "other", id: "x" },
      { providerID: "prov", id: "b" },
    ])
  })

  it("refreshes the menu rows from the server on every loop pass", async () => {
    // Same staleness family as the tier editor: the menu pairs settings with
    // a freshly fetched status, so a write from outside the dialog between
    // two passes must be picked up, not hidden behind the boot-time copy.
    let current = settings()
    let reads = 0
    const api = fakeApi({
      settings: () => {
        reads += 1
        if (reads >= 3) {
          current = {
            ...current,
            tiers: { ...current.tiers, quick: [{ providerID: "other", id: "y" }] },
          }
        }
        return Promise.resolve(current)
      },
    })
    const e = env({ api })
    e.view.selectQueue.push("models", ...EXIT)
    await runAdaptive(e)
    const menus = e.view.selectOptions.filter((options) =>
      options.some((option) => option.value === "mode"),
    )
    const last = menus[menus.length - 1]
    expect(last?.find((option) => option.value === "models")?.description).toBe(
      "quick: 1 · standard: 0 · advanced: 0",
    )
  })

  it("describes the effective session mode rather than the global default", async () => {
    const e = env({
      sessionID: "s1",
      api: fakeApi({ sessionMode: () => Promise.resolve("active") }),
    })
    await runAdaptive(e)
    expect(e.view.selects[0]).toBe("Adaptive (active)")
    expect(e.view.selectOptions[0]?.find((option) => option.value === "mode")?.description).toBe(
      "currently active",
    )
  })

  it("exits when the tier status fetch fails", async () => {
    const e = env({ api: failingApi("status", new Error("down")) })
    e.view.selectQueue.push("models", ...EXIT)
    await runAdaptive(e)
    // Only the tier editor's own status fetch toasts: the menu refresh
    // degrades its descriptions silently.
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the menu when tier selection is cancelled", async () => {
    const e = env()
    e.view.selectQueue.push("models", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the tier editor when the editor choice is cancelled", async () => {
    const e = env()
    e.view.selectQueue.push("models", "standard", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the tier menu on escape", async () => {
    const e = env()
    e.view.selectQueue.push("models", "standard", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("re-opens the tier page after a save instead of the tier list", async () => {
    // An add (like a move or a remove) returns to the tier page with the
    // saved rows: consecutive edits on one tier never bounce back to the
    // tier list — only Escape does.
    let current = settings()
    const api = fakeApi({
      settings: () => Promise.resolve(current),
      setSettings: (patch) => {
        current = patched(current, patch)
        return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
      },
    })
    const e = env({ api })
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
      undefined, // Escape the tier page: back to the tier list.
      undefined, // Leave the editor.
      undefined, // Leave the menu.
    )
    await runAdaptive(e)
    const pages = e.view.selects
      .map((title, index) => (title === "Tier: standard" ? index : -1))
      .filter((index) => index >= 0)
    expect(pages).toHaveLength(2)
    const first = pages[0]
    const second = pages[1]
    if (first === undefined || second === undefined) {
      throw new Error("the tier page never re-rendered")
    }
    // Between the two page renders only the add flow appears — never the
    // tier list ("Tier").
    expect(e.view.selects.slice(first + 1, second)).not.toContain("Tier")
    expect(e.view.selectOptions[second]?.map((option) => option.title)).toContain("prov/b")
  })

  it("a failed post-save refresh keeps the tier page silently", async () => {
    // The page re-render after a save re-reads the server silently: a
    // failed read keeps the last known rows (the save response) and never
    // toasts — the save itself already reported.
    let current = settings()
    let settingsCalls = 0
    const api = fakeApi({
      settings: () => {
        settingsCalls += 1
        if (settingsCalls === 4) return Promise.reject(new Error("settings down"))
        return Promise.resolve(current)
      },
      setSettings: (patch) => {
        current = patched(current, patch)
        return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
      },
    })
    const e = env({ api })
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
      undefined,
      undefined,
      undefined,
    )
    await runAdaptive(e)
    // The save itself reports ("Settings saved"); the failed refresh after
    // it must add no error toast.
    expect(e.view.toasts).toEqual([{ message: "Settings saved", variant: "success" }])
    expect(current.tiers.standard).toEqual([{ providerID: "prov", id: "b" }])
    const pages = e.view.selects
      .map((title, index) => (title === "Tier: standard" ? index : -1))
      .filter((index) => index >= 0)
    const second = pages[1]
    if (second === undefined) throw new Error("the tier page never re-rendered")
    expect(e.view.selectOptions[second]?.map((option) => option.title)).toContain("prov/b")
  })

  it("adds a model with a chosen variant", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "a", name: "Alpha", variants: ["high"] },
      { variant: "high" },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [{ providerID: "prov", id: "a", variant: "high" }],
          advanced: [],
        },
      },
    ])
  })

  it("aborts when the variant choice is cancelled", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "a", name: "Alpha", variants: ["high"] },
      undefined,
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("adds a model without variants directly", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [{ providerID: "prov", id: "b" }],
          advanced: [],
        },
      },
    ])
  })

  it("aborts when the model picker is cancelled", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("models", "standard", { kind: "add" }, undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("alerts and keeps settings when a patch is rejected", async () => {
    const e = env({ api: rejectingPatchApi(["invalid tiers"]) })
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b", name: "Beta", variants: [] },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(e.view.alerts.length).toBe(1)
    expect(e.view.alerts[0]?.message).toContain("invalid tiers")
  })

  function tierSettings(refs: { providerID: string; id: string }[]): SettingsV1 {
    return settings({
      mode: "active",
      tiers: { quick: [], standard: refs, advanced: [] },
    })
  }

  it("moves a resource up", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          tierSettings([
            { providerID: "prov", id: "a" },
            { providerID: "prov", id: "b" },
          ]),
        ),
    })
    e.view.selectQueue.push("models", "standard", resourceChoice(1), "up", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [
            { providerID: "prov", id: "b" },
            { providerID: "prov", id: "a" },
          ],
          advanced: [],
        },
      },
    ])
  })

  it("moves a resource to the top", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          tierSettings([
            { providerID: "prov", id: "a" },
            { providerID: "prov", id: "b" },
            { providerID: "prov", id: "c" },
          ]),
        ),
    })
    e.view.selectQueue.push("models", "standard", resourceChoice(2), "top", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [
            { providerID: "prov", id: "c" },
            { providerID: "prov", id: "a" },
            { providerID: "prov", id: "b" },
          ],
          advanced: [],
        },
      },
    ])
  })

  it("moves a resource down", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          tierSettings([
            { providerID: "prov", id: "a" },
            { providerID: "prov", id: "b" },
          ]),
        ),
    })
    e.view.selectQueue.push("models", "standard", resourceChoice(0), "down", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [
            { providerID: "prov", id: "b" },
            { providerID: "prov", id: "a" },
          ],
          advanced: [],
        },
      },
    ])
  })

  it("removes a resource after confirmation", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.confirmQueue.push(true)
    e.view.selectQueue.push("models", "standard", resourceChoice(0), "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ tiers: { quick: [], standard: [], advanced: [] } }])
  })

  it("keeps the resource when removal is not confirmed", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push("models", "standard", resourceChoice(0), "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })
})

describe("controller: pin branch", () => {
  it("alerts when there is nothing to pin", async () => {
    const e = env()
    e.view.selectQueue.push("pin", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.message).toBe("(no configured resources to pin)")
    expect(e.view.selects.filter((title) => title === "Pin")).toHaveLength(0)
  })

  it("clears the pin", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          settings({
            pin: { providerID: "prov", id: "a" },
            tiers: { quick: [], standard: [{ providerID: "prov", id: "a" }], advanced: [] },
          }),
        ),
    })
    e.view.selectQueue.push("pin", { kind: "clear" }, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ pin: null }])
  })

  it("pins a configured resource", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          settings({
            tiers: {
              quick: [],
              standard: [{ providerID: "prov", id: "a", variant: "high" }],
              advanced: [],
            },
          }),
        ),
    })
    e.view.selectQueue.push(
      "pin",
      { kind: "pin", ref: { providerID: "prov", id: "a", variant: "high" } },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([{ pin: { providerID: "prov", id: "a", variant: "high" } }])
  })

  it("returns to the menu when the pin selection is cancelled on a configured tier", async () => {
    const { e, patches } = envWith({
      settings: () =>
        Promise.resolve(
          settings({
            tiers: { quick: [], standard: [{ providerID: "prov", id: "a" }], advanced: [] },
          }),
        ),
    })
    e.view.selectQueue.push("pin", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
    expect(e.view.toasts).toEqual([])
  })
})

describe("controller: save feedback", () => {
  it("toasts the first save of a session but stays quiet on later saves", async () => {
    // The fake echoes each applied patch so the second flow sees the state
    // the first save produced.
    let current = settings({
      tiers: { quick: [], standard: [{ providerID: "prov", id: "m1" }], advanced: [] },
    })
    const patches: SettingsPatch[] = []
    const e = env({
      api: fakeApi({
        // The store is stateful: settings.get reflects the applied patch, so
        // the second flow sees the state the first save produced.
        settings: () => Promise.resolve(current),
        setSettings: (patch) => {
          patches.push(patch)
          current = patched(current, patch)
          return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
        },
      }),
    })
    e.view.selectQueue.push(
      "mode",
      "global",
      "active",
      "pin",
      { kind: "pin", ref: { providerID: "prov", id: "m1" } },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "active" }, { pin: { providerID: "prov", id: "m1" } }])
    expect(e.view.toasts.filter((t) => t.message === "Settings saved")).toHaveLength(1)
  })
})

describe("controller: receipts branch", () => {
  it("toasts when receipts cannot load", async () => {
    const e = env({ api: failingApi("receipts", new Error("down")) })
    e.view.selectQueue.push("receipts", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
  })

  it("alerts when no receipts exist", async () => {
    const e = env()
    e.view.selectQueue.push("receipts", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.message).toContain("No decisions recorded yet.")
  })

  it("shows receipt detail on pick", async () => {
    const e = env({
      api: fakeApi({ receipts: () => Promise.resolve([receipt()]) }),
    })
    e.view.selectQueue.push("receipts", receipt(), ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts.length).toBe(1)
    expect(e.view.alerts[0]?.title).toContain("#1")
    expect(e.view.alerts[0]?.message).toContain("session")
    expect(e.view.alerts[0]?.message).toContain("What happened:")
  })

  it("leaves the list without alerting when the receipt pick is cancelled", async () => {
    const e = env({
      api: fakeApi({ receipts: () => Promise.resolve([receipt()]) }),
    })
    e.view.selectQueue.push("receipts", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts).toEqual([])
  })

  it("paginates the receipts browser instead of hiding receipts past the first page (A8)", async () => {
    const many: Receipt[] = Array.from({ length: 25 }, (_, index) =>
      receipt({ id: index + 1, decision: { kind: "defer", reason: "routing-defer" } }),
    )
    const e = env({ api: fakeApi({ receipts: () => Promise.resolve(many) }) })
    // Browse: open receipts → next page (footer action) → back to page 1 →
    // pick the last receipt → detail → leave.
    e.view.selectQueue.push("receipts", "next", "prev", many[24], undefined)
    await runAdaptive(e)

    // The receipts pages in call order (the main menu uses plain select):
    // page 1, page 2, page 1 after going back, page 1 again after the
    // detail alert (viewing a detail returns to the same page).
    const pages = e.view.pagedSpecs
    expect(pages).toHaveLength(4)
    // Page 1: exactly the first 20 receipts as options — the page flip is
    // a footer action, not a list item.
    expect(pages[0]?.options).toHaveLength(20)
    expect(pages[0]?.options[0]?.title).toContain("#1")
    expect(pages[0]?.actions).toEqual([{ title: "Next page", value: "next", bind: "ctrl+f" }])
    // Page 2: the remaining 5 receipts plus only the way back.
    expect(pages[1]?.options).toHaveLength(5)
    expect(pages[1]?.options[0]?.title).toContain("#21")
    expect(pages[1]?.options.at(-1)?.title).toContain("#25")
    expect(pages[1]?.actions).toEqual([{ title: "Previous page", value: "prev", bind: "ctrl+b" }])
    // Going back re-renders page 1 (footer action again, no way back).
    expect(pages[2]?.options).toHaveLength(20)
    expect(pages[2]?.actions).toEqual([{ title: "Next page", value: "next", bind: "ctrl+f" }])
    expect(pages[3]?.options).toHaveLength(20)
    // The picked receipt's detail was shown.
    expect(e.view.alerts[0]?.title).toContain("#25")
  })
})

describe("controller: cancel and stale paths", () => {
  function tierSettings(refs: { providerID: string; id: string }[]): SettingsV1 {
    return settings({
      mode: "active",
      tiers: { quick: [], standard: refs, advanced: [] },
    })
  }

  it("toasts when the settings patch call itself rejects", async () => {
    const { e, patches } = envWith({
      setSettings: () => Promise.reject(new Error("down")),
    })
    e.view.selectQueue.push("mode", "global", "active", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
    expect(patches).toEqual([])
  })

  it("returns to the tier editor when the resource menu is cancelled", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.selectQueue.push("models", "standard", resourceChoice(0), undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("keeps settings when the pin menu is cancelled", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("pin", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })
})
