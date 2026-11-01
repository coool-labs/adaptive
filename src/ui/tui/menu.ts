/**
 * Main-menu and mode-menu view models for `/adaptive` (ADP-033): pure data
 * that the controller feeds into `ui.dialog.select`. Descriptions are dynamic
 * where state makes them more informative (health counters, tier contents).
 */
import { OPERATING_MODES } from "../../core/scheduler/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import { TIERS } from "../../core/tier-policy/types.js"
import type { StatusSnapshot } from "../../rpc/status.js"
import type { SettingsV1 } from "../../state/settings/index.js"
import type { SelectOption } from "./options.js"
import { resourceLabel } from "./tiers.js"

export const MAIN_MENU_ITEMS = ["status", "models", "mode", "pin", "receipts"] as const
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

export function mainMenuOptions(
  settings: SettingsV1,
  status: StatusSnapshot | undefined,
): SelectOption<MainMenuChoice>[] {
  return MAIN_MENU_ITEMS.map((item) => {
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
          description: `currently ${settings.mode}`,
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
  })
}

export function modeOptions(current: OperatingMode): SelectOption<OperatingMode>[] {
  return OPERATING_MODES.map((mode) => ({
    title: mode === current ? `${mode} (current)` : mode,
    value: mode,
    description:
      mode === "off"
        ? "Adaptive does nothing"
        : mode === "observe"
          ? "Record decisions without applying them"
          : "Apply routing and recovery decisions",
  }))
}
