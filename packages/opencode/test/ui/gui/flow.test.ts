// @vitest-environment jsdom
// covers: ["ADP-033", "ADP-034"]
import { describe, expect, it } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

import { guiFlowApi, guiView, openAdaptive } from "../../../src/ui/gui/flow.js"
import type { FlowHost } from "../../../src/ui/gui/flow.js"
import { defaultSettings } from "@coool/adaptive-core/state/settings/index"

interface Selection {
  title: string
  options: { title: string; value: unknown; description?: string }[]
  placeholder?: string
  current?: unknown
}

interface FakeOptions {
  /** Scripted `dialogs.select` answers by exact title or title prefix; consumed in order. */
  answers?: Record<string, unknown[]>
  session?: { id: string; builtin: boolean; directory?: string }
  builtinServer?: boolean
  syncFails?: boolean
  selectFails?: boolean
  status?: unknown
  models?: { providerID: string; modelID: string; name: string; variants: { id: string }[] }[]
}

function fakeHost(options: FakeOptions = {}) {
  const rpcCalls: { method: string; input: unknown; options: unknown }[] = []
  const selections: Selection[] = []
  const toasts: { title: string; variant?: string }[] = []
  const syncs: unknown[] = []
  const lists: unknown[] = []
  const opened: ((dialog: { close: () => void }) => unknown)[] = []
  const answers = options.answers ?? {}
  const call = (method: string, output: unknown) => (input: unknown, callOptions: unknown) => {
    rpcCalls.push({ method, input, options: callOptions })
    return Promise.resolve(output)
  }
  const status = { mode: "observe", pin: null, tiers: { quick: [], standard: [], advanced: [] } }
  const rpc = {
    "settings.get": call("settings.get", { ...defaultSettings(), inviteDismissed: true }),
    "status.get": call("status.get", options.status ?? status),
    "health.reset": call("health.reset", undefined),
    "parked.resume": call("parked.resume", "resumed"),
    "parked.cancel": call("parked.cancel", "cancelled"),
    "doctor.run": call("doctor.run", []),
    "receipts.list": call("receipts.list", []),
    "session-mode.get": call("session-mode.get", { mode: null }),
    "tier-request.get": call("tier-request.get", { tier: "advanced" }),
    "settings.set": call("settings.set", { ok: true, errors: [] }),
    "session-mode.set": call("session-mode.set", { ok: true, errors: [] }),
    "tier-request.set": call("tier-request.set", { ok: true, errors: [] }),
  }
  const host = {
    client: { rpc: () => rpc },
    toast: {
      show: (toast: { title: string; variant?: string }) => {
        toasts.push(toast)
      },
    },
    sessions: {
      current: () =>
        options.session === undefined
          ? undefined
          : {
              id: options.session.id,
              server: { builtin: options.session.builtin },
              location:
                options.session.directory === undefined
                  ? undefined
                  : { directory: options.session.directory },
            },
    },
    servers: {
      list: () => ["other", "local"],
      get: (id: string) =>
        id === "other" || options.builtinServer === false
          ? { builtin: false }
          : {
              builtin: true,
              data: {
                location: {
                  model: {
                    sync: (ref: unknown) => {
                      syncs.push(ref)
                      return options.syncFails === true
                        ? Promise.reject(new Error("offline"))
                        : Promise.resolve()
                    },
                    list: (ref: unknown) => {
                      lists.push(ref)
                      return options.models
                    },
                  },
                },
              },
            },
    },
    dialogs: {
      select: (selection: Selection) => {
        selections.push(selection)
        if (options.selectFails === true) return Promise.reject(new Error("dialog broke"))
        const queue = answers[selection.title] ?? []
        const answer = queue.shift()
        return Promise.resolve(
          typeof answer === "object" && answer !== null && "pick" in answer
            ? selection.options.find((option) => option.title === answer.pick)?.value
            : answer,
        )
      },
      confirm: () => Promise.resolve(true),
      alert: () => Promise.resolve(),
      open: (render: (dialog: { close: () => void }) => unknown) => {
        opened.push(render)
        return { close: () => undefined }
      },
    },
    ui: {
      Dialog: (props: { title: string; children: JSX.Element; footer: JSX.Element }) => {
        const root = document.createElement("section")
        root.append(props.title, props.children as Node, props.footer as Node)
        return root
      },
      Button: (props: { onClick: () => void; children: JSX.Element }) => {
        const button = document.createElement("button")
        button.append(props.children as Node)
        button.addEventListener("click", props.onClick)
        return button
      },
    },
  }
  return {
    host: host as unknown as FlowHost,
    rpcCalls,
    selections,
    toasts,
    syncs,
    lists,
    opened,
  }
}

