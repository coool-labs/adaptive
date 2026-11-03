// @vitest-environment jsdom
// covers: ["ADP-034"]
import { describe, expect, it } from "vitest"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

import guiPlugin, { AdaptiveStatusPage } from "../src/gui.js"
import type { Receipt } from "../src/state/receipts/index.js"
import type { StatusSnapshot } from "../src/rpc.js"
import type { GuiApi } from "../src/ui/gui/api.js"

function tierMap(overrides: Partial<StatusSnapshot["tiers"]> = {}): StatusSnapshot["tiers"] {
  return { quick: [], standard: [], advanced: [], ...overrides }
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: tierMap(),
    parked: 0,
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
  function requiredSetup(): (context: never) => void {
    const setup = guiPlugin.setup
    if (setup === undefined) throw new Error("gui setup was not defined")
    return setup
  }

  function fixture(options: { rpcCalls?: string[]; snapshot?: StatusSnapshot } = {}): {
    added: { registry: unknown; item: unknown }[]
    context: Record<string, unknown>
    openedPage: () => string | undefined
  } {
    const added: { registry: unknown; item: unknown }[] = []
    let opened: string | undefined
    const rpcCalls = options.rpcCalls ?? []
    const context = {
      client: {
        rpc: (definition: unknown) => {
          expect(definition).toBeDefined()
          return {
            "status.get": () => {
              rpcCalls.push("status.get")
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
                return () => undefined
              },
            },
          }
        },
      },
      add: (registry: unknown, item: unknown) => {
        added.push({ registry, item })
      },
      layout: {
        settings: (page: string) => {
          opened = page
        },
      },
    }
    return { added, context, openedPage: () => opened }
  }

  it("registers a settings page and a command that opens it", () => {
    const { added, context, openedPage } = fixture()
    requiredSetup()(context as never)
    expect(added).toHaveLength(2)
    const page = added[0]?.item as { id: string; title: string; entries: unknown[] }
    expect(page.id).toBe("adaptive")
    expect(page.title).toBe("OpenCode Adaptive")
    expect(page.entries).toHaveLength(1)
    const command = added[1]?.item as { id: string; title: string; run: () => void }
    expect(command.id).toBe("open")
    expect(command.title).toBe("OpenCode Adaptive")
    command.run()
    expect(openedPage()).toBe("adaptive")
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
})
