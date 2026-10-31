/**
 * Main-menu and mode-menu view models for `/adaptive` (ADP-033): pure data
 * that the controller feeds into `ui.dialog.select`.
 */
import { OPERATING_MODES } from "../../core/scheduler/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import type { SelectOption } from "./options.js"

export const MAIN_MENU_ITEMS = ["status", "mode", "tiers", "pin", "receipts"] as const
export type MainMenuChoice = (typeof MAIN_MENU_ITEMS)[number]

const MAIN_MENU_DESCRIPTIONS: Record<MainMenuChoice, string> = {
  status: "Health of every configured resource and counters",
  mode: "Switch between off, observe, and control",
  tiers: "Edit the quick / standard / advanced model lists",
  pin: "Pin a resource or clear the pin",
  receipts: "Inspect recorded routing decisions",
}

export function mainMenuOptions(): SelectOption<MainMenuChoice>[] {
  return MAIN_MENU_ITEMS.map((item) => ({
    title: MAIN_MENU_DESCRIPTIONS[item],
    value: item,
    description: MAIN_MENU_DESCRIPTIONS[item],
  }))
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
