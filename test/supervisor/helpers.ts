/**
 * Supervisor test fixtures (T-17): a structural session implementing the
 * `SupervisorSessionSource` shape (ops + optional hook capture), a fail-on-key
 * storage source, and settings payload seeds. Structural — no host branding.
 */
import type { OperatingMode } from "../../src/core/scheduler/types.js"
import type { SessionHookSource } from "../../src/adapters/opencode/hooks.js"
import type { StorageSource } from "../../src/adapters/opencode/storage.js"
import type { ModelRef } from "../../src/core/work-unit/types.js"
import { RECEIPTS_KEY } from "../../src/state/receipts/types.js"
import { PARKED_KEY } from "../../src/state/parked-work/types.js"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"

type AnyCallback = (input: never) => unknown

export class FakeSupervisorSession {
  readonly registered = new Map<string, AnyCallback>()
  readonly disposed: string[] = []
  readonly log: string[]
  readonly failGet: boolean
  readonly failWait: boolean
  readonly failPrompt: boolean
  readonly source: SupervisorSessionSourceFixture & SessionHookSource

  constructor(
    options: {
      log?: string[]
      failGet?: boolean
      failWait?: boolean
      failPrompt?: boolean
    } = {},
  ) {
    this.log = options.log ?? []
    this.failGet = options.failGet ?? false
    this.failWait = options.failWait ?? false
    this.failPrompt = options.failPrompt ?? false
    let counter = 0
    const hook = (name: string, cb: AnyCallback) => {
      this.registered.set(name, cb)
      counter += 1
      const tag = String(counter)
      this.disposed.push(`pending:${tag}`)
      return Promise.resolve({
        dispose: () => {
          this.disposed.push(tag)
          return Promise.resolve()
        },
      })
    }
    this.source = {
      hook,
      get: (input: { sessionID: string }) => {
        if (this.failGet) return Promise.reject(new Error("session gone"))
        return Promise.resolve({ sessionID: input.sessionID })
      },
      wait: (input: { sessionID: string }) => {
        if (this.failWait) return Promise.reject(new Error("settle failed"))
        this.log.push(`wait:${input.sessionID}`)
        return Promise.resolve()
      },
      switchModel: (input: { sessionID: string; model: ModelRef }) => {
        const variant = input.model.variant !== undefined ? `@${input.model.variant}` : ""
        this.log.push(
          `switch:${input.sessionID}:${input.model.providerID}/${input.model.id}${variant}`,
        )
        return Promise.resolve()
      },
      prompt: (input: { sessionID: string; text: string }) => {
        this.log.push(`prompt:${input.sessionID}:${input.text}`)
        if (this.failPrompt) return Promise.reject(new Error("prompt failed"))
        return Promise.resolve({ sessionID: input.sessionID })
      },
    }
  }

  /** Invoke a captured hook callback with a (wire-shaped) input. */
  async call(name: string, input: unknown): Promise<void> {
    const cb = this.registered.get(name)
    if (cb === undefined) {
      throw new Error(`hook not registered: ${name}`)
    }
    await (cb as (value: unknown) => unknown)(input)
  }
}

/** Structural stand-in for the supervisor's session source. */
export interface SupervisorSessionSourceFixture {
  get(input: { sessionID: string }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  switchModel(input: { sessionID: string; model: ModelRef }): Promise<void>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
}

/**
 * Storage that fails a key's writes after the first `succeeds` writes to it
 * (re-park failure scenarios: the pop persists, the re-park does not).
 */
export class FailAfterStorage {
  readonly data = new Map<string, unknown>()
  readonly source: StorageSource
  #writes = 0

  constructor(
    readonly failingKey: string,
    readonly succeeds: number,
  ) {
    this.source = {
      get: (key: string) => Promise.resolve(this.data.get(key)),
      set: (key: string, value: unknown) => {
        if (key === this.failingKey) {
          this.#writes += 1
          if (this.#writes > this.succeeds) return Promise.reject(new Error("write failed"))
        }
        this.data.set(key, value)
        return Promise.resolve()
      },
    } as unknown as StorageSource
  }
}

/** Storage that fails writes for one key (receipts write-failure scenarios). */
export class KeyFailStorage {
  readonly data = new Map<string, unknown>()
  readonly source: StorageSource

  constructor(readonly failingKey: string) {
    this.source = {
      get: (key: string) => Promise.resolve(this.data.get(key)),
      set: (key: string, value: unknown) => {
        if (key === this.failingKey) return Promise.reject(new Error("write failed"))
        this.data.set(key, value)
        return Promise.resolve()
      },
    } as unknown as StorageSource
  }
}

/** A versioned settings payload seed (wire JSON shape). */
export function settingsJSON(
  mode: OperatingMode,
  tiers: Record<string, unknown[]> = {},
  pin: unknown = null,
  agentTiers: Record<string, string> = {},
): Record<string, unknown> {
  return {
    version: 1,
    mode,
    tiers: { quick: [], standard: [], advanced: [], ...tiers },
    pin,
    agentTiers,
    inviteDismissed: false,
  }
}

export function seed(storage: { data: Map<string, unknown> }, key: string, value: unknown): void {
  storage.data.set(key, value)
}

export function storedReceipts(storage: { data: Map<string, unknown> }): unknown {
  return storage.data.get(RECEIPTS_KEY)
}

export function storedParked(storage: { data: Map<string, unknown> }): unknown {
  return storage.data.get(PARKED_KEY)
}

export function storedSettingsKey(): string {
  return SETTINGS_KEY
}
