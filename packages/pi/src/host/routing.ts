import type { Api, Model } from "@earendil-works/pi-ai"
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate"
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent"
import { planWake, resourceUsableAt } from "@coool/adaptive-core/execution/parking/wake"
import { resourceChain } from "@coool/adaptive-core/health/resource-health/key"
import { checkCompatibility } from "@coool/adaptive-core/routing/compatibility/gate"
import { logFailOpen } from "@coool/adaptive-core/log"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type {
  AdmissionDecision,
  SchedulerInput,
} from "@coool/adaptive-core/routing/scheduler/types"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import { readCapacity } from "../capacity.js"
import { assessCandidates, releaseUnselected, withHealth } from "../health.js"
import { admissionCandidates, routeAdmission, VIRTUAL_IDS, type VirtualID } from "../router.js"
import { requestedTier } from "../session.js"
import {
  parseTaskState,
  planRoute,
  type BranchEntry,
  type RoutePlan,
  type TaskState,
} from "../task.js"
import { WaitCancelled } from "../parking.js"
import type { AdaptiveSources } from "./extension.js"

export interface RouteContext {
  readonly modelRegistry: { getAvailable(): Model<Api>[] }
  readonly sessionManager: { getBranch(): readonly BranchEntry[]; getSessionId?(): string }
  readonly hasUI?: boolean
  readonly mode?: string
  readonly signal?: AbortSignal | undefined
  readonly ui?: Pick<
    ExtensionContext["ui"],
    "setStatus" | "setWidget" | "setWorkingMessage" | "notify" | "confirm"
  >
}

export function physical(registry: RouteContext["modelRegistry"]): Model<Api>[] {
  return registry.getAvailable().filter((model) => model.provider !== "adaptive")
}

export interface Admission {
  readonly decision: AdmissionDecision
  readonly due: number
}

/** One scheduler for preview, dispatch, and re-admission after a wait. */
export async function prepareAdmission(
  id: VirtualID,
  request: ModelRouteRequest,
  ctx: RouteContext,
  sources: AdaptiveSources,
  activeTools: () => readonly string[],
  preview = false,
  resumedInput?: TaskState,
) {
  const current = await sources.settings()
  const declarations = await sources.capabilities()
  const models = physical(ctx.modelRegistry)
  const state = parseTaskState(request.state)
  const computed = planRoute({
    id,
    reason: request.reason,
    state,
    branch: ctx.sessionManager.getBranch(),
    requestedTier: requestedTier(ctx.sessionManager.getBranch()),
    failed:
      request.failed === undefined
        ? undefined
        : {
            model: { providerID: request.failed.model.provider, id: request.failed.model.id },
            message: request.failed.message,
          },
    newId: sources.newId,
  })
  const plan =
    resumedInput === undefined
      ? computed
      : { ...computed, tier: resumedInput.tier, state: resumedInput }
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
  const decide = (
    health: SchedulerInput["health"],
    capacity: SchedulerInput["capacity"],
  ): AdmissionDecision => routeAdmission({ ...input, health, capacity, exclude: plan.exclude })
  /**
   * ADP-003: a defer (an unusable pin) keeps ordinary behaviour — the tier's
   * first resource that passes the compatibility gates, ignoring the pin.
   */
  const deferFallback = (): Model<Api> | undefined =>
    current.tiers[plan.tier]
      .flatMap((ref) =>
        models.filter((model) => model.provider === ref.providerID && model.id === ref.id),
      )
      .find((model) =>
        input.inventory.some(
          (entry) =>
            entry.providerID === model.provider &&
            entry.modelID === model.id &&
            checkCompatibility(entry, input.demand).compatible,
        ),
      )
  const choose = async (ignoreHealth = false): Promise<Admission> => {
    const now = sources.health.clock()
    const fallback = () => ({ decision: decide({}, {}), due: now })
    if (ignoreHealth || plan.sticky) return fallback()
    const candidates = admissionCandidates(current, plan.tier)
    const view = await readCapacity(sources.capacity, candidates)
    // A usage sample describes its old window. Keep it for status, but once
    // its stated reset passes it cannot block admission into the new window.
    const capacity = Object.fromEntries(
      Object.entries(view.capacity).filter(([key]) => {
        const reset = view.readings[key]?.resetAt
        return reset === undefined || reset > now
      }),
    )
    try {
      return await withHealth(sources.health, (registry) => {
        const { health, tickets } = assessCandidates(registry, candidates)
        const decision = decide(health, capacity)
        releaseUnselected(
          registry,
          tickets,
          !preview && decision.kind === "apply" ? decision.model : undefined,
        )
        const targets = candidates.flatMap((ref) => {
          const entry = input.inventory.find(
            (candidate) => candidate.providerID === ref.providerID && candidate.modelID === ref.id,
          )
          if (entry === undefined || !checkCompatibility(entry, input.demand).compatible) return []
          const chain = resourceChain({
            providerID: ref.providerID,
            modelID: ref.id,
            variantID: ref.variant,
          }).map((key) => registry.recordFor(key))
          return [resourceUsableAt(chain, view.readings[schedulerHealthKey(ref)] ?? null, now)]
        })
        const wake = planWake(targets, now, 0)
        return { decision, due: wake?.dueAt ?? now + 300_000 }
      })
    } catch (error) {
      logFailOpen("health", error)
      return fallback()
    }
  }
  return { choose, plan, models, state, deferFallback }
}

