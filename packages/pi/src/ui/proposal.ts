// covers: ["ADP-004", "ADP-005", "ADP-063"]
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { MAX_TIER_RESOURCES, type SettingsV1 } from "@coool/adaptive-core/state/settings/types"

export interface ProposalModel {
  readonly ref: ModelRef
  readonly inputCost: number
  readonly outputCost: number
  readonly reasoning: boolean
  readonly contextWindow: number
  readonly thinkingLevels: readonly string[]
}

function identity(model: ProposalModel): string {
  return JSON.stringify([model.ref.providerID, model.ref.id])
}

function cost(model: ProposalModel): number {
  const sum = model.inputCost + model.outputCost
  return Number.isFinite(sum) && model.inputCost >= 0 && model.outputCost >= 0 ? sum : Infinity
}

function order(left: ProposalModel, right: ProposalModel): number {
  const a = cost(left)
  const b = cost(right)
  if (a !== b) return a < b ? -1 : 1
  const l = identity(left)
  const r = identity(right)
  if (l !== r) return l < r ? -1 : 1
  return (
    Number(left.reasoning) - Number(right.reasoning) ||
    left.contextWindow - right.contextWindow ||
    Number(left.thinkingLevels.includes("high")) - Number(right.thinkingLevels.includes("high"))
  )
}

/** Settings bootstrap only: never consulted during routing, and never persists. */
export function proposeTiers(models: readonly ProposalModel[]): SettingsV1["tiers"] {
  const unique = new Map<string, ProposalModel>()
  for (const model of [...models].sort(order)) unique.set(identity(model), model)
  const ordered = [...unique.values()]
  const first = Math.ceil(ordered.length / 3)
  const second = Math.ceil((ordered.length * 2) / 3)
  const refs = (group: readonly ProposalModel[], advanced: boolean): ModelRef[] =>
    group.slice(0, MAX_TIER_RESOURCES).map((model) => ({
      providerID: model.ref.providerID,
      id: model.ref.id,
      ...(advanced && model.reasoning && model.thinkingLevels.includes("high")
        ? { variant: "high" }
        : {}),
    }))
  return {
    quick: refs(ordered.slice(0, first), false),
    standard: refs(ordered.slice(first, second), false),
    advanced: refs(
      ordered
        .slice(second)
        .sort(
          (a, b) =>
            Number(b.reasoning) - Number(a.reasoning) ||
            b.contextWindow - a.contextWindow ||
            order(a, b),
        ),
      true,
    ),
  }
}
