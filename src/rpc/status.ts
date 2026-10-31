/**
 * Status snapshot for the control surfaces (ADP-033): a bounded, secret-free
 * view of the settings and the resource-health state of every configured
 * resource. Pure — the supervisor (or any future caller) gathers the inputs.
 */
import type { OperatingMode } from "../core/scheduler/types.js"
import { schedulerHealthKey } from "../core/scheduler/index.js"
import type { ModelRef } from "../core/work-unit/types.js"
import type { TierName } from "../core/tier-policy/types.js"
import { TIERS } from "../core/tier-policy/types.js"
import type { ResourceRecord } from "../health/resource-health/types.js"
import { resourceKeyID } from "../health/resource-health/index.js"
import type { SettingsV1 } from "../state/settings/index.js"

export interface TierResourceStatus {
  ref: ModelRef
  health: ResourceRecord["health"]
  breaker: ResourceRecord["breaker"]["state"]
  windowed: boolean
}

export interface StatusSnapshot {
  mode: OperatingMode
  pin: ModelRef | null
  tiers: Readonly<Record<TierName, readonly TierResourceStatus[]>>
  parked: number
  receipts: number
}

export function buildStatus(input: {
  settings: SettingsV1
  health: readonly ResourceRecord[]
  parked: number
  receipts: number
}): StatusSnapshot {
  const byKey = new Map<string, ResourceRecord>()
  for (const record of input.health) byKey.set(resourceKeyID(record.key), record)
  const tiers = {} as Record<TierName, TierResourceStatus[]>
  for (const tier of TIERS) {
    tiers[tier] = input.settings.tiers[tier].map((ref) => {
      const record = byKey.get(schedulerHealthKey(ref))
      return {
        ref,
        health: record?.health ?? "healthy",
        breaker: record?.breaker.state ?? "closed",
        windowed: record?.window !== undefined,
      }
    })
  }
  return {
    mode: input.settings.mode,
    pin: input.settings.pin,
    tiers,
    parked: input.parked,
    receipts: input.receipts,
  }
}
