/**
 * Status view formatting (ADP-033): a bounded, plain-text rendering of the
 * status snapshot for the `/adaptive` status dialog.
 */
import { TIERS } from "../../core/tier-policy/types.js"
import type { StatusSnapshot } from "../../rpc/status.js"
import { healthTag, resourceLabel } from "./tiers.js"

export function formatStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = [`mode: ${snapshot.mode}`]
  lines.push(snapshot.pin === null ? "pin: none" : `pin: ${resourceLabel(snapshot.pin)}`)
  for (const tier of TIERS) {
    const resources = snapshot.tiers[tier]
    lines.push(`tier ${tier} (${String(resources.length)})`)
    if (resources.length === 0) {
      lines.push("  (empty)")
      continue
    }
    for (const entry of resources) {
      lines.push(`  ${resourceLabel(entry.ref)}${healthTag(entry)}`)
    }
  }
  lines.push(`parked: ${String(snapshot.parked)}`)
  lines.push(`receipts: ${String(snapshot.receipts)}`)
  return lines.join("\n")
}
