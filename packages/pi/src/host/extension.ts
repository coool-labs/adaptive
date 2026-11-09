import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/continuation/prompts"
import { ESCALATION_TOOL_NAME } from "@coool/adaptive-core/execution/escalation/index"
import { logFailOpen } from "@coool/adaptive-core/log"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ReceiptOutcome } from "@coool/adaptive-core/state/receipts/types"
import { readPreferences } from "../preferences.js"
import { attachReceiptOutcome, recordReceipt } from "../receipts.js"
import { effectiveMode, requestedTier } from "../session.js"
import type { JsonFile, JsonTransactionFile } from "../store.js"
import { decisionNote, pausedNote, shouldWriteNote, type AdaptiveNote } from "../ui/notes.js"
import { observeOutcome, withHealth, type SharedHealth } from "../health.js"
import type { ToolCapability } from "../capabilities.js"
import type { ParkingSources } from "../parking.js"
import type { SharedCapacity } from "../capacity.js"
import { dispatchCapacity } from "./dispatch-capacity.js"
import { appendNote, registerEntries } from "./entries.js"
import { observeInput, type NoteTracker } from "./observe.js"
import {
  CONTINUATION_TYPE,
  escalationAfterRun,
  restartAfterRun,
  parkingAfterRun,
  servedTask,
  type BranchEntry,
  type Recovery,
} from "../task.js"
import { escalationTool, selectedVirtual, tierTool } from "./tools.js"
import { physical, virtualModels, type RouteContext } from "./routing.js"
import { parkingHandlers } from "./parking.js"
import { adaptiveSurface, type HostSources } from "./adaptive.js"
import { createStatusChip } from "./status-chip.js"

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
  | "registerCommand"
  | "registerShortcut"
  | "setModel"
  | "registerEntryRenderer"
>

export interface SettleContext extends Omit<RouteContext, "ui"> {
  readonly model: { readonly provider: string; readonly id: string } | undefined
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type?: "info" | "warning" | "error"): void }
}