export interface RouteParking {
  takeInput(): TaskState | undefined
  blocked(
    plan: RoutePlan,
    admission: Admission,
    request: ModelRouteRequest,
    ctx: RouteContext,
  ): Promise<RoutePlan | undefined>
}

export function virtualModels(
  sources: AdaptiveSources,
  activeTools: () => readonly string[],
  parking?: RouteParking,
  dispatched?: (
    model: Model<Api>,
    info: {
      decision: AdmissionDecision
      unit: string | undefined
      tier: TierName
      session: string | undefined
    },
  ) => void,
) {
  return VIRTUAL_IDS.map((id) => ({
    provider: "adaptive",
    id,
    name: `Adaptive ${id === "auto" ? "Auto" : id}`,
    async route(request: ModelRouteRequest, ctx: RouteContext) {
      const prepared = await prepareAdmission(
        id,
        request,
        ctx,
        sources,
        activeTools,
        false,
        request.reason === "user" ? parking?.takeInput() : undefined,
      )
      let plan = prepared.plan
      let admission: Admission =
        (plan.state?.hops ?? 0) >= 3 && request.reason === "retry"
          ? {
              decision: { kind: "park", reason: "all-blocked", detail: "retry budget spent" },
              due: sources.health.clock() + 300_000,
            }
          : await prepared.choose()
      for (
        let attempt = 0;
        admission.decision.kind === "park" && parking !== undefined && attempt < 4;
        attempt += 1
      ) {
        try {
          const resumed = await parking.blocked(plan, admission, request, ctx)
          if (resumed === undefined) break
          plan = resumed
          admission = await prepared.choose()
        } catch (error) {
          if (error instanceof WaitCancelled) throw error
          logFailOpen("parking", error)
          admission = await prepared.choose(true)
          break
        }
      }
      const { decision } = admission
      let selected: Model<Api> | undefined
      if (decision.kind === "defer") {
        selected = prepared.deferFallback()
        if (selected === undefined)
          throw new Error(
            `Adaptive is not set up: ${decision.reason}. Run /adaptive to set up tiers.`,
          )
      } else {
        if (decision.kind !== "apply")
          throw new Error(`Adaptive unavailable: ${decision.reason}. Check your tier settings.`)
        selected = prepared.models.find(
          (model) => model.provider === decision.model.providerID && model.id === decision.model.id,
        )
        if (selected === undefined) throw new Error("Adaptive inventory changed. Try again.")
      }
      dispatched?.(selected, {
        decision,
        unit: plan.state?.unit,
        tier: plan.tier,
        session: ctx.sessionManager.getSessionId?.(),
      })
      return {
        model: selected,
        thinkingLevel: request.thinkingLevel,
        state: plan.state === prepared.state ? request.state : plan.state,
      }
    },
  }))
}
