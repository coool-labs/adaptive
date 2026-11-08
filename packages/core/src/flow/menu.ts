/**
 * Main-menu and mode-menu view models for `/adaptive` (ADP-033): pure data
 * that the controller feeds into `ui.dialog.select`. Descriptions are dynamic
 * where state makes them more informative (health counters, tier contents).
 */
import { OPERATING_MODES } from "../routing/scheduler/types.js"
import type { OperatingMode } from "../routing/scheduler/types.js"
import type { TierName } from "../routing/tier-policy/types.js"
import { TIERS } from "../routing/tier-policy/types.js"
import type { StatusSnapshot } from "../status.js"
import type { SettingsV1 } from "../state/settings/index.js"
import type { SelectOption } from "./options.js"
import { resourceLabel } from "./tiers.js"

export const MAIN_MENU_ITEMS = ["status", "models", "mode", "tier", "pin", "receipts"] as const
export type MainMenuChoice = (typeof MAIN_MENU_ITEMS)[number]

/** "3 resources · 1 windowed" — the status line under the menu entry. */
export function statusSummary(status: StatusSnapshot | undefined): string {
  if (status === undefined) return "how every configured model is doing"
  const total = TIERS.reduce((sum, tier) => sum + status.tiers[tier].length, 0)
  if (total === 0) return "no models configured yet"
  const windowed = TIERS.reduce(
    (sum, tier) => sum + status.tiers[tier].filter((entry) => entry.windowed).length,
    0,
  )
  const windowedNote = windowed === 0 ? "" : ` · ${String(windowed)} windowed`
  return `${String(total)} resource${total === 1 ? "" : "s"}${windowedNote}`
}

/** "quick: 1 · standard: 0 · advanced: 2" — what is configured where. */
export function modelsSummary(settings: SettingsV1): string {
  const parts = TIERS.map((tier: TierName) => `${tier}: ${String(settings.tiers[tier].length)}`)
  return parts.join(" · ")
}

function tierRequestDescription(tierRequest: TierName | null | undefined): string {
  if (tierRequest === undefined) return "pin a tier for the current session"
  if (tierRequest === null) return "not pinned — the routing ladder decides"
  return `pinned to ${tierRequest} — steers this session`
}

function modeMarker(
  mode: OperatingMode,
  input: { override: OperatingMode | null; effective: OperatingMode },
): "override" | "current" | undefined {
  if (mode === input.override) return "override"
  if (mode === input.effective) return "current"
  return undefined
}

export function mainMenuOptions(
  settings: SettingsV1,
  status: StatusSnapshot | undefined,
  tierRequest?: TierName | null,
  effectiveMode: OperatingMode = settings.mode,
): SelectOption<MainMenuChoice>[] {
  const optionFor = (item: MainMenuChoice): SelectOption<MainMenuChoice> => {
    switch (item) {
      case "status":
        return {
          title: "Status",
          value: item,
          description: statusSummary(status),
        }
      case "models":
        return {
          title: "Models",
          value: item,
          description: modelsSummary(settings),
        }
      case "mode":
        return {
          title: "Mode",
          value: item,
          description: `currently ${effectiveMode}`,
        }
      case "tier":
        return {
          title: "Tier",
          value: item,
          description: tierRequestDescription(tierRequest),
        }
      case "pin":
        return {
          title: "Pin",
          value: item,
          description:
            settings.pin === null
              ? "force one resource"
              : `pinned to ${resourceLabel(settings.pin)}`,
        }
      case "receipts":
        return { title: "Receipts", value: item, description: "why each turn ran the model it ran" }
    }
  }
  return MAIN_MENU_ITEMS.map(optionFor)
}

export function modeOptions(current: OperatingMode): SelectOption<OperatingMode>[] {
  return OPERATING_MODES.map((mode) => ({
    title: mode === current ? `${mode} (current)` : mode,
    value: mode,
    description: modeDescription(mode),
  }))
}

/** What one mode does — shared by the global and the per-session menus. */
export function modeDescription(mode: OperatingMode): string {
  switch (mode) {
    case "off":
      return "Adaptive does nothing"
    case "observe":
      return "Record decisions without applying them"
    case "active":
      return "Apply routing and recovery decisions"
  }
}

/** One per-session mode-menu pick: follow the global mode, or set an override. */
export type SessionModeChoice = { kind: "global" } | { kind: "mode"; mode: OperatingMode }

/** Which mode the user steers inside a session: the global default or the session override. */
export type ModeTarget = "global" | "session"

/**
 * The first select of the in-session mode flow (ADP-054): ask which mode to
 * steer before showing any mode list — the global default or this session's
 * override. Each row names the current value so the user can tell at a
 * glance which side needs changing.
 */
export function modeTargetOptions(
  global: OperatingMode,
  effective: OperatingMode,
): SelectOption<ModeTarget>[] {
  return [
    {
      title: "Global mode…",
      description: `applies to every session without an override (now ${global})`,
      value: "global",
    },
    {
      title: "This session…",
      description: `override for this session only (now ${effective})`,
      value: "session",
    },
  ]
}

/**
 * The per-session mode menu (ADP-054): first "Follow global" (clearing the
 * override), then every mode. An existing override is marked "(override)" —
 * distinct from the effective mode's "(current)" — so the user can tell a
 * set override apart from a session merely inheriting the global mode.
 */
export function sessionModeOptions(input: {
  global: OperatingMode
  override: OperatingMode | null
  effective: OperatingMode
}): SelectOption<SessionModeChoice>[] {
  const options: SelectOption<SessionModeChoice>[] = [
    {
      title: `Follow global (${input.global})`,
      description: "clear this session's override",
      value: { kind: "global" },
    },
  ]
  for (const mode of OPERATING_MODES) {
    const marker = modeMarker(mode, input)
    options.push({
      title: marker === undefined ? mode : `${mode} (${marker})`,
      value: { kind: "mode", mode },
      description: modeDescription(mode),
    })
  }
  return options
}

/** What one tier is for — shared by the tier editor and the per-session menu. */
function tierDescription(tier: TierName): string {
  switch (tier) {
    case "quick":
      return "routine edits, mechanical steps"
    case "standard":
      return "the default"
    case "advanced":
      return "multi-step design, broad refactors"
  }
}

/** One per-session tier-menu pick: follow the routing ladder, or pin a tier. */
export type SessionTierChoice = { kind: "ladder" } | { kind: "tier"; tier: TierName }

/**
 * The per-session tier menu (ADP-055): first "Follow routing ladder" (clearing
 * the request), then every tier. A pinned request is marked "(pinned)" so the
 * user can tell the sticky request apart from the ordinary ladder.
 */
export function sessionTierOptions(input: {
  pinned: TierName | null
}): SelectOption<SessionTierChoice>[] {
  const options: SelectOption<SessionTierChoice>[] = [
    {
      title: "Follow routing ladder",
      description: "clear this session's tier request",
      value: { kind: "ladder" },
    },
  ]
  for (const tier of TIERS) {
    options.push({
      title: tier === input.pinned ? `${tier} (pinned)` : tier,
      value: { kind: "tier", tier },
      description: tierDescription(tier),
    })
  }
  return options
}
