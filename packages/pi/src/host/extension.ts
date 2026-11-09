import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/continuation/prompts"
import { ESCALATION_TOOL_NAME } from "@coool/adaptive-core/execution/escalation/index"
import { logFailOpen } from "@coool/adaptive-core/log"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ReceiptOutcome } from "@coool/adaptive-core/state/receipts/types"
import { readPreferences } from "../preferences.js"
import { attachReceiptOutcome, recordReceipt } from "../receipts.js"
import { effectiveMode } from "../session.js"
import type { JsonFile, JsonTransactionFile } from "../store.js"
import { decisionNote, shouldWriteNote, type AdaptiveNote } from "../ui/notes.js"
import { observeOutcome, withHealth, type SharedHealth } from "../health.js"
import type { ToolCapability } from "../capabilities.js"
import type { ParkingSources } from "../parking.js"
import type { SharedCapacity } from "../capacity.js"
import { dispatchCapacity } from "./dispatch-capacity.js"
import { appendNote } from "./entries.js"
import { observeInput, type NoteTracker } from "./observe.js"
import {
  CONTINUATION_TYPE,
  escalationAfterRun,
  restartAfterRun,
  parkingAfterRun,
  type BranchEntry,
  type Recovery,
} from "../task.js"
import { escalationTool, selectedVirtual, tierTool } from "./tools.js"
import { physical, virtualModels, type RouteContext } from "./routing.js"
import { parkingHandlers } from "./parking.js"

export interface AdaptiveSources {
  readonly settings: () => Promise<SettingsV1>
  readonly capabilities: () => Promise<readonly ToolCapability[]>
  readonly newId: () => string
  readonly health: SharedHealth
  readonly parking: ParkingSources
  readonly capacity: SharedCapacity
  readonly receipts: JsonTransactionFile
  readonly preferences: JsonFile
}

type Host = Pick<
  ExtensionAPI,
  | "registerVirtualModel"
  | "getActiveTools"
  | "registerTool"
  | "on"
  | "sendMessage"
  | "sendUserMessage"
  | "appendEntry"
>

export interface SettleContext extends Omit<RouteContext, "ui"> {
  readonly model: { readonly provider: string; readonly id: string } | undefined
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type?: "info" | "warning" | "error"): void }
}

export function registerAdaptive(pi: Host, sources: AdaptiveSources): void {
  const capacity = dispatchCapacity(sources.capacity)
  const tracker: NoteTracker = { last: undefined }
  const dispatched: DispatchTracker = { last: undefined }
  /** Every routed turn writes its decision and keeps the outcome attached (ADP-030). */
  const dispatchRecord = async (
    info: {
      decision: Decision
      unit: string | undefined
      tier: TierName
      session: string | undefined
    },
    model: { readonly provider: string; readonly id: string },
  ): Promise<void> => {
    if (info.session === undefined) return
    const receipt = await recordReceipt(sources.receipts, {
      at: sources.health.clock(),
      sessionID: info.session,
      unitID: info.unit,
      tier: info.tier,
      decision: info.decision,
    })
    if (info.decision.kind === "apply")
      dispatched.last = {
        unit: info.unit,
        session: info.session,
        provider: model.provider,
        model: model.id,
      }
    const { verbosity } = await readPreferences(sources.preferences)
    if (!shouldWriteNote(verbosity, info.decision, tracker.last)) return
    const note: AdaptiveNote = {
      version: 1,
      text: decisionNote(info.decision, info.tier),
      receiptID: receipt.id,
    }
    appendNote(pi, note)
    tracker.last = info.decision
  }
  const parking = parkingHandlers(pi, sources, tracker)
  pi.on("input", async (event, ctx) => {
    const parked = await parking.input(event, ctx)
    if (parked.action === "handled") return parked
    return observeInput(pi, sources, tracker)(event, ctx)
  })
  pi.on("model_select", (event, ctx) => {
    if (selectedVirtual(event.model) === undefined) capacity.clear()
    return parking.modelSelect(event.model, ctx)
  })
  pi.on("session_start", (_event, ctx) => {
    capacity.clear()
    tracker.last = undefined
    return parking.sessionStart(ctx)
  })
  pi.on("session_shutdown", parking.shutdown)
  for (const definition of virtualModels(
    sources,
    () => pi.getActiveTools(),
    parking,
    (model, info) => {
      capacity.selected(model.provider)
      void dispatchRecord(info, model).catch((error: unknown) => {
        logFailOpen("receipts", error)
      })
    },
  ))
    pi.registerVirtualModel(definition)
  pi.registerTool(tierTool(sources.settings))
  pi.registerTool(escalationTool(sources.settings))
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") capacity.clear()
    return recordOutcome(event.message, ctx, sources, dispatched)
  })
  pi.on("after_provider_response", (event) => capacity.response(event.headers))
  pi.on("agent_settled", (event, ctx) => {
    capacity.clear()
    return afterRun(
      event,
      ctx,
      sources,
      (message) => {
        pi.sendMessage(message, { triggerTurn: true })
      },
      (recovery) => parking.recover(recovery, ctx),
    )
  })
}

