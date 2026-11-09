import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { isTierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { object } from "./settings.js"
import { VIRTUAL_IDS } from "./router.js"
import { TIER_TOOL, type BranchEntry } from "./task.js"

export const SESSION_ENTRY = "adaptive.session"
export interface SessionPatch {
  readonly version: 1
  readonly mode?: OperatingMode | null
  readonly tier?: TierName | null
}

function parse(raw: unknown): SessionPatch {
  if (!object(raw) || raw["version"] !== 1) throw new Error("Adaptive session.version: expected 1")
  const mode = raw["mode"]
  const tier = raw["tier"]
  if (
    mode !== undefined &&
    mode !== null &&
    mode !== "off" &&
    mode !== "observe" &&
    mode !== "active"
  )
    throw new Error("Adaptive session.mode: expected off, observe, active, or null")
  if (tier !== undefined && tier !== null && (typeof tier !== "string" || !isTierName(tier)))
    throw new Error("Adaptive session.tier: expected quick, standard, advanced, or null")
  return {
    version: 1,
    ...(mode === undefined ? {} : { mode }),
    ...(tier === undefined ? {} : { tier }),
  }
}

export function sessionModeOverride(branch: readonly BranchEntry[]): OperatingMode | null {
  let mode: OperatingMode | null = null
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue
    const patch = parse(entry.data)
    if (patch.mode !== undefined) mode = patch.mode
  }
  return mode
}

/** A physical selection is always manual, even if the global mode says active. */
export function effectiveMode(
  model: { readonly provider: string; readonly id: string } | undefined,
  global: OperatingMode,
  branch: readonly BranchEntry[],
): OperatingMode {
  if (model?.provider === "adaptive" && VIRTUAL_IDS.some((id) => id === model.id)) return "active"
  const override = sessionModeOverride(branch)
  return (override ?? global) === "off" ? "off" : "observe"
}

/** User dialogs and tool declarations share one chronological, branch-aware request. */
export function requestedTier(branch: readonly BranchEntry[]): TierName | null {
  let tier: TierName | null = null
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_ENTRY) {
      const patch = parse(entry.data)
      if (patch.tier !== undefined) tier = patch.tier
    }
    if (entry.message?.role === "toolResult" && entry.message.toolName === TIER_TOOL) {
      const details = entry.message.details
      if (object(details)) {
        const next = details["tier"]
        if (next === null || (typeof next === "string" && isTierName(next))) tier = next
      }
    }
  }
  return tier
}
