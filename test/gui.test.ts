// @vitest-environment jsdom
// covers: ["ADP-024", "ADP-034"]
import { describe, expect, it, vi } from "vitest"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

import guiPlugin, { AdaptiveStatusPage } from "../src/gui.js"
import type { Receipt } from "../src/state/receipts/index.js"
import type { StatusSnapshot } from "../src/rpc.js"
import { defaultSettings } from "../src/state/settings/index.js"
import type { GuiApi } from "../src/ui/gui/api.js"
import { WAITING_POLL_MS } from "../src/ui/flow/waiting.js"

function tierMap(overrides: Partial<StatusSnapshot["tiers"]> = {}): StatusSnapshot["tiers"] {
  return { quick: [], standard: [], advanced: [], ...overrides }
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: tierMap(),
    parked: 0,
    waiting: [],
    receipts: 0,
    ...overrides,
  }
}

function receipt(id: number): Receipt {
  return {
    id,
    at: 10,
    sessionID: "s1",
    decision: {
      kind: "apply",
      model: { providerID: "prov", id: "a" },
      reason: "preferred",
      evidence: { skipped: [] },
    },
  }
}

interface FakeApiOptions {
  status?: StatusSnapshot
  unreachable?: boolean
  receipts?: Receipt[] | undefined
  updateOk?: boolean
}

function fakeApi(options: FakeApiOptions = {}): {
  api: GuiApi
  updates: unknown[]
  listeners: (() => void)[]
  unsubscribed: () => boolean
} {
  const updates: unknown[] = []
  const listeners: (() => void)[] = []
  let removed = false
  const api: GuiApi = {
    status: () =>
      Promise.resolve(options.unreachable === true ? undefined : (options.status ?? snapshot())),
    waiting: () => Promise.resolve({}),
    receipts: () => Promise.resolve("receipts" in options ? options.receipts : []),
    update: (patch) => {
      updates.push(patch)
      return Promise.resolve(options.updateOk ?? true)
    },
    watchSettings: (onChange) => {
      listeners.push(onChange)
      return () => {
        removed = true
      }
    },
  }
  return { api, updates, listeners, unsubscribed: () => removed }
}

function requiredSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector("select")
  if (select === null) throw new Error("mode select was not rendered")
  return select
}

async function mountPage(api: GuiApi): Promise<{ container: HTMLElement; dispose: () => void }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => createComponent(AdaptiveStatusPage, { api }), container)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return { container, dispose }
}

