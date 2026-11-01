/**
 * Plugin entry integration (T-17): setup glues hooks, the event pump and the
 * supervisor; cleanup disposes every registration. The host `Context` carries
 * ~30 domains — the entry touches four, so the fixture passes a structural
 * object through an explicit cast instead of faking the rest.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

import adaptivePlugin, { PLUGIN_ID } from "../src/index.js"
import { SETTINGS_KEY } from "../src/state/settings/types.js"
import { parseReceiptsPayload } from "../src/state/receipts/index.js"
import { makeInfo, fakeEvents, wireRef } from "./adapters/opencode/helpers.js"
import type { ModelSource } from "../src/adapters/opencode/index.js"
import { CONTINUATION_PROMPT } from "../src/supervisor/log.js"
import {
  FakeSupervisorSession,
  KeyFailStorage,
  seed,
  settingsJSON,
  storedReceipts,
  storedSettings,
} from "./supervisor/helpers.js"

const HOOK_NAMES = [
  "retry",
  "context",
  "model.request",
  "http.response",
  "experimental.idle",
  "prompt",
]

/** A structural host context over the fake session/model/storage/event. */
function fakeContext(options: {
  storage: KeyFailStorage
  session: FakeSupervisorSession
  events: ReturnType<typeof fakeEvents>
  infos?: ReturnType<typeof makeInfo>[]
  addedTools?: unknown[]
  registeredRpc?: (record: { definition: unknown; handlers: unknown }) => void
}): Parameters<typeof adaptivePlugin.setup>[0] {
  const infos = options.infos ?? [makeInfo("prov", "a")]
  const model: ModelSource = {
    transform: (cb) => {
      const editor = {
        list: () => infos,
        get: (providerID: string, modelID: string) =>
          infos.find((info) => info.providerID === providerID && info.id === modelID),
      }
      cb(editor as never)
      return Promise.resolve({ dispose: () => Promise.resolve() })
    },
  }
  return {
    session: options.session.source,
    model,
    storage: options.storage.source,
    event: options.events.source,
    tool: {
      transform: (cb: (editor: unknown) => void) => {
        cb({
          add: (tool: unknown) => {
            options.addedTools?.push(tool)
          },
        })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    rpc: {
      register: (definition: unknown, handlers: unknown) => {
        options.registeredRpc?.({ definition, handlers })
        return Promise.resolve({
          dispose: () => Promise.resolve(),
          events: { emit: () => undefined },
        })
      },
    },
  } as unknown as Parameters<typeof adaptivePlugin.setup>[0]
}

function startedEvent(): unknown {
  return { type: "session.execution.started", created: 100, data: { sessionID: "s1" } }
}

describe("plugin entry", () => {
  it("exposes the stable plugin id", () => {
    expect(PLUGIN_ID).toBe("coool.adaptive")
    expect(adaptivePlugin.id).toBe(PLUGIN_ID)
  })

  it("registers the six session hooks and the event subscription", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = await adaptivePlugin.setup(fakeContext({ storage, session, events }))
    expect([...session.registered.keys()].sort()).toEqual([...HOOK_NAMES].sort())
    expect(events.signal()).toBeInstanceOf(AbortSignal)
    expect(cleanup).toBeTypeOf("function")
  })

  it("pumps execution events into admission (switch + receipt)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    events.push(startedEvent())
    await vi.waitFor(() => {
      expect(session.log).toEqual(["switch:s1:prov/a"])
      expect(parseReceiptsPayload(storedReceipts(storage))).toHaveLength(1)
    })
    cleanup()
  })

  it("is inert end-to-end in OFF mode", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("off", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    events.push(startedEvent())
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    expect(session.log).toEqual([])
    expect(storedReceipts(storage)).toBeUndefined()
    cleanup()
  })

  it("disposes all hook registrations and the subscription on cleanup", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    cleanup()
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    // Six hook registrations were disposed (tags 1..6 after their pending
    // markers) and the event pump aborted quietly.
    const disposedTags = session.disposed.filter(
      (entry) =>
        entry !== "pending:1" &&
        entry !== "pending:2" &&
        entry !== "pending:3" &&
        entry !== "pending:4" &&
        entry !== "pending:5" &&
        entry !== "pending:6",
    )
    expect(disposedTags.sort()).toEqual(["1", "2", "3", "4", "5", "6"])
    expect(events.signal()?.aborted).toBe(true)
  })

  it("routes hook callbacks into the supervisor (retry veto through the entry)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
    )
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    const input = {
      sessionID: "s1",
      model: { providerID: "other", id: "x" },
      error: { type: "", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 500 },
    }
    await session.call("retry", input)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    // The failed resource is not a tier candidate, so admission offers `a` as
    // the recovery and the entry vetoes the native retry.
    expect(input.decision).toEqual({ retry: false })
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", `prompt:s1:${CONTINUATION_PROMPT}`])
    cleanup()
  })

  it("tracks a context-hook model request and attributes the next failure to it", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
    )
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({
        storage,
        session,
        events,
        infos: [makeInfo("prov", "a"), makeInfo("prov", "b")],
      }),
    )) as () => void
    await session.call("context", { sessionID: "s1", model: { providerID: "prov", id: "a" } })
    events.push(startedEvent())
    await vi.waitFor(() => {
      expect(session.log).toEqual(["switch:s1:prov/a"])
    })
    // The host acknowledges the switch; then a 429 fails the unit.
    events.push({
      type: "session.model.selected",
      created: 110,
      data: { sessionID: "s1", model: { providerID: "prov", id: "a" } },
    })
    events.push({
      type: "session.execution.failed",
      created: 120,
      data: { sessionID: "s1", error: { type: "", message: "", status: 429 } },
    })
    await vi.waitFor(() => {
      expect(parseReceiptsPayload(storedReceipts(storage))).toHaveLength(1)
    })
    // Second admission: a is rate-limited, so it falls back to b.
    events.push({ type: "session.execution.started", created: 130, data: { sessionID: "s1" } })
    await vi.waitFor(() => {
      expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/b"])
    })
    cleanup()
  })

  it("tracks a model.request hook with its request kind", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    await session.call("model.request", {
      sessionID: "s1",
      model: { providerID: "prov", id: "a" },
      kind: "title",
    })
    cleanup()
  })

  it("processes an http.response hook without an attributable model", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    await session.call("http.response", {
      sessionID: "s1",
      response: new Response("{}", { status: 200 }),
    })
    expect(storedReceipts(storage)).toBeUndefined()
    cleanup()
  })

  it("feeds an idle hook into the resume path (no parked records: no-op)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    await session.call("experimental.idle", { sessionID: "s1" })
    expect(session.log).toEqual([])
    cleanup()
  })

  it("logs event-pump stream errors fail-open", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    events.fail(new Error("stream broken"))
    await vi.waitFor(() => {
      expect(
        errors.mock.calls.some((call) => String(call[0]).includes("[coool.adaptive] events:")),
      ).toBe(true)
    })
    cleanup()
  })

  it("registers the typed escalation tool and routes it into the supervisor", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const addedTools: unknown[] = []
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events, addedTools }),
    )) as () => void
    const tool = addedTools[0] as { name: string } | undefined
    expect(tool?.name).toBe("adaptive_escalate")
    // The tool records against the session's active unit.
    events.push(startedEvent())
    await vi.waitFor(() => {
      expect(session.log).toEqual(["switch:s1:prov/a"])
    })
    const execute = (
      tool as unknown as {
        execute: (input: unknown, context: { sessionID: string }) => Promise<unknown>
      }
    ).execute
    const result = (await execute({ reason: "ctx", evidence: "413" }, { sessionID: "s1" })) as {
      content: string
    }
    expect(result.content).toContain("recorded")
    cleanup()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})

