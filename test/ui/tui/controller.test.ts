// covers: ["ADP-032", "ADP-033"]
import { describe, expect, it } from "vitest"

import { INVITE_MESSAGE, INVITE_TITLE, runAdaptive } from "../../../src/ui/tui/controller.js"
import { errorText } from "../../../src/ui/tui/options.js"
import { formatStatus } from "../../../src/ui/tui/status.js"
import type { Receipt } from "../../../src/state/receipts/index.js"
import type { SettingsPatch, SettingsV1 } from "../../../src/state/settings/index.js"
import type { PatchResult } from "../../../src/state/settings/index.js"
import type { AdaptiveApi, AdaptiveView } from "../../../src/ui/tui/controller.js"
import type { ModelSummary } from "../../../src/ui/tui/tiers.js"
import type { StatusSnapshot } from "../../../src/rpc/status.js"

interface FakeView extends AdaptiveView {
  selectQueue: unknown[]
  confirmQueue: (boolean | undefined)[]
  alerts: { title: string; message: string }[]
  toasts: { message: string; variant?: string }[]
  selects: string[]
  selectOptions: { title: string; value: unknown }[][]
}

function fakeView(): FakeView {
  const state = {
    selectQueue: [] as unknown[],
    confirmQueue: [] as (boolean | undefined)[],
    alerts: [] as { title: string; message: string }[],
    toasts: [] as { message: string; variant?: string }[],
    selects: [] as string[],
    selectOptions: [] as { title: string; value: unknown }[][],
  }
  const view: AdaptiveView = {
    select: (spec) => {
      state.selects.push(spec.title)
      state.selectOptions.push(spec.options.map((option) => ({ ...option })))
      const next = state.selectQueue.shift()
      return next as never
    },
    confirm: (spec) => {
      expect(spec.title.length).toBeGreaterThan(0)
      return Promise.resolve(state.confirmQueue.shift())
    },
    alert: (spec) => {
      state.alerts.push(spec)
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

function statusSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    receipts: 0,
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
  } = {},
) {
  return {
    api: overrides.api ?? fakeApi(),
    view: overrides.view ?? fakeView(),
    models: () => overrides.models ?? models(),
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
  it("shows the invite once and records dismissal", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(settings({ inviteDismissed: false })),
    })
    e.view.confirmQueue.push(true)
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(patches[0]).toEqual({ inviteDismissed: true })
    expect(e.view.toasts.some((t) => t.message === "Settings saved")).toBe(true)
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
    expect(e.view.selects).toEqual(["Adaptive"])
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
  it("alerts the formatted status", async () => {
    const e = env()
    e.view.selectQueue.push("status", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts.length).toBe(1)
    expect(e.view.alerts[0]?.message).toBe(formatStatus(statusSnapshot()))
  })

  it("toasts when the status fetch fails", async () => {
    const e = env({ api: failingApi("status", new Error("down")) })
    e.view.selectQueue.push("status", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
  })
})

describe("controller: mode branch", () => {
  it("leaves the current mode untouched", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "observe", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("applies a mode change", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", "control", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "control" }])
  })

  it("aborts when the mode dialog is cancelled", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push("mode", undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })
})

describe("controller: tiers branch", () => {
  it("exits when the tier status fetch fails", async () => {
    const e = env({ api: failingApi("status", new Error("down")) })
    e.view.selectQueue.push("tiers", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the menu when tier selection is cancelled", async () => {
    const e = env()
    e.view.selectQueue.push("tiers", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the tier editor when the editor choice is cancelled", async () => {
    const e = env()
    e.view.selectQueue.push("tiers", "standard", undefined, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("returns to the tier menu on back", async () => {
    const e = env()
    e.view.selectQueue.push("tiers", "standard", { kind: "back" }, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("adds a model with a chosen variant", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "a" },
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
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "a" },
      undefined,
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("adds a model without variants directly", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b" },
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
    e.view.selectQueue.push("tiers", "standard", { kind: "add" }, undefined, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("alerts and keeps settings when a patch is rejected", async () => {
    const e = env({ api: rejectingPatchApi(["invalid tiers"]) })
    e.view.selectQueue.push(
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "prov", modelID: "b" },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(e.view.alerts.length).toBe(1)
    expect(e.view.alerts[0]?.message).toContain("invalid tiers")
  })

  function tierSettings(refs: { providerID: string; id: string }[]): SettingsV1 {
    return settings({
      mode: "control",
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
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 1 }, "up", ...EXIT)
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
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 0 }, "down", ...EXIT)
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
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 0 }, "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ tiers: { quick: [], standard: [], advanced: [] } }])
  })

  it("keeps the resource when removal is not confirmed", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 0 }, "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("exits the resource menu when the index went stale", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 3 }, ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })
})

describe("controller: pin branch", () => {
  it("clears the pin", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(settings({ pin: { providerID: "prov", id: "a" } })),
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
    // Browse: open receipts → next page → pick the last receipt → detail → leave.
    e.view.selectQueue.push("receipts", "next", many[24], undefined)
    await runAdaptive(e)

    // Page 1 of the browser (selectOptions[0] is the main menu).
    expect(e.view.selectOptions[1]).toHaveLength(21)
    expect(e.view.selectOptions[1]?.at(-1)).toEqual({ title: "Next page", value: "next" })
    // Second page: the remaining 5 receipts, no further page.
    expect(e.view.selectOptions[2]).toHaveLength(5)
    expect(e.view.selectOptions[2]?.some((option) => option.title === "Next page")).toBe(false)
    // The picked receipt's detail was shown.
    expect(e.view.alerts[0]?.title).toContain("#25")
  })
})

describe("controller: cancel and stale paths", () => {
  function tierSettings(refs: { providerID: string; id: string }[]): SettingsV1 {
    return settings({
      mode: "control",
      tiers: { quick: [], standard: refs, advanced: [] },
    })
  }

  it("toasts when the settings patch call itself rejects", async () => {
    const { e, patches } = envWith({
      setSettings: () => Promise.reject(new Error("down")),
    })
    e.view.selectQueue.push("mode", "control", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
    expect(patches).toEqual([])
  })

  it("adds a stale picker pick without consulting variants", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "tiers",
      "standard",
      { kind: "add" },
      { providerID: "ghost", modelID: "x" },
      ...EXIT,
    )
    await runAdaptive(e)
    expect(patches).toEqual([
      {
        tiers: {
          quick: [],
          standard: [{ providerID: "ghost", id: "x" }],
          advanced: [],
        },
      },
    ])
  })

  it("returns to the tier editor when the resource menu is cancelled", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.selectQueue.push("tiers", "standard", { kind: "resource", index: 0 }, undefined, ...EXIT)
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
