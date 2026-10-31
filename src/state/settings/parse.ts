/**
 * Bounded shape validation and migration-on-read (ADP-036). Every parser is
 * total: it accepts `unknown` and either returns a typed value or `undefined`
 * — the read path always falls back to a default rather than throwing, so a
 * corrupted record can never take the plugin (or the host) down (ADP-031).
 *
 * Plain objects are never indexed with untrusted strings beyond own-property
 * checks (`Object.hasOwn`) — prototype-chain keys like "toString" must not be
 * mistaken for data (project-wide audit rule).
 */
import { OPERATING_MODES } from "../../core/scheduler/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import { normalizeTierList } from "../../core/tier-policy/tier-list.js"
import { TIERS } from "../../core/tier-policy/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { ModelRef } from "../../core/work-unit/types.js"
import { MAX_AGENT_TIERS, MAX_TIER_RESOURCES, SETTINGS_VERSION } from "./types.js"
import type { SettingsV1 } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseMode(raw: unknown): OperatingMode | undefined {
  if (typeof raw !== "string") return undefined
  return OPERATING_MODES.find((mode) => mode === raw)
}

export function parseTierLists(
  raw: unknown,
): Readonly<Record<TierName, readonly ModelRef[]>> | undefined {
  if (!isRecord(raw)) return undefined
  const tiers = {} as Record<TierName, readonly ModelRef[]>
  for (const tier of TIERS) {
    const list = raw[tier]
    tiers[tier] = Array.isArray(list)
      ? normalizeTierList(
          list.map(parseModelRef).filter((ref): ref is ModelRef => ref !== undefined),
        ).slice(0, MAX_TIER_RESOURCES)
      : []
  }
  return tiers
}

export function parseModelRef(raw: unknown): ModelRef | undefined {
  if (!isRecord(raw)) return undefined
  const providerID = raw["providerID"]
  const id = raw["id"]
  const variant = raw["variant"]
  if (typeof providerID !== "string" || providerID === "") return undefined
  if (typeof id !== "string" || id === "") return undefined
  return {
    providerID,
    id,
    ...(typeof variant === "string" && variant !== "" ? { variant } : {}),
  }
}

export function parsePin(raw: unknown): ModelRef | null | undefined {
  if (raw === null) return null
  return parseModelRef(raw)
}

export function parseAgentTiers(raw: unknown): Readonly<Record<string, TierName>> | undefined {
  if (!isRecord(raw)) return undefined
  const entries: [string, TierName][] = []
  for (const [agent, tier] of Object.entries(raw)) {
    if (agent === "") continue
    const parsed = parseModelessTier(tier)
    if (parsed === undefined) continue
    entries.push([agent, parsed])
    if (entries.length === MAX_AGENT_TIERS) break
  }
  // `Object.fromEntries` creates own data properties, so even a "__proto__"
  // key from JSON input cannot pollute the prototype here.
  return Object.fromEntries(entries)
}

function parseModelessTier(raw: unknown): TierName | undefined {
  if (typeof raw !== "string") return undefined
  return TIERS.find((tier) => tier === raw)
}

/** Settings with nothing configured: OBSERVE, empty tiers, no pin (ADP-029/032). */
export function defaultSettings(): SettingsV1 {
  return {
    version: SETTINGS_VERSION,
    mode: "observe",
    tiers: { quick: [], standard: [], advanced: [] },
    pin: null,
    agentTiers: {},
    inviteDismissed: false,
  }
}

/**
 * Migration-on-read. `undefined`/absent record → defaults (first install);
 * versionless (v0 draft) and v1 records are validated field-wise with
 * defaults for unusable fields; a record written by a NEWER version is
 * returned as defaults rather than guessed at (and is only re-persisted once
 * the user changes something, which stamps the current version).
 */
export function migrateSettings(raw: unknown): SettingsV1 {
  if (!isRecord(raw)) return defaultSettings()
  const version = raw["version"]
  if (version !== SETTINGS_VERSION && version !== 0 && version !== undefined) {
    return defaultSettings()
  }
  return fieldsFrom(raw)
}

function fieldsFrom(raw: Record<string, unknown>): SettingsV1 {
  const mode = parseMode(raw["mode"]) ?? "observe"
  const tiers = parseTierLists(raw["tiers"]) ?? defaultSettings().tiers
  const pin = parsePin(raw["pin"]) ?? null
  const agentTiers = parseAgentTiers(raw["agentTiers"]) ?? {}
  const inviteDismissed = raw["inviteDismissed"] === true
  return { version: SETTINGS_VERSION, mode, tiers, pin, agentTiers, inviteDismissed }
}

/**
 * Validate a patch against current settings. The patch is WIRE input (unknown
 * by contract — surfaces send untrusted JSON over RPC; the SettingsPatch type
 * documents the expected shape, the field parsers enforce it). Invalid fields
 * collect error strings (at most one per field, five fields); a valid patch
 * produces a NEW settings object (inputs are never mutated).
 */
export function applyPatch(
  current: SettingsV1,
  patch: unknown,
): { ok: true; settings: SettingsV1 } | { ok: false; errors: string[] } {
  if (!isRecord(patch)) return { ok: false, errors: ["invalid patch"] }
  const request = patch as {
    mode?: unknown
    tiers?: unknown
    pin?: unknown
    agentTiers?: unknown
    inviteDismissed?: unknown
  }
  const errors: string[] = []
  let mode = current.mode
  let tiers = current.tiers
  let pin = current.pin
  let agentTiers = current.agentTiers
  let inviteDismissed = current.inviteDismissed

  if (request.mode !== undefined) {
    const parsed = parseMode(request.mode)
    if (parsed === undefined) errors.push("invalid mode")
    else mode = parsed
  }
  if (request.tiers !== undefined) {
    const parsed = parseTierLists(request.tiers)
    if (parsed === undefined) errors.push("invalid tiers")
    else tiers = parsed
  }
  // `pin === null` is a meaningful clear and must not read as absence.
  if (request.pin !== undefined) {
    const parsed = parsePin(request.pin)
    if (parsed === undefined) errors.push("invalid pin")
    else pin = parsed
  }
  if (request.agentTiers !== undefined) {
    const parsed = parseAgentTiers(request.agentTiers)
    if (parsed === undefined) errors.push("invalid agentTiers")
    else agentTiers = parsed
  }
  if (request.inviteDismissed !== undefined) {
    if (typeof request.inviteDismissed !== "boolean") errors.push("invalid inviteDismissed")
    else inviteDismissed = request.inviteDismissed
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    settings: { version: SETTINGS_VERSION, mode, tiers, pin, agentTiers, inviteDismissed },
  }
}
