import { isDeepStrictEqual } from "node:util"
import { buildStatus, type StatusSnapshot } from "@coool/adaptive-core/status"
import { DEFAULT_HEALTH_CONFIG, ResourceHealthRegistry } from "@coool/adaptive-core/health/index"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import { readCapacity, type SharedCapacity } from "../capacity.js"
import { readSharedHealth } from "../health-actions.js"
import type { SharedHealth } from "../health.js"
import { readReceipts } from "../receipts.js"
import { object } from "../settings.js"
import { parseParked, type Parked } from "../parking.js"
import type { JsonFile, JsonTransactionFile } from "../store.js"

export async function readParked(file: Pick<JsonFile, "read">): Promise<Parked[]> {
  const raw = await file.read()
  if (raw === undefined) return []
  if (!(object(raw) && Array.isArray(raw["records"])) || raw["records"].length > 512)
    throw new Error("Adaptive parked: invalid parked.json payload")
  const records = raw["records"].map((entry: unknown) => parseParked(entry))
  if (!isDeepStrictEqual(raw, { version: 1, records }))
    throw new Error("Adaptive parked: invalid parked.json payload")
  return records.filter((record) => !record.claimed)
}

interface StatusSources {
  settings(): Promise<SettingsV1>
  readonly health: SharedHealth
  readonly capacity: SharedCapacity
  readonly receipts: JsonTransactionFile
  readonly parked: JsonFile
  effectiveMode(global: OperatingMode): OperatingMode
}

export async function readStatus(sources: StatusSources): Promise<StatusSnapshot> {
  const [settings, health, receipts, parked] = await Promise.all([
    sources.settings(),
    readSharedHealth(sources.health.file),
    readReceipts(sources.receipts),
    readParked(sources.parked),
  ])
  const refs = TIERS.flatMap((tier) => [...settings.tiers[tier]])
  const capacity = await readCapacity(sources.capacity, refs)
  const registry = new ResourceHealthRegistry(
    sources.health.clock,
    DEFAULT_HEALTH_CONFIG,
    sources.health.newId,
  )
  registry.restore(health)
  // Core status rows are leaf-keyed. Project inherited blockers to each row,
  // without changing the shared health or claiming a half-open probe.
  const projected = refs.flatMap((ref) => {
    const key = {
      providerID: ref.providerID,
      modelID: ref.id,
      ...(ref.variant === undefined ? {} : { variantID: ref.variant }),
    }
    const assessment = registry.evaluate(key)
    const record = registry.recordFor(assessment.kind === "blocked" ? assessment.key : key)
    return record === undefined ? [] : [{ ...record, key }]
  })
  return buildStatus({
    settings: { ...settings, mode: sources.effectiveMode(settings.mode) },
    health: projected,
    capacity: capacity.readings,
    parked: parked.length,
    waiting: parked.map((record) => ({
      sessionID: record.session,
      tier: record.tier,
      resumeAt: record.due,
    })),
    receipts: receipts.length,
  })
}
