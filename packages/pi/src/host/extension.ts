import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate"
import { admit } from "@coool/adaptive-core/routing/scheduler/admit"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { routeAdmission, VIRTUAL_IDS } from "../router.js"

export function registerAdaptive(
  pi: Pick<ExtensionAPI, "registerVirtualModel" | "getActiveTools">,
  settings: () => Promise<SettingsV1>,
): void {
  for (const definition of virtualModels(settings, () => pi.getActiveTools()))
    pi.registerVirtualModel(definition)
}

export function virtualModels(
  settings: () => Promise<SettingsV1>,
  activeTools: () => readonly string[],
) {
  return VIRTUAL_IDS.map((id) => ({
    provider: "adaptive",
    id,
    name: `Adaptive ${id === "auto" ? "Auto" : id}`,
    async route(
      request: ModelRouteRequest,
      ctx: { modelRegistry: { getAvailable(): Model<Api>[] } },
    ) {
      const current = await settings()
      const models = ctx.modelRegistry
        .getAvailable()
        .filter((model) => model.provider !== "adaptive")
      const previous = request.previous?.model
      const input = {
        id,
        reason: request.reason,
        settings: current,
        previous:
          previous === undefined ? undefined : { providerID: previous.provider, id: previous.id },
        inventory: models.map((model) => ({
          providerID: model.provider,
          modelID: model.id,
          enabled: true,
          providerEnabled: true,
          variantAvailable: true,
          capabilities: { input: model.input, output: ["text"] },
          limit: { context: model.contextWindow },
        })),
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
      return { model: selected, thinkingLevel: request.thinkingLevel }
    },
  }))
}
