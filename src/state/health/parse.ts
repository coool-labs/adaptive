/**
 * Read-side parsing for persisted health records. Every parser is total: it
 * accepts `unknown` and returns typed records, dropping anything invalid — a
 * corrupted health file can never take the plugin down (ADP-031). State and
 * breaker vocabularies are membership-checked; timestamps must be finite
 * numbers. An older plugin reading newer records may drop unknown-vocabulary
 * entries — health records are bounded mirrors of an in-memory registry, and
 * the payload version guards the schema itself.
 */
import { BREAKER_STATES } from "../../health/circuit-breaker/types.js"
import type { BreakerRecord } from "../../health/circuit-breaker/types.js"
import { HEALTH_STATES } from "../../health/resource-health/types.js"
import type {
  ResourceKey,
  ResourceRecord,
  ResourceWindow,
} from "../../health/resource-health/types.js"
import { HEALTH_VERSION } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw)
}

function isNonNegativeInt(raw: unknown): raw is number {
  return isFiniteNumber(raw) && Number.isInteger(raw) && raw >= 0
}

function parseVocab<V extends readonly string[]>(
  raw: unknown,
  vocabulary: V,
): V[number] | undefined {
  if (typeof raw !== "string") return undefined
  return vocabulary.find((entry) => entry === raw)
}

/**
 * A non-empty bounded identifier string (provider/model/variant/account ids).
 * Over-long values are rejected, not truncated: the writer stores keys as-is,
 * so a truncated key would name a different resource.
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
  // Scope fields must form a valid prefix: a variant without a model, or a
  // model without its variant's provider context, is not a real resource.
  if (variantID !== undefined && modelID === undefined) return undefined
  return {
    providerID,
    ...(accountID !== undefined ? { accountID } : {}),
    ...(modelID !== undefined ? { modelID } : {}),
    ...(variantID !== undefined ? { variantID } : {}),
  }
}

function parseBreaker(raw: unknown): BreakerRecord | undefined {
  if (!isRecord(raw)) return undefined
  const state = parseVocab(raw["state"], BREAKER_STATES)
  const failures = raw["failures"]
  const openCount = raw["openCount"]
  if (state === undefined) return undefined
  if (!(isNonNegativeInt(failures) && isNonNegativeInt(openCount))) return undefined
  const reopenAt = raw["reopenAt"]
  const probeId = parseIdentifier(raw["probeId"])
  const probeAt = raw["probeAt"]
  return {
    state,
    failures,
    openCount,
    ...(isFiniteNumber(reopenAt) ? { reopenAt } : {}),
    ...(probeId !== undefined ? { probeId } : {}),
    ...(isFiniteNumber(probeAt) ? { probeAt } : {}),
  }
}

function parseWindow(raw: unknown): ResourceWindow | undefined {
  if (!isRecord(raw)) return undefined
  const kind = parseVocab(raw["kind"], ["rate-limit", "quota"] as const)
  const until = raw["until"]
  if (kind === undefined || !isFiniteNumber(until)) return undefined
  return { kind, until }
}

function parseRecord(raw: unknown): ResourceRecord | undefined {
  if (!isRecord(raw)) return undefined
  const key = parseKey(raw["key"])
  const health = parseVocab(raw["health"], HEALTH_STATES)
  const breaker = parseBreaker(raw["breaker"])
  const updatedAt = raw["updatedAt"]
  if (key === undefined || health === undefined || breaker === undefined) return undefined
  if (!isFiniteNumber(updatedAt)) return undefined
  const window = parseWindow(raw["window"])
  // Windowed states lift only when their window elapses: without a valid
  // window the record would block the resource permanently, so it is dropped
  // (the resource reads as healthy until fresh evidence arrives).
  if ((health === "rate_limited" || health === "quota_exhausted") && window === undefined) {
    return undefined
  }
  return {
    key,
    health,
    breaker,
    ...(window !== undefined ? { window } : {}),
    updatedAt,
  }
}

export function parseHealthPayload(raw: unknown): ResourceRecord[] {
  if (!isRecord(raw)) return []
  if (raw["version"] !== HEALTH_VERSION) return []
  const list = raw["records"]
  if (!Array.isArray(list)) return []
  const parsed: ResourceRecord[] = []
  for (const entry of list.slice(0, 512)) {
    const record = parseRecord(entry)
    if (record !== undefined) parsed.push(record)
  }
  return parsed
}
