// covers: ["ADP-009", "ADP-013", "ADP-015", "ADP-016", "ADP-017", "ADP-055", "ADP-061"]
/**
 * Branch-aware task state for the Pi virtual models. Everything is derived
 * from the session branch Pi hands us — router state, tool results, and the
 * hidden continuation message — so forking or rewinding a session also
 * rewinds tier requests and escalation budgets. Pure: no Pi imports.
 */
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
import type { FailureClassification } from "@coool/adaptive-core/health/classifier/types"
import {
  CAPABILITY_FAILURE_CATEGORIES,
  escalationDetail,
  MAX_ESCALATIONS_PER_TASK,
  parseEscalationRequest,
} from "@coool/adaptive-core/execution/escalation/index"
import { planEscalation } from "@coool/adaptive-core/routing/scheduler/escalate"
import type { EscalationEvidence } from "@coool/adaptive-core/routing/scheduler/types"
import { isTierName, nextTier } from "@coool/adaptive-core/routing/tier-policy/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { failureEvidence, type FailedMessage } from "./evidence.js"
import type { VirtualID } from "./router.js"

export const TIER_TOOL = "adaptive_tier"
export const CONTINUATION_TYPE = "adaptive.continuation"
// Pi's own custom entry for router state (`VIRTUAL_MODEL_STATE_ENTRY`); the
// constant is not exported from the package root.
const ROUTER_STATE_ENTRY = "pi.virtual-model-state"
/** Infra restarts after a run ended on a provider failure, per task (ADP-061). */
export const MAX_RESTARTS_PER_TASK = 2

/** The structural subset of Pi's `SessionEntry` this module reads. */
export interface BranchEntry {
  readonly type: string
  readonly customType?: string
  readonly data?: unknown
  readonly details?: unknown
  readonly message?: BranchMessage
}

interface BranchMessage {
  readonly role: string
  readonly toolName?: string
  readonly details?: unknown
  readonly provider?: string
  readonly model?: string
  readonly stopReason?: string
  readonly errorMessage?: string
}

/** Router state stored by Pi on the branch for one virtual model. */
export interface TaskState {
  readonly version: 1
  readonly task: string
  readonly unit: string
  readonly tier: TierName
  readonly escalations: number
  readonly restarts: number
  readonly hops?: number
  readonly wakes?: number
  /** Models this unit failed over from; new admissions in the unit avoid them. */
  readonly tried: readonly ModelRef[]
  /** Token of the last owned continuation already turned into a unit. */
  readonly consumed?: string
}

/** Details of the hidden continuation message that continues a task. */
export interface Recovery {
  readonly task: string
  readonly token: string
  readonly tier: TierName
  readonly escalations: number
  readonly restarts: number
  readonly wakes?: number
  /** Models the new unit starts out avoiding (the one that just failed). */
  readonly tried: readonly ModelRef[]
}

export interface RoutePlan {
  readonly tier: TierName
  /** Keep the previous physical model (in-unit continuation or retry). */
  readonly sticky: boolean
  /** Models a non-sticky admission avoids while the tier has alternatives. */
  readonly exclude: readonly ModelRef[]
  readonly state: TaskState | undefined
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function text(value: unknown, key: string, label: string): string {
  const found = field(value, key)
  if (typeof found !== "string" || found.length === 0)
    throw new Error(`${label}: ${key} must be a non-empty string`)
  return found
}

function tier(value: unknown, label: string): TierName {
  const found = field(value, "tier")
  if (typeof found !== "string" || !isTierName(found))
    throw new Error(`${label}: tier must be quick, standard, or advanced`)
  return found
}

function count(value: unknown, key: string, label: string): number {
  const found = field(value, key)
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found < 0)
    throw new Error(`${label}: ${key} must be a non-negative integer`)
  return found
}

function parkingCounts(
  value: unknown,
  label: string,
): { readonly wakes?: number; readonly hops?: number } {
  return {
    ...(field(value, "wakes") === undefined ? {} : { wakes: count(value, "wakes", label) }),
    ...(field(value, "hops") === undefined ? {} : { hops: count(value, "hops", label) }),
  }
}