export function registerAdaptive(pi: Host, sources: AdaptiveSources, host: HostSources): void {
  const capacity = dispatchCapacity(sources.capacity)
  const status = createStatusChip()
  const refreshStatus = (ctx: ExtensionContext) => {
    const feedback = status.connect(ctx)
    return async (): Promise<void> => {
      if (!ctx.hasUI) return
      try {
        const current = await sources.settings()
        const branch = ctx.sessionManager.getBranch()
        const id = selectedVirtual(ctx.model)
        const mode = effectiveMode(ctx.model, current.mode, branch)
        const tier = id === undefined || id === "auto" ? (requestedTier(branch) ?? "standard") : id
        if (ctx.model === undefined || mode === "off") feedback.clear()
        else if (id === undefined && mode === "observe") feedback.show({ kind: "observing", tier })
        else if (current.tiers[tier].length === 0) feedback.show({ kind: "setup" })
      } catch (error) {
        feedback.show({ kind: "degraded" })
        logFailOpen("status", error)
      }
    }
  }
  const tracker: NoteTracker = { last: undefined }
  const dispatched: DispatchTracker = { last: undefined }
  /** Every routed turn writes its decision and keeps the outcome attached (ADP-030). */
  const dispatchRecord = async (
    info: {
      decision: Decision
      unit: string | undefined
      tier: TierName
      session: string | undefined
      retry: boolean
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
      text: decisionNote(info.decision, info.tier, info.retry),
      receiptID: receipt.id,
    }
    appendNote(pi, note)
    tracker.last = info.decision
  }
  registerEntries(pi)
  const pausedAt = async (model: { readonly provider: string; readonly id: string }) => {
    try {
      const { verbosity } = await readPreferences(sources.preferences)
      if (verbosity === "quiet") return
      appendNote(pi, { version: 1, text: pausedNote(model) })
      tracker.last = undefined
    } catch (error) {
      logFailOpen("notes", error)
    }
  }
  const parking = parkingHandlers(pi, sources, tracker)
  const surface = adaptiveSurface(
    pi,
    sources,
    host,
    {
      resume: (ctx) => parking.resume(status.connect(ctx).context),
      cancel: (ctx) => parking.cancel(status.connect(ctx).context),
    },
    refreshStatus,
  )
  pi.on("input", async (event, ctx) => {
    const feedback = status.connect(ctx)
    const parked = await parking.input(event, feedback.context)
    if (parked.action === "handled") return parked
    return observeInput(pi, sources, tracker, () => feedback.show)(event, ctx)
  })
  pi.on("model_select", async (event, ctx) => {
    status.reset()
    const feedback = status.connect(ctx)
    const refresh = refreshStatus(ctx)
    if (selectedVirtual(event.model) === undefined) {
      capacity.clear()
      // Only leaving Adaptive is news; startup and restored sessions are not.
      if (selectedVirtual(event.previousModel) !== undefined) await pausedAt(event.model)
    }
    await parking.modelSelect(event.model, feedback.context)
    await refresh()
  })
  pi.on("session_start", async (_event, ctx) => {
    status.reset()
    const feedback = status.connect(ctx)
    const refresh = refreshStatus(ctx)
    capacity.clear()
    tracker.last = undefined
    await refresh()
    await parking.sessionStart(feedback.context)
    try {
      await surface.onboard(ctx)
    } catch (error) {
      logFailOpen("onboarding", error)
    }
  })
  pi.on("session_tree", async (_event, ctx) => {
    status.reset()
    await refreshStatus(ctx)()
  })
  // Receipt writes run beside the turn; settling them before the outcome is
  // attached and before the session goes away keeps both ordered and never
  // touches a replaced session context.
  let pending: Promise<void> = Promise.resolve()
  pi.on("session_shutdown", async () => {
    status.reset()
    parking.shutdown()
    await pending
  })
  for (const definition of virtualModels(
    sources,
    () => pi.getActiveTools(),
    parking,
    (model, info) => {
      capacity.selected(model.provider)
      pending = pending.then(() =>
        dispatchRecord(info, model).catch((error: unknown) => {
          logFailOpen("receipts", error)
        }),
      )
    },
    (ctx) => status.connect(ctx),
  ))
    pi.registerVirtualModel(definition)
  pi.registerTool(tierTool(sources.settings))
  pi.registerTool(
    escalationTool(
      sources.settings,
      async () => (await readPreferences(sources.preferences)).escalateFromPinned,
    ),
  )
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") capacity.clear()
    await pending
    await recordOutcome(event.message, ctx, sources, dispatched)
  })
  pi.on("after_provider_response", (event) => capacity.response(event.headers))
  pi.on("agent_settled", (event, ctx) => {
    capacity.clear()
    const feedback = status.connect(ctx)
    return afterRun(
      event,
      ctx,
      sources,
      (message) => {
        pi.sendMessage(message, { triggerTurn: true })
      },
      (recovery) => parking.recover(recovery, feedback.context),
      (task) => parking.clearServed(task, feedback.context),
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
  /** Called for a wake lineage whose run just finished successfully. */
  clear?: (task: string) => Promise<void>,
): Promise<void> {
  const id = selectedVirtual(ctx.model)
  if (event.aborted || id === undefined) return
  try {
    const settings = await sources.settings()
    const branch = ctx.sessionManager.getBranch()
    const input = {
      id,
      escalateFromPinned: (await readPreferences(sources.preferences)).escalateFromPinned,
      settings: { ...settings, mode: effectiveMode(ctx.model, settings.mode, branch) },
      branch,
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
      if (waiting !== undefined) {
        await park?.(waiting)
        return
      }
      // A resumed lineage that finished leaves a stale park behind when its
      // re-dispatch had to park through a still-blocked window before the
      // follow-up turn succeeded. Drop it so the chip does not promise work
      // that no longer exists.
      const task = servedTask(input)
      if (task !== undefined) await clear?.(task)
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
