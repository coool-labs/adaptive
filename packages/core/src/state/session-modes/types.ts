/**
 * Persisted per-session operating-mode overrides (ADP-054). The operating mode
 * is otherwise a global setting, but supervision decisions are made per
 * session — the override lets one session run under a different mode without
 * touching the global default. Records persist through the storage seam like
 * every other state: the host's TUI-mode plugin reconciliation can serve RPC
 * from an instance whose event-pump hooks live on another instance, and a
 * restart must not silently drop explicit user intent.
 */
import type { OperatingMode } from "../../routing/scheduler/types.js"

export const SESSION_MODES_KEY = "coool.adaptive/session-modes"
export const SESSION_MODES_VERSION = 1
/** Product bound — not a user knob. Keeps the most recently updated records. */
export const MAX_SESSION_MODE_RECORDS = 512
/** A session id beyond this bound is not a real host identifier. */
export const MAX_SESSION_ID_LENGTH = 128

export interface SessionModeRecord {
  readonly sessionID: string
  readonly mode: OperatingMode
  readonly updatedAt: number
}

export interface SessionModesPayload {
  readonly version: typeof SESSION_MODES_VERSION
  readonly records: readonly SessionModeRecord[]
}

/**
 * A successful override write. Mirrors the settings patch-result convention:
 * validation failures are per-field errors, internal failures throw (the
 * RPC handler degrades them fail-open).
 */
export type SessionModeSetResult =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }

/** Storage seam — the adapter binds `SESSION_MODES_KEY` to `ctx.storage`. */
export interface SessionModesStorage {
  read(): Promise<unknown>
  write(payload: SessionModesPayload): Promise<void>
}
