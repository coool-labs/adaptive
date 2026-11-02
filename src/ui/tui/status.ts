/**
 * Status-view helpers (ADP-033): flatten the status snapshot into one page
 * showing every configured model with its state, grouped by tier in priority
 * order. Pure and deterministic; local wall-clock rendering is derived from
 * the snapshot's own timestamps.
 */
import { TIERS } from "../../core/tier-policy/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../rpc/status.js"
import { resourceLabel } from "./tiers.js"

/** Configured resources in tier order (quick → standard → advanced). */
export function healthEntries(
  snapshot: StatusSnapshot,
): { tier: TierName; status: TierResourceStatus }[] {
  const entries: { tier: TierName; status: TierResourceStatus }[] = []
  for (const tier of TIERS) {
    for (const status of snapshot.tiers[tier]) entries.push({ tier, status })
  }
  return entries
}

/** "until 18:42" style wall-clock rendering of a window deadline. */
export function clockTime(until: number): string {
  const at = new Date(until)
  const hours = String(at.getHours()).padStart(2, "0")
  const minutes = String(at.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

function pinnedTo(ref: TierResourceStatus["ref"], pin: StatusSnapshot["pin"]): boolean {
  if (pin === null) return false
  return pin.providerID === ref.providerID && pin.id === ref.id && pin.variant === ref.variant
}

/** One plain status line for a resource: health, window, breaker, pin. */
export function statusLine(status: TierResourceStatus, pin: StatusSnapshot["pin"]): string {
  return `${resourceLabel(status.ref)} — ${status.health}${stateSuffix(status, pin)}`
}

/** Everything after the health state: capacity usage, window, breaker, pin. */
function stateSuffix(status: TierResourceStatus, pin: StatusSnapshot["pin"]): string {
  let suffix = ""
  if (status.windowed) {
    suffix +=
      status.windowUntil === null
        ? ", windowed (deadline unknown)"
        : `, windowed until ${clockTime(status.windowUntil)}`
  }
  if (status.usedPercent !== null) {
    suffix += `, used ${String(status.usedPercent)}%`
    if (status.resetAt !== null) suffix += `, resets ${clockTime(status.resetAt)}`
  }
  if (status.breaker === "open") suffix += ", breaker open"
  else if (status.breaker === "half_open") suffix += ", probing"
  if (pinnedTo(status.ref, pin)) suffix += " (pinned)"
  return suffix
}

/** The STATE column of the status table: window, breaker, pin markers. */
export function stateCell(status: TierResourceStatus, pin: StatusSnapshot["pin"]): string {
  return stateSuffix(status, pin).replace(/^[, ]+/, "") || "-"
}

/**
 * The whole inventory as a column-aligned table (header row first): models
 * grouped in tier order (quick → standard → advanced), one row per model,
 * columns padded to the widest cell so the grid reads at a glance. There is
 * no per-resource selection step: the table IS the view.
 */
export function statusTable(snapshot: StatusSnapshot): string[] {
  const header = ["MODEL", "TIER", "HEALTH", "STATE"]
  const rows = healthEntries(snapshot).map(({ tier, status }) => [
    resourceLabel(status.ref),
    tier,
    status.health,
    stateCell(status, snapshot.pin),
  ])
  if (rows.length === 0) return []
  // Header and rows are built together, always four cells wide — the column
  // index cannot be out of range.
  const widths = header.map((cell, column) =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
  )
  const render = (cells: string[]): string =>
    cells
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd()
  return [render(header), ...rows.map(render)]
}

/** Empty-state copy for the status view when nothing is configured. */
export const STATUS_EMPTY_MESSAGE = "No models configured yet — open Models to add some."