describe("plugin entry: rpc surface", () => {
  interface RpcRecord {
    definition: { id: string; methods: Record<string, unknown> }
    handlers: Record<string, (input: unknown) => Promise<unknown>>
  }

  it("registers the adaptive rpc definition with four handlers", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    let record: RpcRecord | undefined
    const context = fakeContext({
      storage,
      session,
      events: fakeEvents(),
      registeredRpc: (captured) => {
        record = captured as RpcRecord
      },
    })
    await adaptivePlugin.setup(context)
    expect(record?.definition.id).toBe("coool.adaptive")
    expect(Object.keys(record?.definition.methods ?? {}).sort()).toEqual([
      "receipts.list",
      "settings.get",
      "settings.set",
      "status.get",
    ])
    const handlers = record?.handlers ?? {}
    const settings = (await handlers["settings.get"]?.(undefined)) as { mode: string }
    expect(settings.mode).toBe("control")
    const result = (await handlers["settings.set"]?.({ mode: "observe" })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(storedSettings(storage).mode).toBe("observe")
  })
})

describe("prompt hook through the entry", () => {
  it("routes the prompt report into admission (switch + receipt at prompt time)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const events = fakeEvents()
    const cleanup = (await adaptivePlugin.setup(
      fakeContext({ storage, session, events }),
    )) as () => void
    await session.call("prompt", { sessionID: "s1" })
    expect(session.log).toContain("switch:s1:prov/a")
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.unitID).toBeUndefined()
    cleanup()
  })
})
