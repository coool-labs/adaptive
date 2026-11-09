import { stripVTControlCharacters } from "node:util"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { logFailOpen } from "@coool/adaptive-core/log"

export type RoutingStatus =
  | {
      readonly kind: "routing" | "recovering" | "escalated"
      readonly tier: TierName
      readonly model: string
    }
  | { readonly kind: "observing"; readonly tier: TierName }
  | { readonly kind: "degraded" | "setup" }

interface StatusContext {
  readonly hasUI?: boolean
  readonly ui?: Pick<ExtensionContext["ui"], "setStatus">
}

export interface RoutingFeedback {
  show(state: RoutingStatus): void
  dispatched(
    model: { readonly id: string },
    info: {
      readonly tier: TierName
      readonly retry: boolean
      readonly state: { readonly escalations: number; readonly restarts: number } | undefined
    },
  ): void
}

function statusText(state: RoutingStatus): string {
  switch (state.kind) {
    case "routing":
      return `${state.tier} | ${state.model}`
    case "recovering":
      return `Recovering ${state.tier} | ${state.model}`
    case "escalated":
      return `Escalated ${state.tier} | ${state.model}`
    case "observing":
      return `Observing | would use ${state.tier}`
    case "degraded":
      return "Adaptive degraded | /adaptive doctor"
    case "setup":
      return "Adaptive: set up tiers | /adaptive"
  }
}

function terminalText(text: string): string {
  // Provider model IDs are untrusted. ASCII bounds cells as well as characters,
  // leaving room beside Pi's own footer at the supported 60-column minimum.
  const safe = stripVTControlCharacters(text).replace(/[^\x20-\x7e]/g, "?")
  return safe.length <= 48 ? safe : `${safe.slice(0, 45)}...`
}

/** One footer key: parking overrides routing until parking clears its status. */
export function createStatusChip() {
  let generation = 0
  let routing: string | undefined
  let parking: string | undefined
  let owner: StatusContext["ui"]
  const paint = (ui: StatusContext["ui"], text: string | undefined): void => {
    try {
      ui?.setStatus("adaptive", text)
    } catch (error) {
      logFailOpen("status", error)
    }
  }
  const reset = (): void => {
    generation += 1
    routing = undefined
    parking = undefined
    paint(owner, undefined)
    owner = undefined
  }

  return {
    /** Reset before model/session changes and shutdown, not on tool continuations. */
    reset,
    /** Capture before awaiting work; old callbacks cannot repaint a new session. */
    connect<T extends StatusContext>(ctx: T) {
      const owned = generation
      const ui = ctx.hasUI ? ctx.ui : undefined
      let degraded = false
      const render = () => {
        owner = ui
        paint(ui, parking ?? routing)
      }
      const show = (state: RoutingStatus): void => {
        if (owned !== generation) return
        if (state.kind === "degraded") degraded = true
        routing = terminalText(statusText(state))
        render()
      }
      const setStatus = (key: string, text: string | undefined): void => {
        if (owned !== generation) return
        if (key !== "adaptive") {
          ui?.setStatus(key, text)
          return
        }
        // Do not reformat parking's countdown or resume time. It owns that copy.
        parking = text
        render()
      }
      // Pi contexts have live getters (notably model/sessionManager). A plain
      // spread would freeze them while a command is selecting another model.
      const context = Object.defineProperties(
        { ...ctx },
        {
          ...Object.getOwnPropertyDescriptors(ctx),
          ...(ctx.ui === undefined
            ? {}
            : {
                ui: { value: { ...ctx.ui, setStatus }, enumerable: true, configurable: true },
              }),
        },
      )
      return {
        context,
        clear(): void {
          if (owned === generation) reset()
        },
        show,
        /** Call only after admission, never for a preview or a parked route. */
        dispatched(
          model: { readonly id: string },
          info: {
            readonly tier: TierName
            readonly retry: boolean
            readonly state: { readonly escalations: number; readonly restarts: number } | undefined
          },
        ): void {
          if (owned !== generation) return
          parking = undefined
          if (degraded) {
            show({ kind: "degraded" })
            return
          }
          let kind: "routing" | "recovering" | "escalated" = "routing"
          if (info.retry || (info.state?.restarts ?? 0) > 0) kind = "recovering"
          else if ((info.state?.escalations ?? 0) > 0) kind = "escalated"
          show({
            kind,
            tier: info.tier,
            model: model.id,
          })
        },
        /** Substitute only this method in parking's ctx.ui; keep its other methods. */
        setStatus,
      }
    },
  }
}
