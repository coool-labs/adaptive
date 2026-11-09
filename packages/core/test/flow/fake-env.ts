/**
 * Scripted host for the action and subcommand flows: selects answer by option
 * title (action rows carry closures), confirms pop a queue, everything shown is
 * recorded.
 */
import type { AdaptiveActions } from "../../src/flow/actions.js"
import type { AdaptiveApi, AdaptiveEnv, AdaptiveView } from "../../src/flow/controller.js"
import type { Receipt } from "../../src/state/receipts/index.js"
import type { PatchResult, SettingsPatch, SettingsV1 } from "../../src/state/settings/index.js"
import type { StatusSnapshot, TierResourceStatus } from "../../src/status.js"
import { OPENCODE_COPY } from "../host-copy.js"

export interface Scripted {
  readonly env: AdaptiveEnv
  readonly picks: (string | undefined)[]
  readonly confirms: (boolean | undefined)[]
  readonly selects: { title: string; options: { title: string; description?: string }[] }[]
  readonly alerts: { title: string; message: string }[]
  readonly tables: { title: string; lines: string[] }[]
  readonly toasts: { message: string; variant: string }[]
  readonly patches: SettingsPatch[]
}

export function settings(overrides: Partial<SettingsV1> = {}): SettingsV1 {
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

export function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    waiting: [],
    receipts: 0,
    ...overrides,
  }
}

export function resource(overrides: Partial<TierResourceStatus> = {}): TierResourceStatus {
  return {
    ref: { providerID: "prov", id: "a" },
    health: "healthy",
    breaker: "closed",
    windowed: false,
    windowUntil: null,
    usedPercent: null,
    resetAt: null,
    ...overrides,
  }
}

export function scripted(
  options: {
    status?: StatusSnapshot
    receipts?: Receipt[]
    patch?: PatchResult
    actions?: AdaptiveActions
    sessionID?: string
    /** False leaves the host clock unset (views fall back to the wall clock). */
    clock?: boolean
  } = {},
): Scripted {
  const state = {
    picks: [] as (string | undefined)[],
    confirms: [] as (boolean | undefined)[],
    selects: [] as { title: string; options: { title: string; description?: string }[] }[],
    alerts: [] as { title: string; message: string }[],
    tables: [] as { title: string; lines: string[] }[],
    toasts: [] as { message: string; variant: string }[],
    patches: [] as SettingsPatch[],
  }
  const view: AdaptiveView = {
    select: (spec) => {
      state.selects.push({
        title: spec.title,
        options: spec.options.map(({ title, description }) =>
          description === undefined ? { title } : { title, description },
        ),
      })
      const pick = state.picks.shift()
      return Promise.resolve(spec.options.find((option) => option.title === pick)?.value)
    },
    selectPaged: () => Promise.resolve({ picked: undefined, action: undefined }),
    confirm: () => Promise.resolve(state.confirms.shift()),
    alert: (spec) => {
      state.alerts.push(spec)
      return Promise.resolve()
    },
    table: (spec) => {
      state.tables.push({ title: spec.title, lines: [...spec.lines] })
      return Promise.resolve()
    },
    toast: (message, variant) => {
      state.toasts.push({ message, variant })
    },
  }
  const api: AdaptiveApi = {
    settings: () => Promise.resolve(settings()),
    setSettings: (patch) => {
      state.patches.push(patch)
      return Promise.resolve(options.patch ?? { ok: true, settings: settings() })
    },
    status: () => Promise.resolve(options.status ?? snapshot()),
    receipts: () => Promise.resolve(options.receipts ?? []),
    sessionMode: () => Promise.resolve(null),
    setSessionMode: () => Promise.resolve({ ok: true }),
    tierRequest: () => Promise.resolve(null),
    setTierRequest: () => Promise.resolve({ ok: true }),
  }
  const env: AdaptiveEnv = {
    copy: OPENCODE_COPY,
    api,
    view,
    models: () => [],
    ...(options.clock === false ? {} : { clock: () => 0 }),
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.sessionID === undefined ? {} : { sessionID: options.sessionID }),
  }
  return { env, ...state }
}
