/**
 * User-configured tier lists (ADP-005): each tier is an ordered list of
 * resources; list order is user policy and is never reordered by Adaptive.
 * Normalization only removes unusable entries and exact duplicates — it
 * never reorders and never merges look-alike names (ADP-006: similar model
 * names across providers are never equivalent unless the user configures
 * both, and full-reference equality below is deliberately provider-scoped).
 */
import { sameModelRef, type ModelRef } from "../work-unit/types.js"

export function normalizeTierList(resources: readonly ModelRef[]): ModelRef[] {
  const kept: ModelRef[] = []
  for (const resource of resources) {
    if (resource.providerID.length === 0 || resource.id.length === 0) {
      continue
    }
    if (kept.some((existing) => sameModelRef(existing, resource))) {
      continue
    }
    kept.push(resource)
  }
  return kept
}
