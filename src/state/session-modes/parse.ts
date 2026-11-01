/**
 * Read-side parsing for persisted session-mode overrides. Total like every
 * `state/` parser: it accepts `unknown` and returns typed records, dropping
 * anything invalid — a corrupted file can never take the plugin down
 * (ADP-031). A partially corrupted payload keeps its good entries.
 */
import { OPERATING_MODES } from "../../core/scheduler/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import { MAX_SESSION_ID_LENGTH, SESSION_MODES_VERSION } from "./types.js"
import type { SessionModeRecord } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw)
}

/**
 * A non-empty bounded session identifier. Unlike the health parser's provider
 * identifiers (truncated on read), an over-long sessionID is dropped: the id
 * is a host identity, not a label, and no real session id exceeds the bound.
 */
export function isValidSessionID(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_SESSION_ID_LENGTH
}

function parseSessionID(raw: unknown): string | undefined {
  return isValidSessionID(raw) ? raw : undefined
}

function parseMode(raw: unknown): OperatingMode | undefined {
  if (typeof raw !== "string") return undefined
  return (OPERATING_MODES as readonly string[]).includes(raw) ? (raw as OperatingMode) : undefined
}

function parseRecord(raw: unknown): SessionModeRecord | undefined {
  if (!isRecord(raw)) return undefined
  const sessionID = parseSessionID(raw["sessionID"])
  const mode = parseMode(raw["mode"])
  const updatedAt = raw["updatedAt"]
  if (sessionID === undefined || mode === undefined || !isFiniteNumber(updatedAt)) return undefined
  return { sessionID, mode, updatedAt }
}

export function parseSessionModesPayload(raw: unknown): SessionModeRecord[] {
  if (!isRecord(raw)) return []
  if (raw["version"] !== SESSION_MODES_VERSION) return []
  const list = raw["records"]
  if (!Array.isArray(list)) return []
  // A hostile or duplicated payload can carry the same session twice; the
  // most recently updated record wins so `get` is not order-dependent.
  const bySession = new Map<string, SessionModeRecord>()
  for (const entry of list.slice(0, 512)) {
    const record = parseRecord(entry)
    if (record === undefined) continue
    const kept = bySession.get(record.sessionID)
    if (kept === undefined || record.updatedAt > kept.updatedAt)
      bySession.set(record.sessionID, record)
  }
  return [...bySession.values()]
}