describe("guiView over the host dialogs", () => {
  it("forwards a select with its optional placeholder", async () => {
    const { host, selections } = fakeHost({ answers: { Pick: ["b", "c"] } })
    const view = guiView(host)
    const options = [
      { title: "A", value: "a" },
      { title: "B", value: "b", description: "second" },
    ]
    await expect(view.select({ title: "Pick", placeholder: "Search", options })).resolves.toBe("b")
    await expect(view.select({ title: "Pick", options })).resolves.toBe("c")
    expect(selections[0]).toMatchObject({ placeholder: "Search" })
    expect(selections[1]).not.toHaveProperty("placeholder")
  })

  it("reports a paged select as a pick, an action, or a dismissal", async () => {
    const { host, selections } = fakeHost({
      answers: {
        Receipts: [{ kind: "pick", value: 7 }, { kind: "action", value: "next" }, undefined],
      },
    })
    const view = guiView(host)
    const spec = {
      title: "Receipts",
      options: [
        { title: "one", value: 7 },
        { title: "two", value: 8 },
      ],
      actions: [{ title: "Next page", value: "next", bind: "ctrl+f" }],
    }
    await expect(view.selectPaged(spec)).resolves.toEqual({ picked: 7, action: undefined })
    await expect(view.selectPaged(spec)).resolves.toEqual({ picked: undefined, action: "next" })
    await expect(view.selectPaged(spec)).resolves.toEqual({
      picked: undefined,
      action: undefined,
    })
    expect(selections[0]?.options.map((option) => option.title)).toEqual([
      "one",
      "two",
      "Next page",
    ])
  })

  it("maps confirm and alert text onto the host description", async () => {
    const calls: unknown[] = []
    const { host } = fakeHost()
    Object.assign(host.dialogs, {
      confirm: (options: unknown) => {
        calls.push(options)
        return Promise.resolve(false)
      },
      alert: (options: unknown) => {
        calls.push(options)
        return Promise.resolve()
      },
    })
    const view = guiView(host)
    await expect(view.confirm({ title: "Remove?", message: "Gone for good" })).resolves.toBe(false)
    await view.confirm({ title: "Plain", message: "m" })
    await view.alert({ title: "Oops", message: "details" })
    expect(calls).toEqual([
      { title: "Remove?", description: "Gone for good" },
      { title: "Plain", description: "m" },
      { title: "Oops", description: "details" },
    ])
  })

  it("passes toast variants to the host", () => {
    const { host, toasts } = fakeHost()
    const view = guiView(host)
    view.toast("saved", "success")
    view.toast("broke", "error")
    expect(toasts.map((toast) => toast.variant)).toEqual(["success", "error"])
    expect(toasts.map((toast) => toast.title)).toEqual(["saved", "broke"])
  })

  function mountTable(opened: ((dialog: { close: () => void }) => unknown)[], close: () => void) {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const render_ = opened[0]
    if (render_ === undefined) throw new Error("no dialog opened")
    const dispose = render(() => render_({ close }) as Node, container)
    return { container, dispose }
  }

  it("resolves the table when its Close button is pressed", async () => {
    const { host, opened } = fakeHost()
    let closed = false
    const shown = guiView(host).table({ title: "Status", lines: ["A  B", "1  2"] })
    let done = false
    void shown.then(() => {
      done = true
    })
    const { container, dispose } = mountTable(opened, () => {
      closed = true
      dispose()
    })
    expect(container.textContent).toContain("Status")
    expect(container.querySelector("pre")?.textContent).toBe("A  B\n1  2")
    container.querySelector("button")?.click()
    await shown
    expect(closed).toBe(true)
    expect(done).toBe(true)
  })

  it("resolves the table when the dialog unmounts without the button (Escape)", async () => {
    const { host, opened } = fakeHost()
    const shown = guiView(host).table({ title: "Status", lines: ["x"] })
    const { dispose } = mountTable(opened, () => undefined)
    dispose()
    await expect(shown).resolves.toBeUndefined()
  })
})

