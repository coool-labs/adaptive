import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/continuation/prompts"
import { logFailOpen } from "@coool/adaptive-core/log"
import {
  cancelPark,
  claimPark,
  findPark,
  MAX_WAKES,
  PARK_ENTRY,
  savePark,
  SHORT_WAIT_MS,
  waitUntil,
  WaitCancelled,
  type Parked,
} from "../parking.js"
import {
  CONTINUATION_TYPE,
  startTask,
  type Recovery,
  type RoutePlan,
  type TaskState,
} from "../task.js"
import type { AdaptiveSources, SettleContext } from "./extension.js"
import { prepareAdmission, type RouteContext, type RouteParking } from "./routing.js"
import { selectedVirtual } from "./tools.js"
import {
  clearParked as clear,
  showParked as card,
  parkedPayload as payload,
  type ParkedInput as Input,
  type ParkPayload as Payload,
} from "./parked-view.js"
import type { AdmissionDecision } from "@coool/adaptive-core/routing/scheduler/types"
import { readPreferences } from "../preferences.js"
import { recordReceipt } from "../receipts.js"
import { decisionNote, shouldWriteNote, type AdaptiveNote } from "../ui/notes.js"
import { appendNote } from "./entries.js"
import type { NoteTracker } from "./observe.js"

type Host = Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "sendMessage" | "getActiveTools">
interface ParkingContext extends RouteContext {
  readonly model: Model<Api> | undefined
}
interface ParkingHandlers extends RouteParking {
  readonly input: (event: InputEvent, ctx: ParkingContext) => Promise<InputEventResult>
  modelSelect(
    model: { readonly provider: string; readonly id: string },
    ctx: RouteContext,
  ): Promise<void>
  sessionStart(ctx: ParkingContext): Promise<void>
  /** `/adaptive resume`: wake this session's parked task now. */
  resume(ctx: RouteContext): Promise<void>
  /** `/adaptive cancel`: drop this session's wait and parked record. */
  cancel(ctx: RouteContext): Promise<void>
  readonly shutdown: () => void
  recover(
    recovery: Recovery,
    ctx: SettleContext & Pick<RouteContext, "mode" | "signal" | "ui">,
  ): Promise<boolean>
}
/** Session-bound lifecycle; only TUI wakes may outlive their owning handler. */
export function parkingHandlers(
  pi: Host,
  sources: AdaptiveSources,
  tracker: NoteTracker = { last: undefined },
): ParkingHandlers {
  let active: AbortController | undefined
  let disarm: (() => void) | undefined
  let generation = 0
  let resumedInput: TaskState | undefined
  const stop = () => {
    generation += 1
    resumedInput = undefined
    active?.abort()
    active = undefined
    disarm?.()
    disarm = undefined
  }
  const cancel = async (ctx: RouteContext) => {
    stop()
    clear(ctx)
    const session = ctx.sessionManager.getSessionId?.()
    if (
      session !== undefined &&
      ctx.sessionManager.getBranch().some((entry) => entry.customType === PARK_ENTRY)
    )
      await cancelPark(sources.parking.file, session)
  }
  const noteResume = async (owned: number, tier: RoutePlan["tier"]): Promise<void> => {
    try {
      const { verbosity } = await readPreferences(sources.preferences)
      if (owned !== generation || verbosity === "quiet") return
      appendNote(pi, { version: 1, text: `${tier} resumed · retrying parked work` })
    } catch (error) {
      logFailOpen("notes", error)
    }
  }
  const wake = async (
    ctx: RouteContext,
    record: Parked,
    saved: Payload,
    now = sources.parking.clock(),
    manual = false,
  ) => {
    const owned = generation
    if (!(await claimPark(sources.parking.file, record, now, manual))) {
      clear(ctx)
      return
    }
    if (owned !== generation) return
    clear(ctx)
    if (saved.input !== undefined) {
      resumedInput = { ...saved.state, wakes: record.wakes, wakeToken: record.token }
      const content = [
        { type: "text" as const, text: saved.input.text },
        ...(saved.input.images ?? []),
      ]
      pi.sendUserMessage(content, { expandPromptTemplates: false })
    } else {
      pi.sendMessage(
        {
          customType: CONTINUATION_TYPE,
          content: CONTINUATION_PROMPT,
          display: false,
          details: {
            task: saved.state.task,
            token: record.token,
            tier: record.tier,
            escalations: saved.state.escalations,
            restarts: saved.state.restarts,
            wakes: record.wakes,
            wakeToken: record.token,
            tried: [],
          },
        },
        { triggerTurn: true },
      )
    }
    await noteResume(owned, record.tier)
  }
  const arm = (ctx: RouteContext, record: Parked, saved: Payload) => {
    card(ctx, record)
    if (record.wakes >= MAX_WAKES) return
    const owned = generation
    disarm = sources.parking.timer(
      () => {
        if (owned !== generation) return
        if (sources.parking.clock() < record.due) {
          arm(ctx, record, saved)
          return
        }
        void wake(ctx, record, saved).catch((error: unknown) => {
          logFailOpen("parking", error)
        })
      },
      Math.max(0, Math.min(1_800_000, record.due - sources.parking.clock())),
    )
  }
  const persist = async (ctx: RouteContext, state: TaskState, due: number, input?: Input) => {
    const session = ctx.sessionManager.getSessionId?.()
    if (session === undefined) throw new Error("Adaptive parked: session id missing")
    const record: Parked = {
      session,
      token: sources.newId(),
      tier: state.tier,
      due,
      wakes: state.wakes ?? 0,
      claimed: false,
    }
    const saved: Payload = { token: record.token, state, ...(input === undefined ? {} : { input }) }
    // Pi's session is already a user-content store; the shared index is metadata only.
    pi.appendEntry(PARK_ENTRY, saved)
    await savePark(sources.parking.file, record)
    card(ctx, record)
    // Give-up is a terminal event: no auto wake will fire again, so say so once.
    if (record.wakes >= MAX_WAKES) {
      try {
        appendNote(pi, {
          version: 1,
          text: `Gave up after ${String(record.wakes)} failed resumes · /adaptive resume tries now`,
        })
      } catch (error) {
        logFailOpen("parking", error)
      }
    }
    return { record, saved }
  }
  const wait = async (ctx: RouteContext, due: number, signal?: AbortSignal) => {
    const controller = new AbortController()
    active = controller
    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    try {
      await waitUntil(sources.parking, due, combined, (remaining) => {
        if (!ctx.hasUI) return
        const seconds = Math.ceil(remaining / 1_000)
        const countdown = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`
        const text = `Waiting for a model · ${countdown} · Esc cancels`
        ctx.ui?.setStatus("adaptive", text)
        ctx.ui?.setWorkingMessage(text)
      })
    } finally {
      if (active === controller) active = undefined
      clear(ctx)
    }
  }

  /** Parks are receipted and noted like every other routing decision (ADP-030/058). */
  const parkNote = async (
    session: string,
    tier: RoutePlan["tier"],
    decision: AdmissionDecision,
    unit: string,
  ): Promise<void> => {
    try {
      const receipt = await recordReceipt(sources.receipts, {
        at: sources.parking.clock(),
        sessionID: session,
        unitID: unit,
        tier,
        decision,
      })
      const { verbosity } = await readPreferences(sources.preferences)
      if (!shouldWriteNote(verbosity, decision, tracker.last)) return
      const note: AdaptiveNote = {
        version: 1,
        text: decisionNote(decision, tier),
        receiptID: receipt.id,
      }
      appendNote(pi, note)
      tracker.last = decision
    } catch (error) {
      logFailOpen("receipts", error)
    }
  }

  const input = async (event: InputEvent, ctx: ParkingContext): Promise<InputEventResult> => {
    if (event.source === "extension") return { action: "continue" }
    let parked = false
    const owned = generation + 1
    try {
      await cancel(ctx)
      if (owned !== generation) return { action: "handled" }
      const model = ctx.model
      if (model === undefined) return { action: "continue" }
      const id = selectedVirtual(model)
      // A virtual selection schedules in every global mode (effectiveMode).
      if (id === undefined || event.streamingBehavior !== undefined) return { action: "continue" }
      const prepared = await prepareAdmission(
        id,
        {
          model,
          reason: "user",
          thinkingLevel: "off",
          messages: [
            {
              role: "user",
              timestamp: sources.parking.clock(),
              content: [{ type: "text", text: event.text }, ...(event.images ?? [])],
            },
          ],
        },
        ctx,
        sources,
        () => pi.getActiveTools(),
        true,
      )
      const admission = await prepared.choose()
      if (owned !== generation) return { action: "handled" }
      if (
        admission.decision.kind !== "park" ||
        admission.decision.reason === "no-candidates" ||
        admission.due - sources.parking.clock() <= SHORT_WAIT_MS
      )
        return { action: "continue" }
      // Pi buffers extension entries until its first conversation message. Let the
      // host persist that message; route() can park before any provider dispatch.
      if (
        !ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              (entry.message?.role === "user" || entry.message?.role === "assistant"),
          )
      )
        return { action: "continue" }
      const state = startTask(prepared.plan.tier, sources.newId)
      const { record, saved } = await persist(ctx, state, admission.due, {
        text: event.text,
        ...(event.images === undefined ? {} : { images: event.images }),
      })
      await parkNote(record.session, prepared.plan.tier, admission.decision, state.unit)
      parked = true
      if (owned !== generation) return { action: "handled" }
      if (ctx.mode === "tui") arm(ctx, record, saved)
      else {
        await wait(ctx, record.due, ctx.signal)
        await wake(ctx, record, saved)
      }
      return { action: "handled" }
    } catch (error) {
      if (error instanceof WaitCancelled) {
        if (owned === generation) await cancel(ctx)
      } else logFailOpen("parking", error)
      return {
        action:
          parked || error instanceof WaitCancelled || owned !== generation ? "handled" : "continue",
      }
    }
  }
  const modelSelect: ParkingHandlers["modelSelect"] = async (model, ctx) => {
    if (selectedVirtual(model) !== undefined) return
    try {
      await cancel(ctx)
    } catch (error) {
      logFailOpen("parking", error)
    }
  }
  const sessionStart: ParkingHandlers["sessionStart"] = async (ctx) => {
    stop()
    if (ctx.mode !== "tui" || selectedVirtual(ctx.model) === undefined) return
    try {
      const session = ctx.sessionManager.getSessionId?.()
      if (session === undefined) return
      const record = await findPark(sources.parking.file, session)
      if (record === undefined) return
      const saved = payload(ctx, record.token)
      if (saved === undefined) return
      if (record.due <= sources.parking.clock() && record.wakes < MAX_WAKES) {
        if (await ctx.ui?.confirm("Parked task", "Resume the parked task now?"))
          await wake(ctx, record, saved)
        else await cancel(ctx)
      } else arm(ctx, record, saved)
    } catch (error) {
      logFailOpen("parking", error)
    }
  }
  const resume: ParkingHandlers["resume"] = async (ctx) => {
    const session = ctx.sessionManager.getSessionId?.()
    const record = session === undefined ? undefined : await findPark(sources.parking.file, session)
    const saved = record === undefined ? undefined : payload(ctx, record.token)
    if (record === undefined || saved === undefined) {
      ctx.ui?.notify("Nothing is parked in this session.", "info")
      return
    }
    stop()
    // Resuming early is a request to try again now; routing parks again if the tier is still
    // blocked. Manual resume bypasses the automatic give-up budget — the person decided.
    await wake(ctx, record, saved, record.due, true)
  }
  return {
    input,
    modelSelect,
    sessionStart,
    resume,
    cancel,
    shutdown: stop,
    async recover(recovery, ctx) {
      const id = selectedVirtual(ctx.model)
      const model = ctx.modelRegistry.getAvailable()[0]
      if (id === undefined || model === undefined) return false
      let parked = false
      const owned = generation
      try {
        const state: TaskState = {
          version: 1,
          task: recovery.task,
          unit: sources.newId(),
          tier: recovery.tier,
          escalations: recovery.escalations,
          restarts: recovery.restarts,
          wakes: recovery.wakes ?? 0,
          ...(recovery.wakeToken === undefined ? {} : { wakeToken: recovery.wakeToken }),
          tried: recovery.tried,
        }
        const prepared = await prepareAdmission(
          id,
          { model, reason: "user", thinkingLevel: "off", messages: [] },
          ctx,
          sources,
          () => pi.getActiveTools(),
          true,
          state,
        )
        const admission = await prepared.choose()
        if (owned !== generation) return true
        if (
          admission.decision.kind !== "park" ||
          admission.decision.reason === "no-candidates" ||
          admission.due - sources.parking.clock() <= SHORT_WAIT_MS
        )
          return false
        const { record, saved } = await persist(ctx, state, admission.due)
        await parkNote(record.session, prepared.plan.tier, admission.decision, state.unit)
        parked = true
        if (owned !== generation) return true
        if (ctx.mode === "tui" || record.wakes >= MAX_WAKES) arm(ctx, record, saved)
        else {
          await wait(ctx, record.due, ctx.signal)
          await wake(ctx, record, saved)
        }
        return true
      } catch (error) {
        if (error instanceof WaitCancelled) {
          if (owned === generation) await cancel(ctx)
        } else logFailOpen("parking", error)
        return parked || owned !== generation
      }
    },
    takeInput() {
      const state = resumedInput
      resumedInput = undefined
      return state
    },
    async blocked(plan, admission, request, ctx): Promise<RoutePlan | undefined> {
      const state = plan.state
      if (request.reason === "direct" || state === undefined) return undefined
      const owned = generation
      try {
        if (admission.due - sources.parking.clock() <= SHORT_WAIT_MS) {
          await wait(ctx, admission.due, request.signal)
          return plan
        }
        const { record, saved } = await persist(ctx, state, admission.due)
        if (owned !== generation) return undefined
        // A throwing route never commits its returned state. Save it before parking
        // so an owned hidden continuation can consume the wake token after restart.
        pi.appendEntry("pi.virtual-model-state", {
          provider: "adaptive",
          modelId: request.model.id,
          state,
        })
        await parkNote(record.session, plan.tier, admission.decision, state.unit)
        if (ctx.mode === "tui" || record.wakes >= MAX_WAKES) {
          arm(ctx, record, saved)
          return undefined
        }
        await wait(ctx, record.due, request.signal)
        if (!(await claimPark(sources.parking.file, record, sources.parking.clock())))
          return undefined
        await noteResume(owned, record.tier)
        if (owned !== generation) return undefined
        return {
          ...plan,
          state: {
            ...state,
            unit: sources.newId(),
            wakes: record.wakes,
            wakeToken: record.token,
            hops: 0,
            tried: [],
          },
        }
      } catch (error) {
        if (error instanceof WaitCancelled && owned === generation) await cancel(ctx)
        throw error
      }
    },
  }
}
