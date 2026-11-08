/**
 * Read-side parsing for persisted parked records (ADP-024). Total: accepts
 * `unknown`, drops invalid entries, never throws (ADP-031). Vocabulary is
 * membership-checked (the write path is typed); free-text is re-bounded.
 */
import { PARK_REASONS } from "../../routing/scheduler/types.js"
import { TIERS } from "../../routing/tier-policy/types.js"
import { MAX_PARKED, MAX_PARKED_TEXT, PARKED_VERSION } from "./types.js"
import type { ParkedRecord } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  return raw.length > MAX_PARKED_TEXT ? raw.slice(0, MAX_PARKED_TEXT) : raw
}

function parseOptionalBounded(raw: unknown): string | undefined {
  const value = boundString(raw)
  return value === "" ? undefined : value
}

/** Free-text detail keeps empty strings (round-trips through the store). */
function parseDetailBounded(raw: unknown): string | undefined {
  return boundString(raw) ?? undefined
}

function parseParked(raw: unknown): ParkedRecord | undefined {
  if (!isRecord(raw)) return undefined
  const id = parseOptionalBounded(raw["id"])
  const sessionID = parseOptionalBounded(raw["sessionID"])
  const tierRaw = raw["tier"]
  const reasonRaw = raw["reason"]
  const parkedAt = raw["parkedAt"]
  if (
    id === undefined ||
    sessionID === undefined ||
    typeof tierRaw !== "string" ||
    typeof reasonRaw !== "string" ||
    typeof parkedAt !== "number" ||
    !Number.isFinite(parkedAt) ||
    parkedAt < 0
  ) {
    return undefined
  }
  const tier = TIERS.find((entry) => entry === tierRaw)
  const reason = PARK_REASONS.find((entry) => entry === reasonRaw)
  if (tier === undefined || reason === undefined) return undefined
  const detail = parseDetailBounded(raw["detail"])
  const attemptsRaw = raw["attempts"]
  const attempts =
    typeof attemptsRaw === "number" && Number.isInteger(attemptsRaw) && attemptsRaw >= 0
      ? attemptsRaw
      : undefined
  return {
    id,
    sessionID,
    tier,
    reason,
    ...(detail !== undefined ? { detail } : {}),
    parkedAt,
    ...(attempts !== undefined ? { attempts } : {}),
  }
}

/**
 * Parse a persisted parked payload. Accepts the versioned shape and a
 * versionless draft array; anything else yields no records.
 */
export function parseParkedPayload(raw: unknown): ParkedRecord[] {
  let list: unknown
  if (isRecord(raw)) {
    const version = raw["version"]
    if (version !== PARKED_VERSION && version !== undefined) return []
    list = raw["parked"]
  } else if (Array.isArray(raw)) {
    list = raw
  }
  if (!Array.isArray(list)) return []
  const parsed = list
    .map(parseParked)
    .filter((record): record is ParkedRecord => record !== undefined)
  return parsed.length > MAX_PARKED ? parsed.slice(-MAX_PARKED) : parsed
}
