// covers: ["ADP-002", "ADP-005", "ADP-013", "ADP-017", "ADP-022", "ADP-057"]
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
}

export function routeAdmission(input: RouteInput): AdmissionDecision {
  // Native retries stay sticky until the health/recovery milestone owns them.
  // Ordinary tool continuations must never be repriced or re-tiered mid-unit.
  const pin = input.sticky ? input.previous : input.settings.pin
  return admit({
    routing:
      pin === undefined || pin === null
        ? { kind: "tier", tier: input.tier, source: "default" }
        : { kind: "pin", model: pin },
    inventory: input.inventory,
    demand: input.demand,
    tierCandidates: input.settings.tiers[input.tier],
    health: {},
    capacity: {},
  })
}