describe("AdaptiveStatusPage", () => {
  it("renders the status rows for a live snapshot", async () => {
    const { api } = fakeApi({
      status: snapshot({
        mode: "active",
        pin: { providerID: "prov", id: "p" },
        tiers: tierMap({
          standard: [
            {
              ref: { providerID: "prov", id: "a" },
              health: "healthy",
              breaker: "closed",
              windowed: false,
              windowUntil: null,
              usedPercent: null,
              resetAt: null,
            },
          ],
        }),
        parked: 3,
        waiting: [],
        receipts: 9,
      }),
    })
    const { container, dispose } = await mountPage(api)
    const text = container.textContent
    expect(text).toContain("active")
    expect(text).toContain("prov/p")
    expect(text).toContain("prov/a")
    expect(text).toContain("3")
    expect(text).toContain("9")
    expect(text).not.toContain("disconnected")
    dispose()
  })

  it("renders the disconnected row and disables the mode select when the server is unreachable", async () => {
    const { api } = fakeApi({ unreachable: true })
    const { container, dispose } = await mountPage(api)
    expect(container.textContent).toContain("disconnected")
    expect(requiredSelect(container).disabled).toBe(true)
    expect(container.querySelector(".adaptive-receipts")).toBeNull()
    dispose()
  })

  it("updates the mode through the api and confirms the save", async () => {
    const { api, updates } = fakeApi()
    const { container, dispose } = await mountPage(api)
    const select = requiredSelect(container)
    select.value = "active"
    select.dispatchEvent(new Event("change"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(updates).toEqual([{ mode: "active" }])
    expect(container.querySelector(".adaptive-saved")?.textContent).toBe("Saved")
    dispose()
  })

  it("ignores an unknown select value without calling update", async () => {
    const { api, updates } = fakeApi()
    const { container, dispose } = await mountPage(api)
    const select = requiredSelect(container)
    select.value = "bogus"
    select.dispatchEvent(new Event("change"))
    await Promise.resolve()
    expect(updates).toEqual([])
    dispose()
  })

  it("keeps the saved indicator off when the update fails", async () => {
    const { api } = fakeApi({ updateOk: false })
    const { container, dispose } = await mountPage(api)
    const select = requiredSelect(container)
    select.value = "off"
    select.dispatchEvent(new Event("change"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(container.querySelector(".adaptive-saved")).toBeNull()
    expect(select.value).toBe("observe")
    dispose()
  })

  it("previews at most five receipts", async () => {
    const { api } = fakeApi({
      receipts: [
        receipt(1),
        receipt(2),
        receipt(3),
        receipt(4),
        receipt(5),
        receipt(6),
        receipt(7),
      ],
    })
    const { container, dispose } = await mountPage(api)
    const lines = container.querySelectorAll(".adaptive-receipt-line")
    expect(lines).toHaveLength(5)
    dispose()
  })

  it("refreshes when the settings-changed event fires", async () => {
    let current: StatusSnapshot = snapshot({ mode: "observe" })
    const { api, listeners } = fakeApi()
    api.status = () => Promise.resolve(current)
    const { container, dispose } = await mountPage(api)
    expect(listeners).toHaveLength(1)
    expect(container.textContent).toContain("observe")
    current = snapshot({ mode: "active" })
    listeners[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(container.textContent).toContain("active")
    dispose()
  })

  it("unsubscribes from the settings event on dispose", async () => {
    const { api, unsubscribed } = fakeApi()
    const { dispose } = await mountPage(api)
    expect(unsubscribed()).toBe(false)
    dispose()
    expect(unsubscribed()).toBe(true)
  })

  it("handles a receipts read failure as an empty preview", async () => {
    const { api } = fakeApi({ receipts: undefined })
    const { container, dispose } = await mountPage(api)
    expect(container.querySelectorAll(".adaptive-receipt-line")).toHaveLength(0)
    dispose()
  })
})

describe("gui entry", () => {
  function requiredSetup(): (context: never) => (() => void) | undefined {
    const setup = guiPlugin.setup
    if (setup === undefined) throw new Error("gui setup was not defined")
    return setup as (context: never) => (() => void) | undefined
  }

  function fixture(
    options: {
      rpcCalls?: string[]
      statusOptions?: unknown[]
      snapshot?: StatusSnapshot
      session?: unknown
      statusFails?: () => boolean
      unwatched?: string[]
    } = {},
  ): {
    added: { registry: unknown; item: unknown }[]
    context: Record<string, unknown>
    menus: () => string[]
  } {
    const added: { registry: unknown; item: unknown }[] = []
    const menus: string[] = []
    const rpcCalls = options.rpcCalls ?? []
    const context = {
      client: {
        rpc: (definition: unknown) => {
          expect(definition).toBeDefined()
          return {
            "settings.get": () => Promise.resolve({ ...defaultSettings(), inviteDismissed: true }),
            "status.get": (_input: unknown, callOptions: unknown) => {
              rpcCalls.push("status.get")
              options.statusOptions?.push(callOptions)
              if (options.statusFails?.() === true) return Promise.reject(new Error("gone"))
              return Promise.resolve(options.snapshot ?? snapshot())
            },
            "receipts.list": () => {
              rpcCalls.push("receipts.list")
              return Promise.resolve([])
            },
            "settings.set": () => Promise.resolve({ ok: true, errors: [] }),
            events: {
              on: (name: string) => {
                rpcCalls.push(name)
                return () => {
                  options.unwatched?.push(name)
                }
              },
            },
          }
        },
      },
      add: (registry: unknown, item: unknown) => {
        added.push({ registry, item })
      },
      sessions: { current: () => options.session },
      servers: { list: () => [], get: () => undefined },
      dialogs: {
        select: (selection: { title: string }) => {
          menus.push(selection.title)
          return Promise.resolve(undefined)
        },
      },
    }
    return { added, context, menus: () => menus }
  }

  it("registers a settings page and a command that opens the /adaptive menu", async () => {
    const { added, context, menus } = fixture()
    requiredSetup()(context as never)
    expect(added).toHaveLength(3)
    const page = added[0]?.item as { id: string; title: string; entries: unknown[] }
    expect(page.id).toBe("adaptive")
    expect(page.title).toBe("OpenCode Adaptive")
    expect(page.entries).toHaveLength(1)
    const command = added[1]?.item as {
      id: string
      title: string
      slash?: { name: string }
      suggested?: boolean
      run: () => Promise<void>
    }
    expect(command.id).toBe("open")
    expect(command.title).toBe("OpenCode Adaptive")
    // Without `slash` the command only reaches the palette: /adaptive never shows in the composer.
    expect(command.slash).toEqual({ name: "adaptive" })
    expect(command.suggested).toBe(true)
    await command.run()
    // The command drives the same dialog flow as the TUI, not just the settings page.
    expect(menus()).toEqual(["Adaptive (observe)"])
  })

  it("reads the settings page through the open session's location (project-local installs)", async () => {
    const statusOptions: unknown[] = []
    const { added, context } = fixture({
      statusOptions,
      session: {
        id: "ses_1",
        server: { builtin: true },
        location: { directory: "/work/app" },
      },
    })
    requiredSetup()(context as never)
    const page = added[0]?.item as { render: () => unknown }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const disposeRoot = render(() => page.render() as Element, container)
    await Promise.resolve()
    await Promise.resolve()
    // The waiting pill's boot read and the page's read both carry the session's location.
    expect(statusOptions).toEqual([
      { location: { directory: "/work/app" } },
      { location: { directory: "/work/app" } },
    ])
    disposeRoot()
  })

  it("renders the registered page against the typed RPC client", async () => {
    const rpcCalls: string[] = []
    const { added, context } = fixture({ rpcCalls, snapshot: snapshot({ mode: "active" }) })
    requiredSetup()(context as never)
    const page = added[0]?.item as { render: () => unknown }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const disposeRoot = render(() => page.render() as Element, container)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(rpcCalls).toContain("settings-changed")
    expect(rpcCalls).toContain("status.get")
    expect(container.textContent).toContain("active")
    disposeRoot()
  })

  describe("waiting pill (ADP-024)", () => {
    interface Pill {
      id: string
      show: (input: {
        session: { id: string }
      }) => { label: string; icon?: string; tone?: string; title?: string } | undefined
    }

    function pillOf(added: { item: unknown }[]): Pill {
      return added[2]?.item as Pill
    }

    const RESUME_AT = new Date(2026, 10, 7, 18, 42).getTime()
    const parked = snapshot({
      mode: "active",
      parked: 2,
      waiting: [
        { sessionID: "ses_1", tier: "standard", resumeAt: RESUME_AT },
        { sessionID: "ses_2", tier: "advanced", resumeAt: null },
      ],
    })

    it("shows a warning pill on parked sessions only", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(2026, 10, 7, 14, 5))
      try {
        const { added, context } = fixture({ snapshot: parked })
        requiredSetup()(context as never)
        const pill = pillOf(added)
        expect(pill.id).toBe("waiting")
        // Before the first read lands nothing is known to wait.
        expect(pill.show({ session: { id: "ses_1" } })).toBeUndefined()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(pill.show({ session: { id: "ses_1" } })).toEqual({
          label: "Waiting · resumes 18:42",
          icon: "status",
          tone: "warning",
          title: "Waiting for quota: Adaptive continues this session automatically",
        })
        expect(pill.show({ session: { id: "ses_2" } })?.label).toBe("Waiting")
        expect(pill.show({ session: { id: "ses_3" } })).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it("polls, keeps the last state through a failed read, and stops on cleanup", async () => {
      vi.useFakeTimers()
      try {
        const rpcCalls: string[] = []
        const unwatched: string[] = []
        let failing = false
        const { added, context } = fixture({
          rpcCalls,
          unwatched,
          snapshot: parked,
          statusFails: () => failing,
        })
        const cleanup = requiredSetup()(context as never)
        if (cleanup === undefined) throw new Error("gui setup did not return a cleanup")
        await vi.advanceTimersByTimeAsync(0)
        const reads = (): number => rpcCalls.filter((call) => call === "status.get").length
        expect(reads()).toBe(1)
        failing = true
        await vi.advanceTimersByTimeAsync(WAITING_POLL_MS)
        expect(reads()).toBe(2)
        // A failed read is not "nothing waits": the pill stays until a read says otherwise.
        expect(pillOf(added).show({ session: { id: "ses_1" } })?.tone).toBe("warning")
        cleanup()
        expect(unwatched).toEqual(["settings-changed"])
        await vi.advanceTimersByTimeAsync(3 * WAITING_POLL_MS)
        expect(reads()).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("shows nothing for a server that predates waiting sessions", async () => {
      const rejections: unknown[] = []
      const onRejection = (reason: unknown): void => {
        rejections.push(reason)
      }
      process.on("unhandledRejection", onRejection)
      try {
        const older = { ...parked }
        Reflect.deleteProperty(older, "waiting")
        const { added, context } = fixture({ snapshot: older })
        requiredSetup()(context as never)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(pillOf(added).show({ session: { id: "ses_1" } })).toBeUndefined()
        expect(rejections).toEqual([])
      } finally {
        process.off("unhandledRejection", onRejection)
      }
    })
  })
})
