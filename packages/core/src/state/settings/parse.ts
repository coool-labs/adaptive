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
import { OPERATING_MODES } from "../../routing/scheduler/types.js"
import type { OperatingMode } from "../../routing/scheduler/types.js"
import { normalizeTierList } from "../../routing/tier-policy/tier-list.js"
import { TIERS } from "../../routing/tier-policy/types.js"
import type { TierName } from "../../routing/tier-policy/types.js"
import type { ModelRef } from "../../routing/work-unit/types.js"
import { MAX_AGENT_TIERS, MAX_TIER_RESOURCES, SETTINGS_VERSION } from "./types.js"
import type { SettingsV1 } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One field's patch-path parse outcome: a validated value or a field error. */
type FieldParse<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Quoted, bounded rendering of an untrusted patch value inside an error
 * message (errors travel to surfaces over RPC; JSON.stringify is only ever
 * called on strings here, so a cyclic object cannot make applyPatch throw).
 */
function describePatchValue(value: unknown): string {
  if (typeof value === "string") {
    const quoted = JSON.stringify(value)
    return quoted.length > 64 ? `${quoted.slice(0, 64)}…` : quoted
  }
  if (value === null) return "null"
  if (typeof value === "object") return "object"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return typeof value
}

export function parseMode(raw: unknown): OperatingMode | undefined {
  if (typeof raw !== "string") return undefined
  return OPERATING_MODES.find((mode) => mode === raw)
}

/**
 * Legacy persisted value: v1 settings written before the `control → active`
 * rename store `mode: "control"`. Migration-on-read maps it; patches stay
 * strict (wire input must use the current vocabulary).
 */
function parseLegacyMode(raw: unknown): OperatingMode | undefined {
  return raw === "control" ? "active" : parseMode(raw)
}

export function parseTierLists(
  raw: unknown,
): Readonly<Record<TierName, readonly ModelRef[]>> | undefined {
  if (!isRecord(raw)) return undefined
  const tiers = {} as Record<TierName, readonly ModelRef[]>
  for (const tier of TIERS) {
    tiers[tier] = normalizeTierListValue(raw[tier])
  }
  return tiers
}

/** Shared per-tier normalization (drop invalid, dedupe, cap) for both paths. */
function normalizeTierListValue(list: unknown): readonly ModelRef[] {
  return Array.isArray(list)
    ? normalizeTierList(
        list.map(parseModelRef).filter((ref): ref is ModelRef => ref !== undefined),
      ).slice(0, MAX_TIER_RESOURCES)
    : []
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

/**
 * Patch-path tier-list validation. Unlike the read path (which fills missing
 * or unusable tiers with `[]`), a patch that names `tiers` REPLACES the whole
 * map — silently filling an omitted key with `[]` would wipe that tier's
 * configured resources, so every key must be present and array-typed. List
 * contents still go through the shared normalization (drop invalid, dedupe,
 * cap), which is repair of user-typed entries rather than data loss.
 */
function parseTierListsPatch(
  raw: unknown,
): FieldParse<Readonly<Record<TierName, readonly ModelRef[]>>> {
  if (!isRecord(raw)) return { ok: false, error: "invalid tiers" }
  const missing = TIERS.filter((tier) => raw[tier] === undefined)
  if (missing.length > 0) {
    const named = missing.map((tier) => JSON.stringify(tier)).join(", ")
    return { ok: false, error: `invalid tiers: missing ${named}` }
  }
  const tiers = {} as Record<TierName, readonly ModelRef[]>
  for (const tier of TIERS) {
    const list = raw[tier]
    if (!Array.isArray(list)) {
      return { ok: false, error: `invalid tiers: ${JSON.stringify(tier)} must be an array` }
    }
    tiers[tier] = normalizeTierListValue(list)
  }
  return { ok: true, value: tiers }
}

/**
 * Patch-path agent-tier validation. Unlike the read path (which drops invalid
 * entries as migration-on-read repair), a patch REPLACES the whole map —
 * silently dropping entries would let a single typo wipe the persisted hints,
 * so any invalid entry (and an over-cap patch) is rejected with an error that
 * names the offending field and value.
 */
function parseAgentTiersPatch(raw: unknown): FieldParse<Readonly<Record<string, TierName>>> {
  if (!isRecord(raw)) return { ok: false, error: "invalid agentTiers" }
  const entries: [string, TierName][] = []
  for (const [agent, tier] of Object.entries(raw)) {
    if (entries.length === MAX_AGENT_TIERS) {
      return {
        ok: false,
        error: `invalid agentTiers: more than ${String(MAX_AGENT_TIERS)} entries`,
      }
    }
    if (agent === "") return { ok: false, error: "invalid agentTiers: empty agent name" }
    const parsed = parseModelessTier(tier)
    if (parsed === undefined) {
      return {
        ok: false,
        error: `invalid agentTiers entry ${describePatchValue(agent)}: ${describePatchValue(tier)}`,
      }
    }
    entries.push([agent, parsed])
  }
  // `Object.fromEntries` creates own data properties, so even a "__proto__"
  // key from JSON input cannot pollute the prototype here.
  return { ok: true, value: Object.fromEntries(entries) }
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
  const mode = parseLegacyMode(raw["mode"]) ?? "observe"
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
    const parsed = parseTierListsPatch(request.tiers)
    if (parsed.ok) tiers = parsed.value
    else errors.push(parsed.error)
  }
  // `pin === null` is a meaningful clear and must not read as absence.
  if (request.pin !== undefined) {
    const parsed = parsePin(request.pin)
    if (parsed === undefined) errors.push("invalid pin")
    else pin = parsed
  }
  if (request.agentTiers !== undefined) {
    const parsed = parseAgentTiersPatch(request.agentTiers)
    if (parsed.ok) agentTiers = parsed.value
    else errors.push(parsed.error)
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