function refs(value: unknown, label: string): ModelRef[] {
  const found = field(value, "tried")
  if (!Array.isArray(found)) throw new Error(`${label}: tried must be an array`)
  return found.map((entry: unknown, index) => ({
    providerID: text(entry, "providerID", `${label}: tried[${String(index)}]`),
    id: text(entry, "id", `${label}: tried[${String(index)}]`),
  }))
}

function sameRef(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.id === right.id
}

/** Total parser for persisted router state; `undefined` means none yet. */
export function parseTaskState(value: unknown): TaskState | undefined {
  if (value === undefined) return undefined
  const label = "Adaptive task state"
  if (field(value, "version") !== 1) throw new Error(`${label}: version must be 1`)
  const consumed = field(value, "consumed")
  if (consumed !== undefined && (typeof consumed !== "string" || consumed.length === 0))
    throw new Error(`${label}: consumed must be a non-empty string`)
  return {
    version: 1,
    task: text(value, "task", label),
    unit: text(value, "unit", label),
    tier: tier(value, label),
    escalations: count(value, "escalations", label),
    restarts: count(value, "restarts", label),
    ...parkingCounts(value, label),
    tried: refs(value, label),
    ...(consumed === undefined ? {} : { consumed }),
  }
}

function parseRecovery(value: unknown): Recovery {
  const label = "Adaptive continuation"
  return {
    task: text(value, "task", label),
    token: text(value, "token", label),
    tier: tier(value, label),
    escalations: count(value, "escalations", label),
    restarts: count(value, "restarts", label),
    ...parkingCounts(value, label),
    tried: refs(value, label),
  }
}

/** Latest router state Pi stored on this branch for `adaptive/<id>`. */
export function branchState(branch: readonly BranchEntry[], id: VirtualID): TaskState | undefined {
  const entry = branch.findLast(
    (candidate) =>
      candidate.type === "custom" &&
      candidate.customType === ROUTER_STATE_ENTRY &&
      field(candidate.data, "provider") === "adaptive" &&
      field(candidate.data, "modelId") === id,
  )
  return parseTaskState(field(entry?.data, "state"))
}

function toolResults(branch: readonly BranchEntry[], name: string): unknown[] {
  return branch.flatMap((entry) =>
    entry.message?.role === "toolResult" && entry.message.toolName === name
      ? [entry.message.details]
      : [],
  )
}

/** The latest recorded `adaptive_tier` request (sticky for the session branch). */
export function tierRequest(branch: readonly BranchEntry[]): TierName | undefined {
  const recorded = toolResults(branch, TIER_TOOL)
    .map((details) => field(details, "tier"))
    .findLast((value) => typeof value === "string" && isTierName(value))
  return typeof recorded === "string" && isTierName(recorded) ? recorded : undefined
}

function isUnitStart(entry: BranchEntry): boolean {
  return (
    entry.message?.role === "user" ||
    (entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE)
  )
}

/** Entries of the current unit: everything after the latest unit start. */
function currentUnit(branch: readonly BranchEntry[]): readonly BranchEntry[] {
  return branch.slice(branch.findLastIndex(isUnitStart) + 1)
}

/**
 * The owned continuation that the next `continuation` route must turn into a
 * new unit. Only our hidden message, as the latest conversation entry, for
 * the branch's current task and not yet consumed — any other extension's
 * message or a user prompt in between invalidates it.
 */
export function pendingRecovery(
  branch: readonly BranchEntry[],
  state: TaskState | undefined,
): Recovery | undefined {
  const latest = branch.findLast(
    (entry) => entry.type === "message" || entry.type === "custom_message",
  )
  if (
    state === undefined ||
    latest?.type !== "custom_message" ||
    latest.customType !== CONTINUATION_TYPE
  )
    return undefined
  const recovery = parseRecovery(latest.details)
  return recovery.task === state.task && recovery.token !== state.consumed ? recovery : undefined
}

