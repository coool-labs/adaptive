/**
 * Supervisor test fixtures (T-17): a structural session implementing the
 * `SupervisorSessionSource` shape (ops + optional hook capture), a fail-on-key
 * storage source, and settings payload seeds. Structural — no host branding.
 */
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import type { SessionHookSource } from "../../src/adapters/opencode/hooks.js"
import type { StorageSource } from "../../src/adapters/opencode/storage.js"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { ModelSource } from "../../src/adapters/opencode/inventory.js"
import type { GoalSurface, SupervisorSessionSource } from "../../src/supervisor/types.js"
import { processLedger, type ProcessLedger } from "../../src/adapters/opencode/process-ledger.js"
import { Supervisor } from "../../src/supervisor/index.js"
import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import { RECEIPTS_KEY } from "@coool/adaptive-core/state/receipts/types"
import { PARKED_KEY } from "@coool/adaptive-core/state/parked-work/types"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { migrateSettings } from "@coool/adaptive-core/state/settings/parse"

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
        if (this.failGet) return Promise.reject(new Error("session not found"))
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

export function storedSettings(storage: { data: Map<string, unknown> }): SettingsV1 {
  return migrateSettings(storage.data.get(SETTINGS_KEY))
}

/** Flush the supervisor's voided async continuations before asserting. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export function ref(providerID: string, id: string): { providerID: string; id: string } {
  return { providerID, id }
}

export interface FakeTimer {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
}

/** Records scheduled wakes; nothing fires until a test calls `fire()`. */
export class FakeScheduler {
  readonly timers: FakeTimer[] = []

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const timer: FakeTimer = { callback, delayMs, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  /** The live (uncancelled) timers. */
  pending(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled)
  }

  /** Fire the single live timer (marking it spent), then let its sweep settle. */
  async fire(): Promise<void> {
    const live = this.pending()
    if (live.length !== 1) throw new Error(`expected one live timer, found ${String(live.length)}`)
    const [timer] = live as [FakeTimer]
    timer.cancelled = true
    timer.callback()
    await flush()
  }
}

/** Wake/ledger options that never fire, for hand-built supervisors (a private process each). */
export function inertWake(): { schedule: FakeScheduler["schedule"]; ledger: ProcessLedger } {
  return { schedule: new FakeScheduler().schedule, ledger: processLedger({}) }
}

/** A supervisor over one fake session and a fixed clock. */
export function makeSupervisor(options: {
  storage: KeyFailStorage
  session: FakeSupervisorSession
  infos?: ReturnType<typeof makeInfo>[]
  clock?: () => number
  scheduler?: FakeScheduler
  /** Pass one `processLedger(holder)` view per supervisor over a shared holder to model one process. */
  ledger?: ProcessLedger
  goal?: GoalSurface
}): Supervisor {
  const infos = options.infos ?? [makeInfo("prov", "a"), makeInfo("prov", "b")]
  const model = {
    transform: (cb: (editor: unknown) => unknown) => {
      const editor = {
        list: () => infos,
        get: (providerID: string, modelID: string) =>
          infos.find((info) => info.providerID === providerID && info.id === modelID),
      }
      cb(editor)
      return Promise.resolve({ dispose: () => Promise.resolve() })
    },
  } as unknown as ModelSource
  return new Supervisor({
    session: options.session.source as unknown as SupervisorSessionSource,
    model,
    storage: options.storage.source,
    clock: options.clock ?? (() => 1000),
    schedule: (options.scheduler ?? new FakeScheduler()).schedule,
    ledger: options.ledger ?? processLedger({}),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
  })
}

/** Standard tier with the two inventory models, active mode. */
export function activeStorage(): KeyFailStorage {
  const storage = new KeyFailStorage("unused")
  seed(
    storage,
    "coool.adaptive/settings",
    settingsJSON("active", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
  )
  return storage
}
