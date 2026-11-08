import { CONFIDENCE_LEVELS } from "../../health/capacity/types.js"
import type { CapacityReading } from "../../health/capacity/types.js"
import type { ResourceKey } from "../../health/resource-health/types.js"
import { CAPACITY_VERSION, MAX_CAPACITY_READINGS, type PersistedCapacityReading } from "./types.js"

// Defensive readers: persisted data is untrusted. Every parser is total —
// accepts unknown, returns typed records, and drops anything invalid — so a
// corrupted file can never take the plugin down (ADP-031). An older plugin
// reading a newer payload drops unknown-vocabulary entries; the version field
// guards the schema itself.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw)
}

/**
 * A non-empty bounded identifier. Over-long values are rejected, not
 * truncated: the writer stores keys as-is, so a truncated key would name a
 * different resource.
 */
function parseIdentifier(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "" || raw.length > 128) return undefined
  return raw
}

function parseKey(raw: unknown): ResourceKey | undefined {
  if (!isRecord(raw)) return undefined
  const providerID = parseIdentifier(raw["providerID"])
  if (providerID === undefined) return undefined
  const accountID = parseIdentifier(raw["accountID"])
  const modelID = parseIdentifier(raw["modelID"])
  const variantID = parseIdentifier(raw["variantID"])
  // A present-but-unusable scope field would silently widen the key.
  if (raw["accountID"] !== undefined && accountID === undefined) return undefined
  if (raw["modelID"] !== undefined && modelID === undefined) return undefined
  if (raw["variantID"] !== undefined && variantID === undefined) return undefined
  // Scope fields must form a valid prefix: a variant without a model is not
  // addressable against a model inventory and is not a real resource.
  if (variantID !== undefined && modelID === undefined) return undefined
  return {
    providerID,
    ...(accountID !== undefined ? { accountID } : {}),
    ...(modelID !== undefined ? { modelID } : {}),
    ...(variantID !== undefined ? { variantID } : {}),
  }
}

function parseRatio(raw: unknown): number | undefined {
  return isFiniteNumber(raw) && raw >= 0 && raw <= 1 ? raw : undefined
}

function parseReading(raw: unknown): CapacityReading | undefined {
  if (!isRecord(raw)) return undefined
  const confidence = CONFIDENCE_LEVELS.find((level) => level === raw["confidence"])
  if (confidence === undefined) return undefined
  const observedAt = raw["observedAt"]
  if (!isFiniteNumber(observedAt) || observedAt < 0) return undefined
  const usedRatio = parseRatio(raw["usedRatio"])
  const remainingRatio = parseRatio(raw["remainingRatio"])
  const retryAfterMs =
    isFiniteNumber(raw["retryAfterMs"]) && raw["retryAfterMs"] >= 0
      ? raw["retryAfterMs"]
      : undefined
  const resetAt = isFiniteNumber(raw["resetAt"]) && raw["resetAt"] >= 0 ? raw["resetAt"] : undefined
  // A reading with none of the measured fields carries no information and is
  // discarded (mirrors the domain rule in health/capacity/types.ts).
  if (
    usedRatio === undefined &&
    remainingRatio === undefined &&
    retryAfterMs === undefined &&
    resetAt === undefined
  ) {
    return undefined
  }
  const evidence = raw["evidence"]
  return {
    ...(usedRatio !== undefined ? { usedRatio } : {}),
    ...(remainingRatio !== undefined ? { remainingRatio } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    confidence,
    observedAt,
    ...(typeof evidence === "string" && evidence.length > 0
      ? { evidence: evidence.slice(0, 128) }
      : {}),
  }
}

function parseEntry(raw: unknown): PersistedCapacityReading | undefined {
  if (!isRecord(raw)) return undefined
  const key = parseKey(raw["key"])
  if (key === undefined) return undefined
  const reading = parseReading(raw["reading"])
  if (reading === undefined) return undefined
  return { key, reading }
}

// Every parser is total: accepts unknown, returns typed records, and drops
// anything invalid — a corrupted file can never take the plugin down
// (ADP-031). An older plugin reading newer records may drop
// unknown-vocabulary entries — records are bounded mirrors of an in-memory
// registry, and the payload version guards the schema itself.
export function parseCapacityPayload(raw: unknown): PersistedCapacityReading[] {
  if (!isRecord(raw)) return []
  if (raw["version"] !== CAPACITY_VERSION) return []
  if (!Array.isArray(raw["readings"])) return []
  const list = raw["readings"]
  const readings: PersistedCapacityReading[] = []
  for (const entry of list.slice(0, MAX_CAPACITY_READINGS)) {
    const parsed = parseEntry(entry)
    if (parsed !== undefined) readings.push(parsed)
  }
  return readings
}
