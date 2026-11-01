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
  let line = `${resourceLabel(status.ref)} — ${status.health}`
  if (status.windowed) {
    line +=
      status.windowUntil === null
        ? ", windowed (deadline unknown)"
        : `, windowed until ${clockTime(status.windowUntil)}`
  }
  if (status.breaker === "open") line += ", breaker open"
  else if (status.breaker === "half_open") line += ", probing"
  if (pinnedTo(status.ref, pin)) line += " (pinned)"
  return line
}

/**
 * The whole inventory on one screen: models grouped by tier (quick, standard,
 * advanced — each group in the user's priority order), one line per model.
 * There is no per-resource selection step: the page IS the view.
 */
export function statusPage(snapshot: StatusSnapshot): string {
  const lines: string[] = []
  for (const tier of TIERS) {
    const resources = snapshot.tiers[tier]
    if (resources.length === 0) continue
    lines.push(`${tier}:`)
    for (const status of resources) lines.push(`  ${statusLine(status, snapshot.pin)}`)
  }
  return lines.join("\n")
}

/** Empty-state copy for the status view when nothing is configured. */
export const STATUS_EMPTY_MESSAGE = "No models configured yet — open Models to add some."