describe("openAdaptive", () => {
  it("wires health, parked controls and doctor to the current location", async () => {
    const ref = { providerID: "prov", id: "a" }
    const f = fakeHost({
      session: { id: "s1", builtin: true, directory: "/project" },
      status: {
        mode: "observe",
        pin: null,
        parked: 1,
        receipts: 0,
        waiting: [{ sessionID: "s1", tier: "standard", resumeAt: null }],
        tiers: {
          quick: [],
          advanced: [],
          standard: [
            {
              ref,
              health: "healthy",
              breaker: "closed",
              windowed: false,
              windowUntil: null,
              usedPercent: null,
              resetAt: null,
            },
          ],
        },
      },
      answers: {
        "Adaptive (observe)": [
          { pick: "Health" },
          { pick: "Parked work" },
          { pick: "Doctor" },
          { pick: "Parked work" },
        ],
        "Health · select a model to reset": [ref],
        "Parked work": ["s1", "s1"],
        "This session's parked work": [{ pick: "Cancel" }, { pick: "Resume now" }],
      },
    })
    const running = openAdaptive(f.host)
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve()
    const show = f.opened[0]
    if (show === undefined) throw new Error("doctor dialog missing")
    const container = document.createElement("div")
    const dispose = render(
      () =>
        show({
          close: () => {
            dispose()
          },
        }) as Node,
      container,
    )
    expect(container.textContent).toContain("Adaptive doctor")
    container.querySelector("button")?.click()
    await running
    dispose()
    const actions = f.rpcCalls.filter((call) =>
      ["health.reset", "parked.cancel", "parked.resume", "doctor.run"].includes(call.method),
    )
    expect(actions.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: "health.reset", input: ref },
      { method: "parked.cancel", input: { sessionID: "s1" } },
      { method: "doctor.run", input: undefined },
      { method: "parked.resume", input: { sessionID: "s1" } },
    ])
    expect(
      actions.every(
        (call) =>
          JSON.stringify(call.options) === JSON.stringify({ location: { directory: "/project" } }),
      ),
    ).toBe(true)
  })

  const modelInfo = [
    { providerID: "prov", modelID: "a", name: "Model A", variants: [{ id: "high" }] },
  ]

  it("runs the shared flow home-side: no session, no location, picker fed by the catalog", async () => {
    const { host, rpcCalls, selections, syncs, lists } = fakeHost({
      models: modelInfo,
      answers: {
        "Adaptive (observe)": ["models", undefined],
        Tier: ["standard", undefined],
        "Tier: standard": [{ kind: "add" }, undefined],
      },
    })
    await openAdaptive(host)
    expect(rpcCalls.length).toBeGreaterThan(0)
    expect(rpcCalls.every((entry) => JSON.stringify(entry.options) === "{}")).toBe(true)
    expect(rpcCalls.some((entry) => entry.method === "session-mode.get")).toBe(false)
    expect(syncs).toEqual([undefined])
    expect(lists).toEqual([undefined])
    const picker = selections.find((selection) => selection.title === "Add model")
    expect(picker?.options).toEqual([
      {
        title: "prov/a",
        description: "Model A",
        value: { providerID: "prov", modelID: "a", name: "Model A", variants: ["high"] },
      },
    ])
  })

  it("steers the plugin server's session and carries its directory on every call", async () => {
    const { host, rpcCalls, syncs } = fakeHost({
      session: { id: "ses_1", builtin: true, directory: "/work/app" },
      answers: { "Adaptive (observe)": [undefined] },
    })
    await openAdaptive(host)
    expect(syncs).toEqual([{ directory: "/work/app" }])
    const sessionCall = rpcCalls.find((entry) => entry.method === "session-mode.get")
    expect(sessionCall?.input).toEqual({ sessionID: "ses_1" })
    expect(
      rpcCalls.every(
        (entry) => JSON.stringify(entry.options) === '{"location":{"directory":"/work/app"}}',
      ),
    ).toBe(true)
  })

  it("ignores a session whose server is not the plugin's and one without a location", async () => {
    const foreign = fakeHost({ session: { id: "ses_f", builtin: false } })
    await openAdaptive(foreign.host)
    expect(foreign.rpcCalls.some((entry) => entry.method === "session-mode.get")).toBe(false)

    const unlocated = fakeHost({
      session: { id: "ses_u", builtin: true },
      answers: { "Adaptive (observe)": [undefined] },
    })
    await openAdaptive(unlocated.host)
    expect(unlocated.rpcCalls.some((entry) => entry.method === "session-mode.get")).toBe(true)
    expect(unlocated.rpcCalls.every((entry) => JSON.stringify(entry.options) === "{}")).toBe(true)
  })

  it("still opens the flow when the catalog cannot sync or the plugin server is not listed", async () => {
    const offline = fakeHost({ syncFails: true, answers: { "Adaptive (observe)": [undefined] } })
    await openAdaptive(offline.host)
    expect(offline.selections.map((selection) => selection.title)).toEqual(["Adaptive (observe)"])

    const unlisted = fakeHost({
      builtinServer: false,
      answers: {
        "Adaptive (observe)": ["models", undefined],
        Tier: ["standard", undefined],
        "Tier: standard": [{ kind: "add" }, undefined],
      },
    })
    await openAdaptive(unlisted.host)
    expect(unlisted.selections.find((entry) => entry.title === "Add model")?.options).toEqual([])
  })

  it("toasts a failure of the flow itself instead of throwing", async () => {
    const { host, toasts } = fakeHost({ selectFails: true })
    await expect(openAdaptive(host)).resolves.toBeUndefined()
    expect(toasts).toEqual([{ title: "dialog broke", variant: "error" }])
  })
})

