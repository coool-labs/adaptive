/**
 * Status snapshot for the control surfaces (ADP-033): a bounded, secret-free
 * view of the settings and the resource-health state of every configured
 * resource. Pure — the supervisor (or any future caller) gathers the inputs.
 */
import type { OperatingMode } from "./routing/scheduler/types.js"
import { schedulerHealthKey } from "./routing/scheduler/index.js"
import type { ModelRef } from "./routing/work-unit/types.js"
import type { TierName } from "./routing/tier-policy/types.js"
import { TIERS } from "./routing/tier-policy/types.js"
import type { ResourceRecord } from "./health/resource-health/types.js"
import type { CapacityReading } from "./health/capacity/types.js"
import { resourceKeyID } from "./health/resource-health/index.js"
import type { SettingsV1 } from "./state/settings/index.js"

export interface TierResourceStatus {
  ref: ModelRef
  health: ResourceRecord["health"]
  breaker: ResourceRecord["breaker"]["state"]
  windowed: boolean
  /**
   * Wall-clock deadline of the active window (ms epoch); null when unwindowed.
   * Null — not undefined: the host RPC encoder rejects JSON objects carrying a
   * present-but-undefined key ("Expected JSON value"), which 500'd every
   * status.get once any resource was configured.
   */
  windowUntil: number | null
  /** Used capacity as a rounded whole percent; null when no reading exists. */
  usedPercent: number | null
  /** Wall-clock capacity reset deadline (ms epoch); null when unread. */
  resetAt: number | null
}

/** A session whose parked work waits for its tier to recover (ADP-024). */
export interface WaitingSession {
  sessionID: string
  tier: TierName
  /** When the wake resumes it (ms epoch); null when no resource states a reset. */
  resumeAt: number | null
}

export interface StatusSnapshot {
  mode: OperatingMode
  pin: ModelRef | null
  tiers: Readonly<Record<TierName, readonly TierResourceStatus[]>>
  parked: number
  waiting: readonly WaitingSession[]
  receipts: number
}

export function buildStatus(input: {
  settings: SettingsV1
  health: readonly ResourceRecord[]
  capacity: Readonly<Record<string, CapacityReading | null>>
  parked: number
  waiting: readonly WaitingSession[]
  receipts: number
}): StatusSnapshot {
  const byKey = new Map<string, ResourceRecord>()
  for (const record of input.health) byKey.set(resourceKeyID(record.key), record)
  const tiers = {} as Record<TierName, TierResourceStatus[]>
  for (const tier of TIERS) {
    tiers[tier] = input.settings.tiers[tier].map((ref) => {
      const record = byKey.get(schedulerHealthKey(ref))
      const capacityReading = input.capacity[schedulerHealthKey(ref)] ?? null
      return {
        ref,
        health: record?.health ?? "healthy",
        breaker: record?.breaker.state ?? "closed",
        windowed: record?.window !== undefined,
        windowUntil: record?.window?.until ?? null,
        usedPercent: capacityUsedPercent(capacityReading),
        resetAt: capacityReading?.resetAt ?? null,
      }
    })
  }
  return {
    mode: input.settings.mode,
    pin: input.settings.pin,
    tiers,
    parked: input.parked,
    waiting: input.waiting,
    receipts: input.receipts,
  }
}

/**
 * Derives the used-capacity percentage from a reading. Readings may carry any
 * subset of the two ratios: usedRatio directly, or the remainder inferred from
 * remainingRatio. A reading with neither ratio is still present (confidence,
 * resetAt may be set) but yields no percentage — null, not undefined.
 */
function capacityUsedPercent(reading: CapacityReading | null): number | null {
  if (reading?.usedRatio !== undefined) return Math.round(reading.usedRatio * 100)
  if (reading?.remainingRatio !== undefined) return Math.round((1 - reading.remainingRatio) * 100)
  return null
}
