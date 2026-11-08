/**
 * Persisted per-session tier requests (ADP-055). The agent declares the tier
 * of the task it is starting through the `adaptive_tier` tool and the request
 * steers the session's admissions until cleared. The host's TUI-mode plugin
 * reconciliation can serve RPC from an instance whose routing hooks live on
 * another instance, and a restart must not silently drop the agent's explicit
 * declaration — the records persist through the storage seam like every other
 * state (mirroring the session-mode overrides, ADP-054).
 */
import type { TierName } from "../../routing/tier-policy/types.js"

export type TierRequestSetResult =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }

export const TIER_REQUESTS_KEY = "coool.adaptive/tier-requests"
export const TIER_REQUESTS_VERSION = 1
/** Product bound — not a user knob. Keeps the most recently updated records. */
export const MAX_TIER_REQUEST_RECORDS = 512
/** A session id beyond this bound is not a real host identifier. */
export const MAX_SESSION_ID_LENGTH = 128

export interface TierRequestRecord {
  readonly sessionID: string
  readonly tier: TierName
  readonly updatedAt: number
}

export interface TierRequestsPayload {
  readonly version: typeof TIER_REQUESTS_VERSION
  readonly records: readonly TierRequestRecord[]
}

/** Storage seam — the adapter binds `TIER_REQUESTS_KEY` to `ctx.storage`. */
export interface TierRequestsStorage {
  read(): Promise<unknown>
  write(payload: TierRequestsPayload): Promise<void>
}
