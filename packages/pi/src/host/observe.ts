// covers: ["ADP-029"]
import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { convertToLlm } from "@earendil-works/pi-coding-agent"
import { forMode } from "@coool/adaptive-core/routing/scheduler/mode"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { logFailOpen } from "@coool/adaptive-core/log"
import { readPreferences } from "../preferences.js"
import { recordReceipt } from "../receipts.js"
import { effectiveMode } from "../session.js"
import { decisionNote, shouldWriteNote, type AdaptiveNote } from "../ui/notes.js"
import { appendNote } from "./entries.js"
import type { AdaptiveSources } from "./extension.js"
import { prepareAdmission, type RouteContext } from "./routing.js"
import { selectedVirtual } from "./tools.js"

type Host = Pick<ExtensionAPI, "appendEntry" | "getActiveTools">
interface ObserveContext extends RouteContext {
  readonly model: Model<Api> | undefined
}

type ObserveFeedback =
  { readonly kind: "observing"; readonly tier: TierName } | { readonly kind: "degraded" }

/** The last decision a transcript note was written for, across handlers. */
export interface NoteTracker {
  last: Decision | undefined
}

/**
 * Manual-model sessions run the identical scheduler; nothing is ever applied
 * and the model keeps the user's choice (ADP-029). Runs on the same `input`
 * boundary the virtual dispatch uses, and never intercepts.
 */
export function observeInput(
  pi: Host,
  sources: AdaptiveSources,
  tracker: NoteTracker,
  feedback?: (ctx: ObserveContext) => (state: ObserveFeedback) => void,
): (event: InputEvent, ctx: ObserveContext) => Promise<InputEventResult> {
  return async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" }
    let report: ((state: ObserveFeedback) => void) | undefined
    try {
      const model = ctx.model
      if (model === undefined || selectedVirtual(model) !== undefined) return { action: "continue" }
      const captured = feedback?.(ctx)
      report = (state) => {
        try {
          captured?.(state)
        } catch (error) {
          logFailOpen("status", error)
        }
      }
      const settings = await sources.settings()
      if (effectiveMode(model, settings.mode, ctx.sessionManager.getBranch()) !== "observe")
        return { action: "continue" }
      if (ctx.sessionManager.buildSessionProjection === undefined) return { action: "continue" }
      const history = convertToLlm(ctx.sessionManager.buildSessionProjection().messages)
      const status = { degraded: false }
      const prepared = await prepareAdmission(
        "auto",
        {
          model,
          reason: "user",
          thinkingLevel: "off",
          messages: [
            ...history,
            {
              role: "user",
              timestamp: sources.health.clock(),
              content: [{ type: "text", text: event.text }, ...(event.images ?? [])],
            },
          ],
        },
        ctx,
        sources,
        () => pi.getActiveTools(),
        true,
        undefined,
        () => {
          status.degraded = true
        },
      )
      const chosen = await prepared.choose()
      if (status.degraded) report({ kind: "degraded" })
      else report({ kind: "observing", tier: prepared.plan.tier })
      const decision = forMode(chosen.decision, "observe")
      const session = ctx.sessionManager.getSessionId?.()
      if (session !== undefined) {
        const receipt = await recordReceipt(sources.receipts, {
          at: sources.health.clock(),
          sessionID: session,
          tier: prepared.plan.tier,
          decision,
        })
        const { verbosity } = await readPreferences(sources.preferences)
        if (shouldWriteNote(verbosity, decision, tracker.last)) {
          const note: AdaptiveNote = {
            version: 1,
            text: decisionNote(decision, prepared.plan.tier),
            receiptID: receipt.id,
          }
          appendNote(pi, note)
          tracker.last = decision
        }
      }
    } catch (error) {
      report?.({ kind: "degraded" })
      logFailOpen("observe", error)
    }
    return { action: "continue" }
  }
}
