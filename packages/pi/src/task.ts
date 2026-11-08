// covers: ["ADP-015", "ADP-016", "ADP-017", "ADP-055"]
/**
 * Branch-aware task state for the Pi virtual models. Everything is derived
 * from the session branch Pi hands us — router state, tool results, and the
 * hidden continuation message — so forking or rewinding a session also
 * rewinds tier requests and escalation budgets. Pure: no Pi imports.
 */
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
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
import type { VirtualID } from "./router.js"

export const TIER_TOOL = "adaptive_tier"
export const CONTINUATION_TYPE = "adaptive.continuation"
// Pi's own custom entry for router state (`VIRTUAL_MODEL_STATE_ENTRY`); the
// constant is not exported from the package root.
const ROUTER_STATE_ENTRY = "pi.virtual-model-state"

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
  /** Token of the last owned continuation already turned into a unit. */
  readonly consumed?: string
}

/** Details of the hidden continuation message that continues a task. */
export interface Recovery {
  readonly task: string
  readonly token: string
  readonly tier: TierName
  readonly escalations: number
}

export interface RoutePlan {
  readonly tier: TierName
  /** Keep the previous physical model (in-unit continuation or retry). */
  readonly sticky: boolean
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

function count(value: unknown, label: string): number {
  const found = field(value, "escalations")
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found < 0)
    throw new Error(`${label}: escalations must be a non-negative integer`)
  return found
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
    escalations: count(value, label),
    ...(consumed === undefined ? {} : { consumed }),
  }
}

function parseRecovery(value: unknown): Recovery {
  const label = "Adaptive continuation"
  return {
    task: text(value, "task", label),
    token: text(value, "token", label),
    tier: tier(value, label),
    escalations: count(value, label),
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

export interface PlanRouteInput {
  readonly id: VirtualID
  readonly reason: "user" | "continuation" | "retry" | "direct"
  readonly state: TaskState | undefined
  readonly branch: readonly BranchEntry[]
  readonly newId: () => string
}

/**
 * Which tier admits this request and how the task state moves. A user prompt
 * starts a new task (escalations never carry over); an owned continuation
 * starts a new unit of the same task; everything else stays in-unit.
 */
export function planRoute(input: PlanRouteInput): RoutePlan {
  const selected: TierName = input.id === "auto" ? "standard" : input.id
  if (input.reason === "direct") return { tier: "quick", sticky: false, state: input.state }
  if (input.reason === "user") {
    const base = input.id === "auto" ? (tierRequest(input.branch) ?? selected) : selected
    return {
      tier: base,
      sticky: false,
      state: { version: 1, task: input.newId(), unit: input.newId(), tier: base, escalations: 0 },
    }
  }
  const recovery =
    input.reason === "continuation" ? pendingRecovery(input.branch, input.state) : undefined
  if (recovery === undefined)
    return { tier: input.state?.tier ?? selected, sticky: true, state: input.state }
  return {
    tier: recovery.tier,
    sticky: false,
    state: {
      version: 1,
      task: recovery.task,
      unit: input.newId(),
      tier: recovery.tier,
      escalations: recovery.escalations,
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

export interface EscalationInput {
  readonly id: VirtualID
  readonly settings: SettingsV1
  readonly branch: readonly BranchEntry[]
  /** Physical models Pi can dispatch right now. */
  readonly available: readonly ModelRef[]
  readonly tool: string
  readonly newId: () => string
}

/**
 * Decide, after a run settles, whether the task continues one tier up
 * (ADP-015..017). Only Adaptive Auto in active mode without a user pin
 * escalates, only on a capability-class failure of the run's last request,
 * only to a configured, dispatchable next-tier model, within the per-task
 * budget. A successful run never escalates, whatever the agent requested.
 */
export function escalationAfterRun(input: EscalationInput): Recovery | undefined {
  if (input.id !== "auto" || input.settings.mode !== "active" || input.settings.pin !== null)
    return undefined
  const state = branchState(input.branch, input.id)
  const last = currentUnit(input.branch).findLast((entry) => entry.message?.role === "assistant")
  const message = last?.message
  if (state === undefined || message?.stopReason !== "error") return undefined
  const classification = classifyFailure({ text: message.errorMessage ?? "" })
  if (!CAPABILITY_FAILURE_CATEGORIES.includes(classification.category)) return undefined
  const next = nextTier(state.tier)
  const plan = planEscalation({
    currentModel: { providerID: message.provider ?? "", id: message.model ?? "" },
    currentTier: state.tier,
    nextTierResources: (next === undefined ? [] : input.settings.tiers[next]).filter((ref) =>
      input.available.some((model) => model.providerID === ref.providerID && model.id === ref.id),
    ),
    evidence: [
      ...unitEvidence(input.branch, input.tool),
      { kind: "repeated-failure", detail: classification.category },
    ],
    budget: { used: state.escalations, max: MAX_ESCALATIONS_PER_TASK },
  })
  if (plan.kind !== "escalate") return undefined
  return {
    task: state.task,
    token: input.newId(),
    tier: plan.tier,
    escalations: state.escalations + 1,
  }
}
