import { defaultSettings, migrateSettings } from "@coool/adaptive-core/state/settings/parse"
import {
  MAX_AGENT_TIERS,
  MAX_TIER_RESOURCES,
  type SettingsV1,
  type PatchResult,
} from "@coool/adaptive-core/state/settings/types"
import { isTierName, TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import type { JsonFile } from "./store.js"

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(field: string): never {
  throw new Error(`Adaptive settings: invalid ${field}`)
}

function reference(value: unknown, field: string): void {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["providerID", "id", "variant"].includes(key))
  )
    invalid(field)
  for (const key of ["providerID", "id"]) {
    const id = value[key]
    if (typeof id !== "string" || id.trim() === "" || id.length > 128) invalid(field)
  }
  const variant = value["variant"]
  if (
    variant !== undefined &&
    (typeof variant !== "string" || variant.trim() === "" || variant.length > 128)
  )
    invalid(field)
}

/** Validate before using core's forgiving migration/normalization on durable data. */
function validate(raw: Record<string, unknown>, reading: boolean): void {
  if (
    Object.keys(raw).some(
      (key) => !["version", "mode", "tiers", "pin", "agentTiers", "inviteDismissed"].includes(key),
    )
  )
    invalid("field")
  const version = raw["version"]
  if (version !== undefined && version !== 1 && !(reading && version === 0)) invalid("version")
  const mode = raw["mode"]
  if (
    mode !== undefined &&
    !(typeof mode === "string" && ["off", "observe", "active"].includes(mode)) &&
    !(reading && mode === "control")
  )
    invalid("mode")
  if (raw["pin"] !== undefined && raw["pin"] !== null) reference(raw["pin"], "pin")
  if (raw["inviteDismissed"] !== undefined && typeof raw["inviteDismissed"] !== "boolean")
    invalid("inviteDismissed")
  const tiers = raw["tiers"]
  if (tiers !== undefined) {
    if (!object(tiers) || Object.keys(tiers).some((key) => !isTierName(key))) invalid("tiers")
    for (const tier of TIERS) {
      const list: unknown = tiers[tier]
      if (!Array.isArray(list) || list.length > MAX_TIER_RESOURCES) invalid(`tiers.${tier}`)
      const seen = new Set<string>()
      for (const entry of list) {
        reference(entry, `tiers.${tier}`)
        const key = JSON.stringify(entry, ["providerID", "id", "variant"])
        if (seen.has(key)) invalid(`tiers.${tier}`)
        seen.add(key)
      }
    }
  }
  const agents = raw["agentTiers"]
  if (agents !== undefined) {
    if (!object(agents) || Object.keys(agents).length > MAX_AGENT_TIERS) invalid("agentTiers")
    for (const [agent, tier] of Object.entries(agents))
      if (agent.trim() === "" || typeof tier !== "string" || !isTierName(tier))
        invalid("agentTiers")
  }
}

export function parseSettings(raw: unknown): SettingsV1 {
  if (raw === undefined) return defaultSettings()
  if (!object(raw)) invalid("record")
  validate(raw, true)
  return migrateSettings(raw)
}

export async function readSettings(file: Pick<JsonFile, "read">): Promise<SettingsV1> {
  return parseSettings(await file.read())
}

export function updateSettings(file: JsonFile, patch: unknown): Promise<PatchResult> {
  return file.update<PatchResult>((raw) => {
    const current = parseSettings(raw)
    try {
      if (!object(patch)) invalid("patch")
      validate(patch, false)
    } catch (error) {
      return {
        next: undefined,
        result: { ok: false, errors: [String(error).replace("Error: Adaptive settings: ", "")] },
      }
    }
    const settings = migrateSettings({ ...current, ...patch, version: 1 })
    return { next: settings, result: { ok: true, settings } }
  })
}
