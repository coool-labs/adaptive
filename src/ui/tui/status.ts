/**
 * Health-view helpers (ADP-033): flatten the status snapshot into per-resource
 * entries for the browsable health view, and render the per-resource detail
 * text. Pure and deterministic; local wall-clock rendering is derived from the
 * snapshot's own timestamps.
 */
import { TIERS } from "../../core/tier-policy/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../rpc/status.js"
import { resourceLabel } from "./tiers.js"

/** One configured resource with its tier, for the health browser. */
export interface HealthEntry {
  readonly tier: TierName
  readonly status: TierResourceStatus
}

/** Configured resources in tier order (quick → standard → advanced). */
export function healthEntries(snapshot: StatusSnapshot): HealthEntry[] {
  const entries: HealthEntry[] = []
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

/** Detail text for one resource: health state, breaker, window deadline, tier. */
export function healthDetail(entry: HealthEntry, snapshot: StatusSnapshot): string {
  const { status, tier } = entry
  const lines = [
    `resource: ${resourceLabel(status.ref)}`,
    `tier: ${tier}`,
    `health: ${status.health}`,
    `breaker: ${status.breaker}`,
  ]
  if (status.windowed) {
    lines.push(
      status.windowUntil === null
        ? "window: active (deadline unknown)"
        : `window: until ${clockTime(status.windowUntil)}`,
    )
  }
  if (pinnedTo(status.ref, snapshot.pin)) lines.push("pin: pinned to this resource")
  return lines.join("\n")
}

function pinnedTo(ref: TierResourceStatus["ref"], pin: StatusSnapshot["pin"]): boolean {
  if (pin === null) return false
  return pin.providerID === ref.providerID && pin.id === ref.id && pin.variant === ref.variant
}

/**
 * The whole inventory's health on one screen: one plain line per configured
 * resource, tier order. This is what the health view opens with — drilling
 * into a single resource is optional, not the only way to see state.
 */
export function healthOverview(snapshot: StatusSnapshot): string {
  const lines: string[] = []
  for (const { status, tier } of healthEntries(snapshot)) {
    let line = `${resourceLabel(status.ref)} — ${tier} — ${status.health}`
    if (status.windowed) {
      line +=
        status.windowUntil === null
          ? ", windowed (deadline unknown)"
          : `, windowed until ${clockTime(status.windowUntil)}`
    }
    if (status.breaker === "open") line += ", breaker open"
    else if (status.breaker === "half_open") line += ", probing"
    if (pinnedTo(status.ref, snapshot.pin)) line += " (pinned)"
    lines.push(line)
  }
  return lines.join("\n")
}

/** Empty-state copy for the health view when nothing is configured. */
export const HEALTH_EMPTY_MESSAGE = "No models configured yet — open Models to add some."
