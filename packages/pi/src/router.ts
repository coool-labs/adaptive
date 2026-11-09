// covers: ["ADP-002", "ADP-005", "ADP-009", "ADP-013", "ADP-017", "ADP-022", "ADP-057"]
import { admit } from "@coool/adaptive-core/routing/scheduler/admit"
import type {
  SchedulerInput,
  AdmissionDecision,
} from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"

export const VIRTUAL_IDS = ["auto", "quick", "standard", "advanced"] as const
export type VirtualID = (typeof VIRTUAL_IDS)[number]

export interface RouteInput {
  readonly tier: TierName
  /** In-unit request: keep the previous physical model when there is one. */
  readonly sticky: boolean
  readonly settings: SettingsV1
  readonly previous: ModelRef | undefined
  readonly inventory: SchedulerInput["inventory"]
  readonly demand: SchedulerInput["demand"]
  readonly health: SchedulerInput["health"]
  /** Models this unit already failed over from (same-tier recovery). */
  readonly exclude: readonly ModelRef[]
}

/** The models a non-sticky admission may dispatch, before exclusions. */
export function admissionCandidates(settings: SettingsV1, tier: TierName): readonly ModelRef[] {
  return settings.pin === null ? settings.tiers[tier] : [settings.pin]
}

function excluded(exclude: readonly ModelRef[], ref: ModelRef): boolean {
  return exclude.some((tried) => tried.providerID === ref.providerID && tried.id === ref.id)
}

/**
 * Admit within the tier, never across it. Recovery first avoids the models
 * this unit already failed on; when nothing else in the tier can take the
 * work, the failed model stays eligible so Pi's own backoff retry proceeds
 * unless health blocks it. A user pin always wins and is never excluded.
 */
export function routeAdmission(input: RouteInput): AdmissionDecision {
  // Ordinary tool continuations must never be repriced or re-tiered mid-unit.
  const pin = input.sticky ? input.previous : input.settings.pin
  const decide = (exclude: readonly ModelRef[]) =>
    admit({
      routing:
        pin === undefined || pin === null
          ? { kind: "tier", tier: input.tier, source: "default" }
          : { kind: "pin", model: pin },
      inventory: input.inventory,
      demand: input.demand,
      tierCandidates: input.settings.tiers[input.tier].filter((ref) => !excluded(exclude, ref)),
      health: input.health,
      capacity: {},
    })
  const decision = decide(input.exclude)
  return decision.kind === "apply" || input.exclude.length === 0 ? decision : decide([])
}
