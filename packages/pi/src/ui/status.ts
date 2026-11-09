import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"

export type AdaptiveStatus =
  | { readonly kind: "off" }
  | { readonly kind: "observe"; readonly tier: TierName }
  | { readonly kind: "routing"; readonly tier: TierName; readonly model: ModelRef }
  | { readonly kind: "recovering"; readonly tier: TierName; readonly model: ModelRef }
  | { readonly kind: "waiting"; readonly tier: TierName; readonly remainingMs: number }
  | { readonly kind: "parked"; readonly tier: TierName; readonly due: string }
  | { readonly kind: "escalated"; readonly tier: TierName }
  | { readonly kind: "degraded" }
  | { readonly kind: "setup" }

export function statusText(status: AdaptiveStatus): string | undefined {
  switch (status.kind) {
    case "off":
      return undefined
    case "observe":
      return `Observing · would use ${status.tier}`
    case "routing":
      return `${status.tier} · ${resourceLabel(status.model)}`
    case "recovering":
      return `Recovering · ${status.tier} → ${resourceLabel(status.model)}`
    case "waiting": {
      const seconds = Math.max(0, Math.ceil(status.remainingMs / 1000))
      return `${status.tier} waiting · ${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")} · Esc cancels`
    }
    case "parked":
      return `${status.tier} parked · resumes ${status.due} · /adaptive`
    case "escalated":
      return `${status.tier} · escalated for this task`
    case "degraded":
      return "Adaptive degraded · /adaptive doctor"
    case "setup":
      return "Adaptive: set up tiers · /adaptive"
  }
}
