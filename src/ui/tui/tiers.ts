/**
 * Tier-editor view models (ADP-033): resource labels with clear health tags,
 * model search over the real OpenCode model list, variant picking, and pure
 * reorder/remove helpers. All functions are total and deterministic.
 */
import type { ModelRef } from "../../core/work-unit/types.js"
import { TIERS } from "../../core/tier-policy/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../rpc/status.js"
import type { SettingsV1 } from "../../state/settings/index.js"
import type { PatchResult } from "../../state/settings/types.js"
import type { SelectOption } from "./options.js"

/** `provider/model` with an `@variant` suffix when pinned to one. */
export function resourceLabel(ref: ModelRef): string {
  const base = `${ref.providerID}/${ref.id}`
  return ref.variant === undefined ? base : `${base}@${ref.variant}`
}

/**
 * Unavailable-resource display: empty string when healthy, otherwise a
 * bracketed, comma-separated tag list (health, breaker, window).
 */
export function healthTag(status: TierResourceStatus | undefined): string {
  if (status === undefined) return ""
  const parts: string[] = []
  if (status.health !== "healthy") parts.push(status.health)
  if (status.breaker === "open") parts.push("breaker-open")
  else if (status.breaker === "half_open") parts.push("half-open")
  if (status.windowed) parts.push("windowed")
  return parts.length === 0 ? "" : ` [${parts.join(", ")}]`
}

export type TierEditorChoice =
  { kind: "add" } | { kind: "resource"; index: number } | { kind: "back" }

export function tierEditorOptions(
  settings: SettingsV1,
  tier: TierName,
  status: StatusSnapshot | undefined,
): SelectOption<TierEditorChoice>[] {
  const options: SelectOption<TierEditorChoice>[] = [
    { title: "Add model…", value: { kind: "add" }, description: "Search OpenCode models" },
  ]
  const tierStatus = status?.tiers[tier]
  settings.tiers[tier].forEach((ref, index) => {
    options.push({
      title: `${resourceLabel(ref)}${healthTag(tierStatus?.[index])}`,
      value: { kind: "resource", index },
      description: "Move or remove",
    })
  })
  options.push({ title: "Back", value: { kind: "back" } })
  return options
}

export function tierMenuOptions(status: StatusSnapshot): SelectOption<TierName>[] {
  return TIERS.map((tier) => ({
    title: `${tier} (${String(status.tiers[tier].length)})`,
    value: tier,
  }))
}

/** Structural summary of one real OpenCode model (built by the entry). */
export interface ModelSummary {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly variants: readonly string[]
}

export interface ModelPick {
  providerID: string
  modelID: string
}

export function modelMatches(info: ModelSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  return (
    info.providerID.toLowerCase().includes(q) ||
    info.modelID.toLowerCase().includes(q) ||
    info.name.toLowerCase().includes(q)
  )
}

export function modelPickerOptions(
  models: readonly ModelSummary[],
  query: string,
): SelectOption<ModelPick>[] {
  return models
    .filter((info) => modelMatches(info, query))
    .map((info) => ({
      title: `${info.providerID}/${info.modelID}`,
      description: info.name,
      value: { providerID: info.providerID, modelID: info.modelID },
    }))
}

export interface VariantChoice {
  variant: string | undefined
}

export function variantOptions(variants: readonly string[]): SelectOption<VariantChoice>[] {
  const options: SelectOption<VariantChoice>[] = [
    { title: "(model default)", value: { variant: undefined } },
  ]
  for (const variant of variants) {
    options.push({ title: `@${variant}`, value: { variant } })
  }
  return options
}

/** Swap the resource at `index` with its `delta` neighbour; bounds are no-ops. */
export function moveResource(
  resources: readonly ModelRef[],
  index: number,
  delta: -1 | 1,
): ModelRef[] {
  const next = [...resources]
  const target = index + delta
  const item = next[index]
  const other = next[target]
  if (item === undefined || other === undefined) return next
  next[index] = other
  next[target] = item
  return next
}

/** Drop the resource at `index`; out-of-bounds keeps the list unchanged. */
export function removeResource(resources: readonly ModelRef[], index: number): ModelRef[] {
  const item = resources[index]
  if (item === undefined) return [...resources]
  return resources.filter((_, i) => i !== index)
}

/** First validation error line for an alert; undefined when the patch applied. */
export function validationMessage(result: PatchResult): string | undefined {
  return result.ok ? undefined : result.errors.join("; ")
}
