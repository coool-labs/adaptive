// covers: ["ADP-034", "ADP-036"]
import { describe, expect, it, vi } from "vitest"

import { adaptiveGuiApi } from "../../../src/ui/gui/api.js"
import { defaultSettings } from "../../../src/state/settings/index.js"

interface FakeClientOptions {
  failStatus?: boolean
  failReceipts?: boolean
  failUpdate?: boolean
  updateResult?: { ok: boolean; errors?: string[] }
}

interface RegisteredHandler {
  handler?: () => void
  unregistered?: boolean
}

interface FakeRpcClient {
  "status.get": (input?: unknown, callOptions?: unknown) => Promise<unknown>
  "receipts.list": (input?: unknown, callOptions?: unknown) => Promise<unknown>
  "settings.set": (input?: unknown, callOptions?: unknown) => Promise<unknown>
  events: { on: (name: string, handler: () => void) => () => void }
}

function fakeClient(options: FakeClientOptions = {}): {
  client: unknown
  handlers: FakeRpcClient & RegisteredHandler
  onCalls: string[]
  callOptions: unknown[]
} {
  const onCalls: string[] = []
  const callOptions: unknown[] = []
  const handlers: FakeRpcClient & RegisteredHandler = {
    "status.get": (_input, at) => {
      callOptions.push(at)
      return options.failStatus === true
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(defaultSettings())
    },
    "receipts.list": (_input, at) => {
      callOptions.push(at)
      return options.failReceipts === true
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve([])
    },
    "settings.set": (_input, at) => {
      callOptions.push(at)
      return options.failUpdate === true
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(options.updateResult ?? { ok: true, errors: [] })
    },
    events: {
      on: (name: string, handler: () => void) => {
        onCalls.push(name)
        handlers.handler = handler
        return () => {
          handlers.unregistered = true
        }
      },
    },
  }
  const client = {
    rpc: (definition: unknown) => {
      expect(definition).toBeDefined()
      return handlers
    },
  }
  return { client, handlers, onCalls, callOptions }
}

const noLocation = () => ({})

describe("adaptiveGuiApi", () => {
  it("carries the location on every call so a project-local install is reachable", async () => {
    const { client, callOptions } = fakeClient()
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], () => ({
      location: { directory: "/work/app" },
    }))
    await api.status()
    await api.receipts()
    await api.update({ mode: "active" })
    expect(callOptions).toEqual(Array(3).fill({ location: { directory: "/work/app" } }))
  })

  it("delegates status and receipts to the typed RPC client", async () => {
    const { client } = fakeClient()
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], noLocation)
    await expect(api.status()).resolves.toEqual(defaultSettings())
    await expect(api.receipts()).resolves.toEqual([])
  })

  it("resolves undefined when reads reject (disconnect-safe)", async () => {
    const { client } = fakeClient({ failStatus: true, failReceipts: true })
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], noLocation)
    await expect(api.status()).resolves.toBeUndefined()
    await expect(api.receipts()).resolves.toBeUndefined()
  })

  it("update returns the ok flag of the patch result", async () => {
    const { client } = fakeClient()
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], noLocation)
    await expect(api.update({ mode: "active" })).resolves.toBe(true)
    const failing = fakeClient({ updateResult: { ok: false, errors: ["invalid mode"] } })
    const failingApi = adaptiveGuiApi(
      failing.client as Parameters<typeof adaptiveGuiApi>[0],
      noLocation,
    )
    await expect(failingApi.update({ mode: "active" })).resolves.toBe(false)
  })

  it("update returns false when the call rejects (disconnect-safe)", async () => {
    const { client } = fakeClient({ failUpdate: true })
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], noLocation)
    await expect(api.update({ mode: "active" })).resolves.toBe(false)
  })

  it("subscribes to the settings-changed event and forwards it", () => {
    const { client, handlers, onCalls } = fakeClient()
    const api = adaptiveGuiApi(client as Parameters<typeof adaptiveGuiApi>[0], noLocation)
    const onChange = vi.fn()
    const unsubscribe = api.watchSettings(onChange)
    expect(onCalls).toEqual(["settings-changed"])
    expect(typeof handlers.handler).toBe("function")
    handlers.handler?.()
    expect(onChange).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(handlers.unregistered).toBe(true)
  })
})
