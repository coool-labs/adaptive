/**
 * Persisted capacity readings (ADP-020/ADP-031).
 *
 * The host's TUI-mode plugin reconciliation can load the plugin several times
 * into one process: the session hooks (the event pump that observes capacity
 * headers) and the RPC registration that serves status.get can land on
 * DIFFERENT supervisor instances. The in-memory capacity registry lives only
 * on the hook instance, so capacity would be invisible to the status-serving
 * instance — the same trap that health records solve with their persisted
 * mirror. Persisting readings lets every instance read what any instance
 * observed, like receipts/settings/parked work.
 */
import type { ResourceKey } from "../../health/resource-health/types.js"
import type { CapacityReading } from "../../health/capacity/types.js"

/** Storage key for the capacity mirror (bound by the adapter to ctx.storage). */
export const CAPACITY_KEY = "coool.adaptive/capacity"

export const CAPACITY_VERSION = 1

/**
 * Product bound — not a user knob. A capacity reading is only useful while it
 * is fresh (readings older than the max age are treated as absent), so far
 * fewer entries than the health bound suffice to cover every configured
 * resource.
 */
export const MAX_CAPACITY_READINGS = 64

export interface PersistedCapacityReading {
  readonly key: ResourceKey
  readonly reading: CapacityReading
}

export interface CapacityPayload {
  readonly version: typeof CAPACITY_VERSION
  readonly readings: readonly PersistedCapacityReading[]
}

/** Storage seam — the adapter binds `CAPACITY_KEY` to `ctx.storage`. */
export interface CapacityStorage {
  read(): Promise<unknown>
  write(payload: CapacityPayload): Promise<void>
}