/** The request Pi is retrying: what failed and on which physical model. */
export interface FailedRequest {
  readonly model: ModelRef
  readonly message: FailedMessage
}

export interface PlanRouteInput {
  readonly id: VirtualID
  readonly reason: "user" | "continuation" | "retry" | "direct"
  readonly state: TaskState | undefined
  readonly branch: readonly BranchEntry[]
  /** ADP-055: sticky session-tier requests rank under a user pin, above the default. */
  readonly requestedTier?: TierName | null | undefined
  readonly failed?: FailedRequest | undefined
  readonly newId: () => string
}

export function startTask(tier: TierName, newId: () => string): TaskState {
  return { version: 1, task: newId(), unit: newId(), tier, escalations: 0, restarts: 0, tried: [] }
}

/** Infra failures that another resource of the same tier may absorb. */
export function infraFailure(message: FailedMessage): FailureClassification | undefined {
  const classification = classifyFailure(failureEvidence(message))
  return classification.failoverEligible ? classification : undefined
}

/**
 * Which tier admits this request and how the task state moves. A user prompt
 * starts a new task (escalations and restarts never carry over); an owned
 * continuation starts a new unit of the same task; a native retry after an
 * infra failure re-admits within the tier, avoiding the models that failed
 * (ADP-009/013 — never a capability escalation); everything else stays
 * in-unit on the previous model.
 */
export function planRoute(input: PlanRouteInput): RoutePlan {
  const selected: TierName = input.id === "auto" ? "standard" : input.id
  const { state } = input
  if (input.reason === "direct")
    return { tier: "quick", sticky: false, exclude: [], state: input.state }
  if (input.reason === "user") {
    const base =
      input.id === "auto"
        ? (input.requestedTier ?? tierRequest(input.branch) ?? selected)
        : selected
    return {
      tier: base,
      sticky: false,
      exclude: [],
      state: startTask(base, input.newId),
    }
  }
  if (input.reason === "retry" && state !== undefined && input.failed !== undefined) {
    const failed = input.failed
    if (infraFailure(failed.message) !== undefined) {
      const tried = state.tried.some((ref) => sameRef(ref, failed.model))
        ? state.tried
        : [...state.tried, failed.model]
      return {
        tier: state.tier,
        sticky: false,
        exclude: tried,
        state: { ...state, tried, hops: (state.hops ?? 0) + 1 },
      }
    }
  }
  const recovery =
    input.reason === "continuation" ? pendingRecovery(input.branch, state) : undefined
  if (recovery === undefined)
    return { tier: state?.tier ?? selected, sticky: true, exclude: [], state }
  return {
    tier: recovery.tier,
    sticky: false,
    exclude: recovery.tried,
    state: {
      version: 1,
      task: recovery.task,
      unit: input.newId(),
      tier: recovery.tier,
      escalations: recovery.escalations,
      restarts: recovery.restarts,
      ...(recovery.wakes === undefined ? {} : { wakes: recovery.wakes }),
      tried: recovery.tried,
      consumed: recovery.token,
    },
  }
}

/** Escalation requests recorded by `adaptive_escalate` during the current unit. */
export function unitEvidence(branch: readonly BranchEntry[], tool: string): EscalationEvidence[] {
  return toolResults(currentUnit(branch), tool).flatMap((details) => {
    const request = parseEscalationRequest(details)
    return request === undefined
      ? []
      : [{ kind: "agent-request", detail: escalationDetail(request) }]
  })
}

export interface AfterRunInput {
  readonly id: VirtualID
  readonly escalateFromPinned: boolean
  /** The host resolves virtual selection and branch overrides before settling. */
  readonly settings: SettingsV1
  readonly branch: readonly BranchEntry[]
  /** Physical models Pi can dispatch right now. */
  readonly available: readonly ModelRef[]
  readonly tool: string
  readonly newId: () => string
}

