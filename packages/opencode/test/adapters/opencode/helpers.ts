/**
 * Typed fixtures for the OpenCode adapter tests. Fixtures simulate host wire
 * data (branded ids, host-only return types), so targeted casts to the real
 * `@opencode/plugin@2.2.5` types are necessary and centralized here. Seam
 * methods are plain functions returning `Promise.resolve(...)` — fixture
 * fakes never need async bodies.
 */
import { Model, type Provider } from "@opencode/plugin"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { EventSource } from "../../../src/adapters/opencode/events.js"
import type { ModelSource } from "../../../src/adapters/opencode/inventory.js"
import type { SessionEvent } from "../../../src/adapters/opencode/report.js"
import type { SessionHookSource } from "../../../src/adapters/opencode/hooks.js"
import type { SessionOpsSource } from "../../../src/adapters/opencode/session-ops.js"
import type { StorageSource } from "../../../src/adapters/opencode/storage.js"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"

/** A wire model reference with branded host types. */
export function wireRef(providerID: string, id: string, variant?: string): Model.Ref {
  return {
    providerID,
    id,
    ...(variant !== undefined ? { variant } : {}),
  } as Model.Ref
}

/** Same shape for supervisor-side refs in assertions. */
export function coreRef(providerID: string, id: string, variant?: string): ModelRef {
  return {
    providerID,
    id,
    ...(variant !== undefined ? { variant } : {}),
  }
}

export interface InfoOverrides {
  readonly enabled?: boolean | undefined
  readonly tools?: boolean | undefined
  readonly context?: number | undefined
  readonly variants?: readonly string[] | undefined
}

/** Build a host `Model.Info` from the verified host default factory + overrides. */
export function makeInfo(providerID: string, id: string, over: InfoOverrides = {}): Model.Info {
  const base = Model.Info.default(providerID as Provider.ID, id as Model.ID)
  return {
    ...base,
    ...(over.enabled !== undefined ? { enabled: over.enabled } : {}),
    capabilities: {
      ...base.capabilities,
      ...(over.tools !== undefined ? { tools: over.tools } : {}),
    },
    ...(over.context !== undefined ? { limit: { ...base.limit, context: over.context } } : {}),
    ...(over.variants !== undefined
      ? { variants: over.variants.map((v) => ({ id: v as Model.VariantID })) }
      : {}),
  }
}

/** A model source whose editor serves the given infos (provider filter honored). */
export function fakeModel(infos: Model.Info[]): ModelSource {
  const editor: ModelEditor = {
    list: (providerID?: string) =>
      infos.filter(
        (i) => providerID === undefined || i.providerID === providerID,
      ) as unknown as ReturnType<ModelEditor["list"]>,
    get: (providerID, modelID) =>
      infos.find((i) => i.providerID === providerID && i.id === modelID) as unknown as ReturnType<
        ModelEditor["get"]
      >,
    update: () => undefined,
    remove: () => undefined,
    default: {
      get: () => undefined,
      set: () => undefined,
    },
    provider: {
      list: () => [],
      get: () => undefined,
    },
  }
  const registration: Registration = { dispose: () => Promise.resolve() }
  return {
    transform: (cb) => {
      cb(editor)
      return Promise.resolve(registration)
    },
  }
}

/** In-memory storage source recording writes. */
export class FakeStorage {
  readonly data = new Map<string, unknown>()
  readonly writes: string[] = []
  readonly source: StorageSource

  constructor() {
    const source = {
      get: (key: string) => Promise.resolve(this.data.get(key)),
      set: (key: string, value: unknown) => {
        this.writes.push(key)
        this.data.set(key, value)
        return Promise.resolve()
      },
    }
    this.source = source as unknown as StorageSource
  }
}

/** Session ops fixture recording a call log (settle/switch/prompt + tags). */
export function fakeSessionOps(log: string[]): SessionOpsSource {
  return {
    wait: (input: { sessionID: string }) => {
      log.push(`wait:${input.sessionID}`)
      return Promise.resolve()
    },
    switchModel: (input: {
      sessionID: string
      model: { providerID: string; id: string; variant?: string | undefined }
    }) => {
      log.push(
        `switch:${input.sessionID}:${input.model.providerID}/${input.model.id}${
          input.model.variant === undefined ? "" : `@${input.model.variant}`
        }`,
      )
      return Promise.resolve()
    },
    prompt: (input: { sessionID: string; text: string }) => {
      log.push(`prompt:${input.sessionID}:${input.text}`)
      return Promise.resolve()
    },
  } as unknown as SessionOpsSource
}

type AnyCallback = (input: unknown) => unknown

/** Session hook fixture capturing registered callbacks and dispose calls. */
export class FakeHookSession {
  readonly registered = new Map<string, AnyCallback>()
  readonly disposed: string[] = []
  readonly source: SessionHookSource

  constructor() {
    let counter = 0
    const hook = (name: string, cb: AnyCallback) => {
      this.registered.set(name, cb)
      counter += 1
      const tag = String(counter)
      const registration: Registration = {
        dispose: () => {
          this.disposed.push(tag)
          return Promise.resolve()
        },
      }
      return Promise.resolve(registration)
    }
    this.source = { hook } as unknown as SessionHookSource
  }

  /** Invoke a captured hook callback with a (wire-shaped) input. */
  async call(name: string, input: unknown): Promise<void> {
    const cb = this.registered.get(name)
    if (cb === undefined) {
      throw new Error(`hook not registered: ${name}`)
    }
    await cb(input)
  }
}

/** Push-based event stream + EventSource fixture exposing the subscribe signal. */
export function fakeEvents(): {
  source: EventSource
  push: (event: unknown) => void
  fail: (error: unknown) => void
  close: () => void
  signal: () => AbortSignal | undefined
} {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let failure: { error: unknown } | null = null
  let closed = false
  let subscribedSignal: AbortSignal | undefined
  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          if (queue.length > 0) {
            const value = queue.shift()
            return { done: false, value }
          }
          if (failure !== null) {
            throw failure.error
          }
          if (closed) {
            return { done: true as const, value: undefined }
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    }),
  }
  const push = (event: unknown) => {
    queue.push(event)
    wake?.()
  }
  const fail = (error: unknown) => {
    failure = { error }
    wake?.()
  }
  const close = () => {
    closed = true
    wake?.()
  }
  const subscribe = (options?: { signal?: AbortSignal }) => {
    subscribedSignal = options?.signal
    return stream
  }
  return {
    source: { subscribe } as unknown as EventSource,
    push,
    fail,
    close,
    signal: () => subscribedSignal,
  }
}

/** A structural session event fixture (no branding needed). */
export function sessionEvent(
  type: SessionEvent["type"],
  data: Record<string, unknown>,
  created = 100,
): SessionEvent {
  return { type, created, data } as SessionEvent
}
