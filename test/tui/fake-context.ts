// Shared fake TUI host context: records dialogs, slots, keymap layers and
// rpc events so the TUI entrypoint can be driven without a host.
import type { ModelInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/plugin"

export interface DialogRecord {
  selects: { title: string; values: unknown[] }[]
  selectQueue: unknown[]
  confirmQueue: (boolean | undefined)[]
  alerts: { title: string; message: string }[]
  toasts: { message: string; variant?: string }[]
}

export interface SlotRecord {
  append: string
  render: () => unknown
}

export function fakeTuiContext(options: {
  settings: unknown
  clientPatches: Record<string, unknown>[]
  modelList?: ModelInfo[] | undefined
  failSettingsGet?: boolean
  failSelect?: unknown
}): {
  context: Context
  dialogs: DialogRecord
  layers: ReturnType<() => unknown>[]
  slots: SlotRecord[]
  events: { name: string; handler: () => void }[]
  counts: { slotDisposals: number; eventDisposals: number; settingsGets: number }
} {
  const dialogs: DialogRecord = {
    selects: [],
    selectQueue: [],
    confirmQueue: [],
    alerts: [],
    toasts: [],
  }
  const layers: unknown[] = []
  const slots: SlotRecord[] = []
  const events: { name: string; handler: () => void }[] = []
  // Mutable holder: the counters keep changing after the fake is returned.
  const counts = { slotDisposals: 0, eventDisposals: 0, settingsGets: 0 }
  const select = (spec: {
    title: string
    options: { value: unknown }[]
    search?: (query: string, options: { value: unknown }[]) => unknown
  }) => {
    if (spec.search !== undefined) spec.search("", spec.options)
    dialogs.selects.push({ title: spec.title, values: spec.options.map((option) => option.value) })
    if (options.failSelect !== undefined) {
      // The runAdaptive catch must tolerate non-Error rejections (fail-open).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.failSelect)
    }
    const next = dialogs.selectQueue.shift()
    return Promise.resolve(next as never)
  }
  const context = {
    client: {
      rpc: () => ({
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
        "status.get": () =>
          Promise.resolve({
            mode: "observe",
            pin: null,
            tiers: { quick: [], standard: [], advanced: [] },
            parked: 0,
            receipts: 0,
          }),
        "receipts.list": () => Promise.resolve([]),
        events: {
          on: (name: string, handler: () => void) => {
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
      },
      toast: {
        show: (spec: { message: string; variant?: string }) => {
          dialogs.toasts.push(spec)
        },
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
    location: undefined,
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
