import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/continuation/prompts"
import { ESCALATION_TOOL_NAME } from "@coool/adaptive-core/execution/escalation/index"
import { logFailOpen } from "@coool/adaptive-core/log"
import { admit } from "@coool/adaptive-core/routing/scheduler/admit"
import type {
  AdmissionDecision,
  SchedulerInput,
} from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import {
  assessCandidates,
  observeOutcome,
  releaseUnselected,
  withHealth,
  type SharedHealth,
} from "../health.js"
import { admissionCandidates, routeAdmission, VIRTUAL_IDS } from "../router.js"
import type { ToolCapability } from "../capabilities.js"
import {
  CONTINUATION_TYPE,
  escalationAfterRun,
  parseTaskState,
  planRoute,
  restartAfterRun,
  type BranchEntry,
  type Recovery,
} from "../task.js"
import { escalationTool, selectedVirtual, tierTool } from "./tools.js"

/** Where Adaptive reads its configuration and mints task identifiers. */
export interface AdaptiveSources {
  readonly settings: () => Promise<SettingsV1>
  readonly capabilities: () => Promise<readonly ToolCapability[]>
  readonly newId: () => string
  /** Resource health shared with every other Pi process on the machine. */
  readonly health: SharedHealth
}

type Host = Pick<
  ExtensionAPI,
  "registerVirtualModel" | "getActiveTools" | "registerTool" | "on" | "sendMessage"
>

/** The structural subset of Pi's `ExtensionContext` that routing reads. */
interface RouteContext {
  readonly modelRegistry: { getAvailable(): Model<Api>[] }
  readonly sessionManager: { getBranch(): readonly BranchEntry[] }
}

/** The structural subset of Pi's `ExtensionContext` the settle handler reads. */
export interface SettleContext extends RouteContext {
  readonly model: { readonly provider: string; readonly id: string } | undefined
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type?: "info" | "warning" | "error"): void }
}

export function registerAdaptive(pi: Host, sources: AdaptiveSources): void {
  for (const definition of virtualModels(sources, () => pi.getActiveTools()))
    pi.registerVirtualModel(definition)
  pi.registerTool(tierTool(sources.settings))
  pi.registerTool(escalationTool(sources.settings))
  pi.on("message_end", (event, ctx) => recordOutcome(event.message, ctx, sources))
  pi.on("agent_settled", (event, ctx) =>
    afterRun(event, ctx, sources, (message) => {
      pi.sendMessage(message, { triggerTurn: true })
    }),
  )
}

function physical(registry: RouteContext["modelRegistry"]): Model<Api>[] {
  return registry.getAvailable().filter((model) => model.provider !== "adaptive")
}