describe("guiFlowApi", () => {
  it("maps each flow call onto its typed RPC method with the session location", async () => {
    const { host, rpcCalls } = fakeHost({
      session: { id: "ses_1", builtin: true, directory: "/work/app" },
    })
    const api = guiFlowApi(host)
    await api.settings()
    await api.setSettings({ mode: "active" })
    await api.status()
    await api.receipts()
    await expect(api.sessionMode("ses_1")).resolves.toBeNull()
    await api.setSessionMode("ses_1", "off")
    await expect(api.tierRequest("ses_1")).resolves.toBe("advanced")
    await api.setTierRequest("ses_1", null)
    expect(rpcCalls.map((entry) => [entry.method, entry.input])).toEqual([
      ["settings.get", undefined],
      ["settings.set", { mode: "active" }],
      ["status.get", undefined],
      ["receipts.list", undefined],
      ["session-mode.get", { sessionID: "ses_1" }],
      ["session-mode.set", { sessionID: "ses_1", mode: "off" }],
      ["tier-request.get", { sessionID: "ses_1" }],
      ["tier-request.set", { sessionID: "ses_1", tier: null }],
    ])
    expect(rpcCalls.every((entry) => JSON.stringify(entry.options).includes("/work/app"))).toBe(
      true,
    )
  })
})
