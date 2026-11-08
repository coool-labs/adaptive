/**
 * Persisted resource health records. Health is otherwise memory-only state,
 * but the host's TUI-mode plugin reconciliation can load the plugin several
 * times into one process — hooks (the event pump) and RPC registration can
 * end up on different instances. Without persistence the status surface is
 * served by an instance whose registry never observed anything; persisted
 * records make health readable by every instance, exactly like receipts,
 * settings and parked work.
 */
import type { ResourceRecord } from "../../health/resource-health/types.js"

export const HEALTH_KEY = "coool.adaptive/health"
export const HEALTH_VERSION = 1
/** Product bound — not a user knob. Keeps the most recently updated records. */
export const MAX_HEALTH_RECORDS = 512

export interface HealthPayload {
  readonly version: typeof HEALTH_VERSION
  readonly records: readonly ResourceRecord[]
}

/** Storage seam — the adapter binds `HEALTH_KEY` to `ctx.storage`. */
export interface HealthStorage {
  read(): Promise<unknown>
  write(payload: HealthPayload): Promise<void>
}
