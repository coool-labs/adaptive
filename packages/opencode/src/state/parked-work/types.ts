/**
 * Durable parked work (ADP-024): admission-time records for work with no
 * compatible healthy resource, persisted so they survive restart. A parked
 * record carries only identity and routing context — resumption (T-13) is a
 * clean continuation that re-runs routing fresh; it is never the resurrection
 * of a failed network call.
 */
import type { ParkReason } from "../../core/scheduler/types.js"
import type { TierName } from "../../core/tier-policy/types.js"

export const PARKED_KEY = "coool.adaptive/parked"
export const PARKED_VERSION = 1
/** Product bound — not a user knob. Eviction drops the oldest parkedAt. */
export const MAX_PARKED = 64
/** Free-text detail is bounded like every other persisted string. */
export const MAX_PARKED_TEXT = 128

export interface ParkedRecord {
  /** Unit id (`${sessionID}#${episode}`) — one parked record per unit. */
  readonly id: string
  readonly sessionID: string
  /** Required tier at park time; resumption re-runs routing fresh. */
  readonly tier: TierName
  readonly reason: ParkReason
  readonly detail?: string | undefined
  /** Park timestamp (adapter clock, ms epoch). */
  readonly parkedAt: number
  /**
   * Failed resume attempts (absent = never retried). The resume planner
   * drops records whose attempts reach the planner's budget so a
   * persistently failing continuation cannot retry forever (ADP-011).
   */
  readonly attempts?: number | undefined
}

export interface ParkedPayload {
  readonly version: typeof PARKED_VERSION
  readonly parked: readonly ParkedRecord[]
}

/** Storage seam — the adapter binds `PARKED_KEY` to `ctx.storage`. */
export interface ParkedStorage {
  read(): Promise<unknown>
  write(payload: ParkedPayload): Promise<void>
}