export interface OutcomeContext {
  readonly model: { readonly provider: string; readonly id: string } | undefined
  readonly sessionManager: { getBranch(): readonly BranchEntry[] }
}

/** The routed dispatch whose receipt outcome is still pending. */
export interface DispatchTracker {
  last:
    | {
        readonly unit: string | undefined
        readonly session: string
        readonly provider: string
        readonly model: string
      }
    | undefined
}

interface DispatchedMessage {
  readonly role: string
  readonly provider?: string
  readonly model?: string
  readonly stopReason?: string
  readonly errorMessage?: string
}

/** Record before Pi retries, so re-admission already sees the failure. */
export async function recordOutcome(
  message: DispatchedMessage,
  ctx: OutcomeContext,
  sources: AdaptiveSources,
  dispatched: DispatchTracker = { last: undefined },
): Promise<void> {
  const { provider, model, stopReason } = message
  if (
    message.role !== "assistant" ||
    provider === undefined ||
    provider === "adaptive" ||
    model === undefined ||
    stopReason === undefined
  )
    return
  try {
    const settings = await sources.settings()
    // OFF never learns: a manual model the user parked away stays untouched.
    if (effectiveMode(ctx.model, settings.mode, ctx.sessionManager.getBranch()) === "off") return
    const classification = await withHealth(sources.health, (registry) =>
      observeOutcome(
        registry,
        { providerID: provider, id: model },
        { stopReason, errorMessage: message.errorMessage },
      ),
    )
    const last = dispatched.last
    if (last === undefined) return
    if (last.provider !== provider || last.model !== model) return
    let outcome: ReceiptOutcome = { status: "succeeded" }
    if (stopReason === "aborted") outcome = { status: "interrupted", reason: "user" }
    else if (stopReason === "error" && classification !== undefined)
      outcome = { status: "failed", category: classification.category }
    await attachReceiptOutcome(
      sources.receipts,
      { sessionID: last.session, unitID: last.unit },
      outcome,
    )
  } catch (error) {
    logFailOpen("health", error)
  }
}

interface ContinuationMessage {
  readonly customType: string
  readonly content: string
  readonly display: false
  readonly details: unknown
}

function recoveryNotice(recovery: Recovery, escalated: boolean): string {
  if (escalated) return `Adaptive: the task needs more capability; continuing on ${recovery.tier}.`
  const failed = recovery.tried.map((ref) => ref.id).join(", ")
  return failed === ""
    ? `Adaptive: the request failed; continuing on ${recovery.tier}.`
    : `Adaptive: ${failed} failed; continuing on another ${recovery.tier} model.`
}

/** Terminal recovery is owned by this handler, never a replay of user input. */
export async function afterRun(
  event: { readonly aborted: boolean },
  ctx: SettleContext,
  sources: AdaptiveSources,
  send: (message: ContinuationMessage) => void,
  park?: (recovery: Recovery) => Promise<boolean>,
): Promise<void> {
  const id = selectedVirtual(ctx.model)
  if (event.aborted || id === undefined) return
  try {
    const input = {
      id,
      settings: await sources.settings(),
      branch: ctx.sessionManager.getBranch(),
      available: physical(ctx.modelRegistry).map((model) => ({
        providerID: model.provider,
        id: model.id,
      })),
      tool: ESCALATION_TOOL_NAME,
      newId: sources.newId,
    }
    const escalation = escalationAfterRun(input)
    const recovery = escalation ?? restartAfterRun(input)
    if (recovery === undefined) {
      const waiting = parkingAfterRun(input)
      if (waiting !== undefined) await park?.(waiting)
      return
    }
    if (await park?.(recovery)) return
    if (ctx.hasUI) ctx.ui.notify(recoveryNotice(recovery, escalation !== undefined))
    send({
      customType: CONTINUATION_TYPE,
      content: CONTINUATION_PROMPT,
      display: false,
      details: recovery,
    })
  } catch (error) {
    logFailOpen("escalation", error)
  }
}
