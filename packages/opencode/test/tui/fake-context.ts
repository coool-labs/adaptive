// Shared fake TUI host context: records dialogs, slots, keymap layers and
// rpc events so the TUI entrypoint can be driven without a host.
import type { ModelInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/plugin"
import type { Route } from "@opencode/plugin/tui/context"
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"

export interface DialogRecord {
  selects: {
    title: string
    values: unknown[]
    actions?: { title: string; bind: string; onTrigger: () => void }[]
  }[]
  selectQueue: unknown[]
  confirmQueue: (boolean | undefined)[]
  alerts: { title: string; message: string }[]
  toasts: { message: string; variant?: string }[]
  /** Custom dialog renders (the status table), newest last. */
  shows: { render: () => unknown; onClose: (() => void) | undefined }[]
  /** How often the host dialog layer was cleared (footer-action flips). */
  clears: number
  /** Resolvers of still-pending paged selects (the test ends the loop). */
  pagedResolvers: ((picked: unknown) => void)[]
  /** Dialog presentation options set via dialog.set, in call order. */
  sets: unknown[]
}

const PICK = Symbol("pick")

/** A select queue entry that picks the option with this title: menu action rows carry closures. */
export function byTitle(title: string): unknown {
  return { [PICK]: title }
}

export interface SlotRecord {
  append: string
  render: (input?: unknown) => unknown
}

export function fakeTuiContext(options: {
  settings: unknown
  clientPatches: Record<string, unknown>[]
  modelList?: ModelInfo[] | undefined
  failSettingsGet?: boolean
  failSelect?: unknown
  failPagedSelect?: unknown
  /** The screen the palette command runs from (home when absent). */
  route?: Route | undefined
  /** The status snapshot the fake rpc serves (empty tiers when absent). */
  status?: unknown
  failStatusGet?: boolean
  /** Answers each status read in place of `status`/`failStatusGet`. */
  statusGet?: () => Promise<unknown>
  /** The session-mode override the fake rpc serves (null = no override). */
  sessionMode?: OperatingMode | null
  failSessionModeGet?: boolean
  /** Records every session-mode.set call for assertions. */
  sessionModePatches?: { sessionID: string; mode: OperatingMode | null }[]
  /** The tier request the fake rpc serves (null = follows the routing ladder). */
  tierRequest?: string | null
  failTierRequestGet?: boolean
  /** Records every tier-request.set call for assertions. */
  tierRequestPatches?: { sessionID: string; tier: string | null }[]
  /** Receipts the fake rpc serves for receipts.list (empty when absent). */
  receipts?: unknown[]
  /** The TUI location the context carries (location-less when absent). */
  location?: unknown
  /** Records the call options every rpc method received. */
  rpcCalls?: { method: string; options: unknown }[]
}): {
  context: Context
  dialogs: DialogRecord
  layers: ReturnType<() => unknown>[]
  slots: SlotRecord[]
  events: { name: string; handler: (event: unknown) => void }[]
  counts: {
    slotDisposals: number
    eventDisposals: number
    settingsGets: number
    sessionModeGets: number
    tierRequestGets: number
    statusGets: number
  }
} {
  const dialogs: DialogRecord = {
    selects: [],
    selectQueue: [],
    confirmQueue: [],
    alerts: [],
    toasts: [],
    shows: [],
    sets: [],
    clears: 0,
    pagedResolvers: [],
  }
  const shows = dialogs.shows
  const layers: unknown[] = []
  const slots: SlotRecord[] = []
  const events: { name: string; handler: (event: unknown) => void }[] = []
  // Mutable holder: the counters keep changing after the fake is returned.
  const counts = {
    slotDisposals: 0,
    eventDisposals: 0,
    settingsGets: 0,
    sessionModeGets: 0,
    tierRequestGets: 0,
    statusGets: 0,
  }
  const select = (spec: {
    title: string
    options: { title: string; value: unknown }[]
    search?: (query: string, options: { value: unknown }[]) => unknown
    actions?: { title: string; bind: string; onTrigger: () => void }[]
  }) => {
    if (spec.search !== undefined) spec.search("", spec.options)
    dialogs.selects.push({
      title: spec.title,
      values: spec.options.map((option) => option.value),
      ...(spec.actions !== undefined ? { actions: [...spec.actions] } : {}),
    })
    if (options.failSelect !== undefined) {
      // The runAdaptive catch must tolerate non-Error rejections (fail-open).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.failSelect)
    }
    if (spec.actions !== undefined) {
      if (options.failPagedSelect !== undefined) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(options.failPagedSelect)
      }
      // An actioned select stays pending like the real host's (footer
      // actions flip the page while the dialog is open); the test drives the
      // flip through the recorded onTrigger and ends the loop through the
      // resolver. A queued pick (the Backspace-as-back menu select in the
      // receipts wiring test) resolves the normal way instead.
      let resolvePending!: (picked: unknown) => void
      const pending = new Promise((resolve) => {
        resolvePending = resolve
      })
      dialogs.pagedResolvers.push(resolvePending)
      // An explicit `undefined` queue entry is a real pick (Escape); only an
      // EMPTY queue leaves the select pending for the test to drive.
      const hadQueued = dialogs.selectQueue.length > 0
      const queued = dialogs.selectQueue.shift()
      if (hadQueued) {
        const at = dialogs.pagedResolvers.indexOf(resolvePending)
        if (at >= 0) dialogs.pagedResolvers.splice(at, 1)
        return Promise.resolve(queued as never)
      }
      return pending
    }
    const next = dialogs.selectQueue.shift()
    if (typeof next === "object" && next !== null && PICK in next) {
      const option = spec.options.find((candidate) => candidate.title === next[PICK])
      if (option === undefined) throw new Error(`no option titled ${String(next[PICK])}`)
      return Promise.resolve(option.value as never)
    }
    return Promise.resolve(next as never)
  }
  const sessionModePatches = options.sessionModePatches ?? []
  const tierRequestPatches = options.tierRequestPatches ?? []
  const rpcCalls = options.rpcCalls ?? []
  // Wraps every rpc method so tests can assert the call options (the TUI
  // location) each request carried; `events` passes through untouched.
  const recordCalls = <Methods extends Record<string, unknown>>(methods: Methods): Methods =>
    Object.fromEntries(
      Object.entries(methods).map(([method, value]) =>
        typeof value === "function"
          ? [
              method,
              (input: unknown, callOptions: unknown) => {
                rpcCalls.push({ method, options: callOptions })
                return (value as (input: unknown) => unknown)(input)
              },
            ]
          : [method, value],
      ),
    ) as Methods
  const context = {
    client: {
      rpc: () =>
        recordCalls({
          "settings.get": () => {
            counts.settingsGets += 1
            return options.failSettingsGet
              ? Promise.reject(new Error("boom"))
              : Promise.resolve(options.settings)
          },
          "settings.set": (patch: Record<string, unknown>) => {
            options.clientPatches.push(patch)
            return Promise.resolve({ ok: true, settings: options.settings })
          },
          "status.get": () => {
            counts.statusGets += 1
            if (options.statusGet !== undefined) return options.statusGet()
            return options.failStatusGet
              ? Promise.reject(new Error("boom"))
              : Promise.resolve(
                  options.status ?? {
                    mode: "observe",
                    pin: null,
                    tiers: { quick: [], standard: [], advanced: [] },
                    parked: 0,
                    waiting: [],
                    receipts: 0,
                  },
                )
          },
          "receipts.list": () => Promise.resolve(options.receipts ?? []),
          "health.reset": () => Promise.resolve(undefined),
          "parked.resume": () => Promise.resolve("resumed"),
          "parked.cancel": () => Promise.resolve("cancelled"),
          "doctor.run": () => Promise.resolve([]),
          "session-mode.get": (input: { sessionID: string }) => {
            counts.sessionModeGets += 1
            return options.failSessionModeGet
              ? Promise.reject(new Error("boom"))
              : Promise.resolve({ mode: options.sessionMode ?? null, sessionID: input.sessionID })
          },
          "session-mode.set": (input: { sessionID: string; mode: OperatingMode | null }) => {
            sessionModePatches.push(input)
            return Promise.resolve({ ok: true })
          },
          "tier-request.get": (input: { sessionID: string }) => {
            counts.tierRequestGets += 1
            return options.failTierRequestGet
              ? Promise.reject(new Error("boom"))
              : Promise.resolve({ tier: options.tierRequest ?? null, sessionID: input.sessionID })
          },
          "tier-request.set": (input: { sessionID: string; tier: string | null }) => {
            tierRequestPatches.push(input)
            return Promise.resolve({ ok: true })
          },
          events: {
            on: (name: string, handler: (event: unknown) => void) => {
              events.push({ name, handler })
              return () => {
                counts.eventDisposals += 1
              }
            },
          },
        }),
    },
    ui: {
      slot: (claim: { append: string; render: () => unknown }) => {
        slots.push({ append: claim.append, render: claim.render })
        return () => {
          counts.slotDisposals += 1
        }
      },
      dialog: {
        select,
        confirm: (spec: { title: string }) => {
          dialogs.alerts.push({ title: spec.title, message: "confirm" })
          return Promise.resolve(dialogs.confirmQueue.shift() ?? false)
        },
        alert: (spec: { title: string; message: string }) => {
          dialogs.alerts.push(spec)
          return Promise.resolve()
        },
        show: (render: () => unknown, onClose?: () => void) => {
          shows.push({ render, onClose })
        },
        clear: () => {
          dialogs.clears += 1
        },
        set: (options: unknown) => {
          dialogs.sets.push(options)
        },
      },
      toast: {
        show: (spec: { message: string; variant?: string }) => {
          dialogs.toasts.push(spec)
        },
      },
      // The palette command reads the open screen through the router: inside
      // a session its sessionID steers the per-session flows.
      router: {
        current: () => options.route ?? ({ type: "home" } satisfies Route),
      },
    },
    data: {
      location: {
        model: {
          list: () => options.modelList,
        },
      },
    },
    keymap: {
      layer: (factory: () => unknown) => {
        layers.push(factory())
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
    location: options.location,
  } as unknown as Context
  return { context, dialogs, layers, slots, events, counts }
}

export function modelInfo(
  providerID: string,
  modelID: string,
  name: string,
  variants: string[],
): ModelInfo {
  return {
    providerID,
    modelID,
    id: modelID,
    name,
    variants: variants.map((variant) => ({ id: variant })),
  } as unknown as ModelInfo
}
