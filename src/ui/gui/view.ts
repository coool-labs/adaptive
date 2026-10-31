import { OPERATING_MODES, type OperatingMode } from "../../core/scheduler/types.js"
import { TIERS } from "../../core/tier-policy/index.js"
import type { StatusSnapshot } from "../../rpc.js"
import { healthTag, resourceLabel } from "../tui/tiers.js"
import { receiptLine } from "../tui/receipts.js"
import type { Receipt } from "../../state/receipts/index.js"

/** One display row of the GUI settings page. `tone` marks rows that need attention. */
export interface GuiRow {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly tone?: "warning"
}

export const DISCONNECTED_ROW_ID = "connection"

/**
 * Pure view model for the status section. An undefined snapshot means the server is unreachable; the page then
 * shows a single disconnected row (ADP-034 disconnect handling) and no stale data.
 */
export function statusRows(snapshot: StatusSnapshot | undefined): readonly GuiRow[] {
  if (snapshot === undefined) {
    return [{ id: DISCONNECTED_ROW_ID, label: "Server", value: "disconnected", tone: "warning" }]
  }
  const rows: GuiRow[] = [
    { id: "mode", label: "Mode", value: snapshot.mode },
    {
      id: "pin",
      label: "Pin",
      value: snapshot.pin === null ? "none" : resourceLabel(snapshot.pin),
    },
  ]
  for (const tier of TIERS) {
    const resources = snapshot.tiers[tier]
    const value =
      resources.length === 0
        ? "empty"
        : resources
            .map((resource) => `${resourceLabel(resource.ref)}${healthTag(resource)}`)
            .join(", ")
    rows.push({ id: `tier-${tier}`, label: `Tier ${tier}`, value })
  }
  rows.push({ id: "parked", label: "Parked", value: String(snapshot.parked) })
  rows.push({ id: "receipts", label: "Receipts", value: String(snapshot.receipts) })
  return rows
}

/** One choice of the mode selector; the active mode is marked. */
export interface ModeChoice {
  readonly value: OperatingMode
  readonly title: string
}

export function modeChoices(current: OperatingMode): readonly ModeChoice[] {
  return OPERATING_MODES.map((mode) => ({
    value: mode,
    title: mode === current ? `${mode} (current)` : mode,
  }))
}

/** Validity gate for the mode `<select>` change event: untrusted DOM values never reach RPC. */
export function parseModeValue(value: string): OperatingMode | undefined {
  return OPERATING_MODES.find((mode) => mode === value)
}

/** Display lines for the receipts section, reusing the TUI decision vocabulary. */
export function receiptLines(receipts: readonly Receipt[]): readonly string[] {
  return receipts.map((receipt) => receiptLine(receipt))
}