export function virtualModels(sources: AdaptiveSources, activeTools: () => readonly string[]) {
  return VIRTUAL_IDS.map((id) => ({
    provider: "adaptive",
    id,
    name: `Adaptive ${id === "auto" ? "Auto" : id}`,
    async route(request: ModelRouteRequest, ctx: RouteContext) {
      const current = await sources.settings()
      const declarations = await sources.capabilities()
      const models = physical(ctx.modelRegistry)
      const state = parseTaskState(request.state)
      const plan = planRoute({
        id,
        reason: request.reason,
        state,
        branch: ctx.sessionManager.getBranch(),
        failed:
          request.failed === undefined
            ? undefined
            : {
                model: { providerID: request.failed.model.provider, id: request.failed.model.id },
                message: request.failed.message,
              },
        newId: sources.newId,
      })
      const previous = request.previous?.model
      const input = {
        tier: plan.tier,
        sticky: plan.sticky,
        settings: current,
        previous:
          previous === undefined ? undefined : { providerID: previous.provider, id: previous.id },
        inventory: models.map((model) => {
          const declared = declarations.find(
            (entry) => entry.providerID === model.provider && entry.id === model.id,
          )
          return {
            providerID: model.provider,
            modelID: model.id,
            enabled: true,
            providerEnabled: true,
            variantAvailable: true,
            capabilities: {
              input: model.input,
              output: ["text"],
              ...(declared === undefined ? {} : { tools: declared.tools }),
            },
            limit: { context: model.contextWindow },
          }
        }),
        demand: {
          tools: activeTools().length > 0,
          contextTokens: estimateContextTokens(request.messages).tokens,
          input: request.messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content !== "string" &&
              message.content.some((part) => part.type === "image"),
          )
            ? ["text", "image"]
            : ["text"],
        },
      }
      // OBSERVE computes the same plan but retains the virtual entry's baseline.
      // OFF skips routing effects too; a virtual entry still needs a real model.
      const baseline =
        current.pin ?? input.previous ?? current.tiers[id === "auto" ? "standard" : id][0]
      const decide = (health: SchedulerInput["health"]): AdmissionDecision =>
        current.mode === "active"
          ? routeAdmission({ ...input, health, exclude: plan.exclude })
          : admit({
              routing:
                baseline === undefined
                  ? { kind: "tier", tier: "standard", source: "default" }
                  : { kind: "pin", model: baseline },
              demand: input.demand,
              inventory: input.inventory,
              tierCandidates: [],
              health: {},
              capacity: {},
            })
      const decision =
        current.mode === "off" || plan.sticky
          ? decide({})
          : await admitWithHealth(sources.health, admissionCandidates(current, plan.tier), decide)
      if (decision.kind !== "apply")
        throw new Error(`Adaptive unavailable: ${decision.reason}. Check your tier settings.`)
      const selected = models.find(
        (model) => model.provider === decision.model.providerID && model.id === decision.model.id,
      )
      if (selected === undefined) throw new Error("Adaptive inventory changed. Try again.")
      // Returning Pi's own state object tells it nothing changed; a new object
      // appends a router-state entry to the branch.
      return {
        model: selected,
        thinkingLevel: request.thinkingLevel,
        state: plan.state === state ? request.state : plan.state,
      }
    },
  }))
}

/**
 * Admit under the shared health lock, handing back every probe ticket the
 * decision does not dispatch. Unreadable or locked health fails open: the
 * admission proceeds without health, as Pi would without Adaptive (ADP-031).
 */
async function admitWithHealth(
  shared: SharedHealth,
  candidates: readonly ModelRef[],
  decide: (health: SchedulerInput["health"]) => AdmissionDecision,
): Promise<AdmissionDecision> {
  try {
    return await withHealth(shared, (registry) => {
      const { health, tickets } = assessCandidates(registry, candidates)
      const decision = decide(health)
      releaseUnselected(registry, tickets, decision.kind === "apply" ? decision.model : undefined)
      return decision
    })
  } catch (error) {
    logFailOpen("health", error)
    return decide({})
  }
}

/** The structural subset of Pi's `ExtensionContext` the outcome recorder reads. */
export interface OutcomeContext {
  readonly model: { readonly provider: string; readonly id: string } | undefined
}

interface DispatchedMessage {
  readonly role: string
  readonly provider?: string
  readonly model?: string
  readonly stopReason?: string
  readonly errorMessage?: string
}

/**
 * Record how each request Adaptive routed ended, before Pi decides whether to
 * retry — so the retry's admission already sees it. OFF records nothing.
 */
export async function recordOutcome(
  message: DispatchedMessage,
  ctx: OutcomeContext,
  sources: AdaptiveSources,
): Promise<void> {
  const { provider, model, stopReason } = message
  if (
    message.role !== "assistant" ||
    selectedVirtual(ctx.model) === undefined ||
    provider === undefined ||
    provider === "adaptive" ||
    model === undefined ||
    stopReason === undefined
  )
    return
  try {
    if ((await sources.settings()).mode === "off") return
    await withHealth(sources.health, (registry) => {
      observeOutcome(
        registry,
        { providerID: provider, id: model },
        { stopReason, errorMessage: message.errorMessage },
      )
    })
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

/**
 * After a run settles, continue the task one tier up when the run failed on
 * a capability gap (ADP-015/016), or on the same tier when it ended on a
 * provider failure Pi did not retry (ADP-061). Aborted runs never continue.
 * Failures are fail-open: the run simply stays failed, as it would without
 * Adaptive.
 */
export async function afterRun(
  event: { readonly aborted: boolean },
  ctx: SettleContext,
  sources: AdaptiveSources,
  send: (message: ContinuationMessage) => void,
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
    if (recovery === undefined) return
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
