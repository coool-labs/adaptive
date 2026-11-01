// covers: ["ADP-032", "ADP-033"]
import { describe, expect, it } from "vitest"

import { INVITE_MESSAGE, INVITE_TITLE, runAdaptive } from "../../../src/ui/tui/controller.js"
import { errorText } from "../../../src/ui/tui/options.js"
import { HEALTH_EMPTY_MESSAGE, healthDetail } from "../../../src/ui/tui/status.js"
import type { Receipt } from "../../../src/state/receipts/index.js"
import type { SettingsPatch, SettingsV1 } from "../../../src/state/settings/index.js"
import type { PatchResult } from "../../../src/state/settings/index.js"
import type { AdaptiveApi, AdaptiveView } from "../../../src/ui/tui/controller.js"
import type { ModelSummary } from "../../../src/ui/tui/tiers.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc/status.js"

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

function resource(overrides: Partial<TierResourceStatus> = {}): TierResourceStatus {
  return {
    ref: { providerID: "prov", id: "m1" },
    health: "rate_limited",
    breaker: "closed",
    windowed: true,
    windowUntil: null,
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
})

describe("controller: main menu", () => {
  it("exits immediately on a nil choice", async () => {
    const e = env()
    e.view.selectQueue.push(...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })
})

describe("controller: health branch", () => {
  it("lists configured resources and opens the browsable detail", async () => {
    const snapshot = statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } })
    const e = env({ api: fakeApi({ status: () => Promise.resolve(snapshot) }) })
    const picked = { tier: "standard" as const, status: resource() }
    e.view.selectQueue.push("health", picked, "back", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.title).toBe("Health: prov/m1")
    expect(e.view.alerts[0]?.message).toBe(healthDetail(picked, snapshot))
    // The detail is followed by actions, not a dead end.
    expect(e.view.selectOptions[2]?.map((o) => o.title)).toEqual([
      "Pin this resource",
      "Show receipts for this resource",
      "Back",
    ])
  })

  it("alerts the empty state when nothing is configured", async () => {
    const e = env()
    e.view.selectQueue.push("health", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts[0]?.message).toBe(HEALTH_EMPTY_MESSAGE)
  })

  it("pins the resource from the health view", async () => {
    const { e, patches } = envWith({
      status: () =>
        Promise.resolve(
          statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } }),
        ),
    })
    e.view.selectQueue.push("health", { tier: "standard", status: resource() }, "pin", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ pin: { providerID: "prov", id: "m1" } }])
    expect(e.view.toasts.some((t) => t.message === "Settings saved")).toBe(true)
  })

  it("alerts and stays in the health view when the pin patch is rejected", async () => {
    const e = env({
      api: {
        ...fakeApi({
          status: () =>
            Promise.resolve(
              statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } }),
            ),
        }),
        setSettings: () => Promise.resolve({ ok: false, errors: ["pin refused"] }),
      },
    })
    e.view.selectQueue.push("health", { tier: "standard", status: resource() }, "pin", ...EXIT)
    await runAdaptive(e)
    expect(e.view.alerts.some((a) => a.title === "Invalid settings")).toBe(true)
  })

  it("shows the filtered empty state when the resource has no receipts", async () => {
    const e = env({
      api: fakeApi({
        status: () =>
          Promise.resolve(
            statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } }),
          ),
        receipts: () => Promise.resolve([]),
      }),
    })
    e.view.selectQueue.push(
      "health",
      { tier: "standard", status: resource() },
      "receipts",
      undefined,
    )
    await runAdaptive(e)
    expect(e.view.alerts.some((a) => a.message === "No decisions recorded for prov/m1.")).toBe(true)
  })

  it("filters receipts for the picked resource", async () => {
    const apply = receipt({
      id: 2,
      decision: {
        kind: "apply",
        model: { providerID: "prov", id: "m1" },
        tier: "standard",
        reason: "preferred",
        evidence: { skipped: [] },
      },
    })
    const other = receipt({
      id: 3,
      decision: {
        kind: "apply",
        model: { providerID: "prov", id: "zz" },
        tier: "standard",
        reason: "preferred",
        evidence: { skipped: [] },
      },
    })
    const escalated = receipt({
      id: 4,
      decision: {
        kind: "escalate",
        target: { providerID: "prov", id: "m1" },
        step: "tier",
        tier: "advanced",
        evidence: [],
        budgetRemaining: 1,
      },
    })
    const observed = receipt({
      id: 5,
      decision: {
        kind: "observe-only",
        would: {
          kind: "apply",
          model: { providerID: "prov", id: "m1" },
          tier: "standard",
          reason: "preferred",
          evidence: { skipped: [] },
        },
      },
    })
    const parked = receipt({
      id: 6,
      decision: { kind: "park", reason: "all-blocked", detail: "every candidate blocked" },
    })
    const e = env({
      api: fakeApi({
        status: () =>
          Promise.resolve(
            statusSnapshot({ tiers: { quick: [], standard: [resource()], advanced: [] } }),
          ),
        receipts: () => Promise.resolve([apply, other, escalated, observed, parked]),
      }),
    })
    e.view.selectQueue.push(
      "health",
      { tier: "standard", status: resource() },
      "receipts",
      undefined,
      ...EXIT,
    )
    await runAdaptive(e)
    // The receipts browser shows every decision about the picked resource
    // (its apply, the escalation to it, and an observe-only decision about
    // it) and hides the rest.
    expect(e.view.selectOptions[3]?.map((o) => o.title)).toEqual([
      expect.stringContaining("#2"),
      expect.stringContaining("#4"),
      expect.stringContaining("#5"),
    ])
  })

  it("toasts when the health view cannot load status, while the menu stays silent", async () => {
    const e = env({ api: failingApi("status", new Error("down")) })
    e.view.selectQueue.push("health", ...EXIT)
    await runAdaptive(e)
    // The menu descriptions degrade silently; the health view's own fetch toasts.
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
    e.view.selectQueue.push("mode", "active", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ mode: "active" }])
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

  it("returns to the tier menu on back", async () => {
    const e = env()
    e.view.selectQueue.push("models", "standard", { kind: "back" }, ...EXIT)
    await runAdaptive(e)
    expect(e.view.selectQueue.length).toBe(0)
  })

  it("adds a model with a chosen variant", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "models",
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
      "models",
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
      "models",
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
      { providerID: "prov", modelID: "b" },
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
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 1 }, "up", ...EXIT)
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
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 2 }, "top", ...EXIT)
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
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 0 }, "down", ...EXIT)
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
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 0 }, "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([{ tiers: { quick: [], standard: [], advanced: [] } }])
  })

  it("keeps the resource when removal is not confirmed", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.confirmQueue.push(false)
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 0 }, "remove", ...EXIT)
    await runAdaptive(e)
    expect(patches).toEqual([])
  })

  it("exits the resource menu when the index went stale", async () => {
    const { e, patches } = envWith({
      settings: () => Promise.resolve(tierSettings([{ providerID: "prov", id: "a" }])),
    })
    e.view.selectQueue.push("models", "standard", { kind: "resource", index: 3 }, ...EXIT)
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
        setSettings: (patch) => {
          patches.push(patch)
          current = { ...current, ...patch, version: 1 } as SettingsV1
          return Promise.resolve({ ok: true, settings: current } satisfies PatchResult)
        },
      }),
    })
    e.view.selectQueue.push(
      "mode",
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
      mode: "active",
      tiers: { quick: [], standard: refs, advanced: [] },
    })
  }

  it("toasts when the settings patch call itself rejects", async () => {
    const { e, patches } = envWith({
      setSettings: () => Promise.reject(new Error("down")),
    })
    e.view.selectQueue.push("mode", "active", ...EXIT)
    await runAdaptive(e)
    expect(e.view.toasts.map((t) => t.message)).toEqual(["down"])
    expect(patches).toEqual([])
  })

  it("adds a stale picker pick without consulting variants", async () => {
    const { e, patches } = envWith()
    e.view.selectQueue.push(
      "models",
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
    e.view.selectQueue.push(
      "models",
      "standard",
      { kind: "resource", index: 0 },
      undefined,
      ...EXIT,
    )
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
