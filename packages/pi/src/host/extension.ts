import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate"
import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/continuation/prompts"
import { ESCALATION_TOOL_NAME } from "@coool/adaptive-core/execution/escalation/index"
import { logFailOpen } from "@coool/adaptive-core/log"
import { admit } from "@coool/adaptive-core/routing/scheduler/admit"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { routeAdmission, VIRTUAL_IDS } from "../router.js"
import type { ToolCapability } from "../capabilities.js"
import {
  CONTINUATION_TYPE,
  escalationAfterRun,
  parseTaskState,
  planRoute,
  type BranchEntry,
} from "../task.js"
import { escalationTool, selectedVirtual, tierTool } from "./tools.js"

/** Where Adaptive reads its configuration and mints task identifiers. */
export interface AdaptiveSources {
  readonly settings: () => Promise<SettingsV1>
  readonly capabilities: () => Promise<readonly ToolCapability[]>
  readonly newId: () => string
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
      const planned = routeAdmission(input)
      // OBSERVE computes the same plan but retains the virtual entry's baseline.
      // OFF skips routing effects too; a virtual entry still needs a real model.
      const baseline =
        current.pin ?? input.previous ?? current.tiers[id === "auto" ? "standard" : id][0]
      const decision =
        current.mode === "active"
          ? planned
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

interface ContinuationMessage {
  readonly customType: string
  readonly content: string
  readonly display: false
  readonly details: unknown
}

/**
 * After a run settles, continue the task one tier up when the run failed on
 * a capability gap (ADP-015/016). Aborted runs never continue. Failures are
 * fail-open: the run simply stays failed, as it would without Adaptive.
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
    const recovery = escalationAfterRun({
      id,
      settings: await sources.settings(),
      branch: ctx.sessionManager.getBranch(),
      available: physical(ctx.modelRegistry).map((model) => ({
        providerID: model.provider,
        id: model.id,
      })),
      tool: ESCALATION_TOOL_NAME,
      newId: sources.newId,
    })
    if (recovery === undefined) return
    if (ctx.hasUI)
      ctx.ui.notify(`Adaptive: the task needs more capability; continuing on ${recovery.tier}.`)
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
