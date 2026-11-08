/**
 * Read-side parsing for persisted tier requests. Total like every `state/`
 * parser: it accepts `unknown` and returns typed records, dropping anything
 * invalid — a corrupted file can never take the plugin down (ADP-031). A
 * partially corrupted payload keeps its good entries.
 */
import { TIERS } from "../../core/tier-policy/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import { isValidSessionID } from "../session-modes/parse.js"
import { TIER_REQUESTS_VERSION } from "./types.js"
import type { TierRequestRecord } from "./types.js"

export { isValidSessionID } from "../session-modes/parse.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw)
}

function parseTier(raw: unknown): TierName | undefined {
  if (typeof raw !== "string") return undefined
  return (TIERS as readonly string[]).includes(raw) ? (raw as TierName) : undefined
}

function parseRecord(raw: unknown): TierRequestRecord | undefined {
  if (!isRecord(raw)) return undefined
  const sessionID = isValidSessionID(raw["sessionID"]) ? raw["sessionID"] : undefined
  const tier = parseTier(raw["tier"])
  const updatedAt = raw["updatedAt"]
  if (sessionID === undefined || tier === undefined || !isFiniteNumber(updatedAt)) return undefined
  return { sessionID, tier, updatedAt }
}

export function parseTierRequestsPayload(raw: unknown): TierRequestRecord[] {
  if (!isRecord(raw)) return []
  if (raw["version"] !== TIER_REQUESTS_VERSION) return []
  const list = raw["records"]
  if (!Array.isArray(list)) return []
  // A hostile or duplicated payload can carry the same session twice; the
  // most recently updated record wins so `get` is not order-dependent.
  const bySession = new Map<string, TierRequestRecord>()
  for (const entry of list.slice(0, 512)) {
    const record = parseRecord(entry)
    if (record === undefined) continue
    const kept = bySession.get(record.sessionID)
    if (kept === undefined || record.updatedAt > kept.updatedAt)
      bySession.set(record.sessionID, record)
  }
  return [...bySession.values()]
}
