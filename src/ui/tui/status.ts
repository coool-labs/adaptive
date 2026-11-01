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
  if (snapshot.pin !== null) {
    const pinned =
      snapshot.pin.providerID === status.ref.providerID &&
      snapshot.pin.id === status.ref.id &&
      snapshot.pin.variant === status.ref.variant
    if (pinned) lines.push("pin: pinned to this resource")
  }
  return lines.join("\n")
}

/** Empty-state copy for the health view when nothing is configured. */
export const HEALTH_EMPTY_MESSAGE = "No models configured yet — open Models to add some."