interface FailedRun {
  readonly state: TaskState
  readonly model: ModelRef
  readonly classification: FailureClassification
}

/**
 * The failure the settled run ended on, for an unpinned task in active mode.
 * Without a user pin the routing is Adaptive's; with one it never recovers on
 * the user's behalf.
 */
function failedRun(input: AfterRunInput): FailedRun | undefined {
  if (input.settings.mode !== "active" || input.settings.pin !== null) return undefined
  const state = branchState(input.branch, input.id)
  const last = currentUnit(input.branch).findLast((entry) => entry.message?.role === "assistant")
  const message = last?.message
  // A run Adaptive's own route ended (Pi records it under the virtual model)
  // carries no provider evidence to recover from.
  if (state === undefined || message?.stopReason !== "error" || message.provider === "adaptive")
    return undefined
  return {
    state,
    model: { providerID: message.provider ?? "", id: message.model ?? "" },
    classification: classifyFailure(
      failureEvidence({ stopReason: message.stopReason, errorMessage: message.errorMessage }),
    ),
  }
}

/**
 * Decide, after a run settles, whether the task continues one tier up
 * (ADP-015..017). Pinned tiers require explicit user opt-in. Only a capability-class
 * failure of the run's last request, only to a configured, dispatchable
 * next-tier model, within the per-task budget. A successful run never
 * escalates, whatever the agent requested.
 */
export function escalationAfterRun(input: AfterRunInput): Recovery | undefined {
  const run = input.id === "auto" || input.escalateFromPinned ? failedRun(input) : undefined
  if (run === undefined || !CAPABILITY_FAILURE_CATEGORIES.includes(run.classification.category))
    return undefined
  const { state } = run
  const next = nextTier(state.tier)
  const plan = planEscalation({
    currentModel: run.model,
    currentTier: state.tier,
    nextTierResources: (next === undefined ? [] : input.settings.tiers[next]).filter((ref) =>
      input.available.some((model) => sameRef(model, ref)),
    ),
    evidence: [
      ...unitEvidence(input.branch, input.tool),
      { kind: "repeated-failure", detail: run.classification.category },
    ],
    budget: { used: state.escalations, max: MAX_ESCALATIONS_PER_TASK },
  })
  if (plan.kind !== "escalate") return undefined
  return {
    task: state.task,
    token: input.newId(),
    tier: plan.tier,
    escalations: state.escalations + 1,
    restarts: state.restarts,
    ...(state.wakes === undefined ? {} : { wakes: state.wakes }),
    tried: [],
  }
}

/**
 * Decide, after a run settles on an infra failure Pi did not (or could no
 * longer) retry — quota and billing errors are never retried natively —
 * whether the task continues on another model of the SAME tier (ADP-061).
 * Bounded per task; the failed model is avoided while the tier has another.
 */
export function restartAfterRun(input: AfterRunInput): Recovery | undefined {
  const run = failedRun(input)
  if (!run?.classification.failoverEligible) return undefined
  const { state } = run
  if (state.restarts >= MAX_RESTARTS_PER_TASK) return undefined
  return {
    task: state.task,
    token: input.newId(),
    tier: state.tier,
    escalations: state.escalations,
    restarts: state.restarts + 1,
    ...(state.wakes === undefined ? {} : { wakes: state.wakes }),
    // A failure without provider metadata names no model to avoid; an empty
    // reference would make the continuation unparseable.
    tried: [run.model].filter((ref) => ref.providerID !== "" && ref.id !== ""),
  }
}

/** A spent immediate-restart budget may still wait for an actual tier reset. */
export function parkingAfterRun(input: AfterRunInput): Recovery | undefined {
  const run = failedRun(input)
  if (!run?.classification.failoverEligible || run.state.restarts < MAX_RESTARTS_PER_TASK)
    return undefined
  return {
    task: run.state.task,
    token: input.newId(),
    tier: run.state.tier,
    escalations: run.state.escalations,
    restarts: run.state.restarts,
    wakes: run.state.wakes ?? 0,
    tried: [],
  }
}
