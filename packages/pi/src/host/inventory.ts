import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Message,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate"
import type { CandidateModel, Demand } from "@coool/adaptive-core/routing/compatibility/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { ModelSummary } from "@coool/adaptive-core/flow/tiers"
import type { ToolCapability } from "../capabilities.js"
import type { ProposalModel } from "../ui/proposal.js"

export function availablePhysicalModels(registry: { getAvailable(): Model<Api>[] }): Model<Api>[] {
  return registry
    .getAvailable()
    .filter((model) => model.provider !== "adaptive" && model.api !== "pi-virtual")
}

/** All thinking variants are explicit SDK capabilities, never inferred from names. */
export function modelInventory(
  models: readonly Model<Api>[],
  declarations: readonly ToolCapability[],
): CandidateModel[] {
  return models.flatMap((model) => {
    const declared = declarations.find(
      (entry) => entry.providerID === model.provider && entry.id === model.id,
    )
    const base: CandidateModel = {
      providerID: model.provider,
      modelID: model.id,
      enabled: true,
      providerEnabled: true,
      capabilities: {
        input: model.input,
        output: ["text"],
        ...(declared === undefined ? {} : { tools: declared.tools }),
      },
      limit: { context: model.contextWindow },
    }
    return [
      base,
      ...getSupportedThinkingLevels(model).map((variant) => ({
        ...base,
        variant,
        variantAvailable: true,
      })),
    ]
  })
}

export function modelSummaries(models: readonly Model<Api>[]): ModelSummary[] {
  return models.map((model) => ({
    providerID: model.provider,
    modelID: model.id,
    name: model.name,
    variants: getSupportedThinkingLevels(model),
  }))
}

export function proposalModels(models: readonly Model<Api>[]): ProposalModel[] {
  return models.map((model) => ({
    ref: { providerID: model.provider, id: model.id },
    inputCost: model.cost.input,
    outputCost: model.cost.output,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    thinkingLevels: getSupportedThinkingLevels(model),
  }))
}

export function requestDemand(messages: readonly Message[], tools: readonly string[]): Demand {
  return {
    tools: tools.length > 0,
    contextTokens: estimateContextTokens(messages).tokens,
    input: messages.some(
      (message) =>
        typeof message.content !== "string" &&
        message.content.some((part) => part.type === "image"),
    )
      ? ["text", "image"]
      : ["text"],
  }
}

export function thinkingLevelFor(
  model: Model<Api>,
  ref: ModelRef,
  requested: ModelThinkingLevel,
): ModelThinkingLevel {
  if (ref.variant === undefined) return clampThinkingLevel(model, requested)
  const level = getSupportedThinkingLevels(model).find((candidate) => candidate === ref.variant)
  if (level === undefined)
    throw new Error("Adaptive variant is unavailable. Check the tier's thinking level.")
  return level
}
