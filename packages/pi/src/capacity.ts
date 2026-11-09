// covers: ["ADP-020", "ADP-021", "ADP-031", "ADP-051", "ADP-056", "ADP-059"]
import { isDeepStrictEqual } from "node:util"
import {
  capacitySignals,
  mergeReadings,
  normalizeReading,
} from "@coool/adaptive-core/health/capacity/merge"
import type { CapacityReading } from "@coool/adaptive-core/health/capacity/types"
import { resourceChain, resourceKeyID } from "@coool/adaptive-core/health/resource-health/key"
import { logFailOpen } from "@coool/adaptive-core/log"
import {
  schedulerHealthKey,
  type SchedulerInput,
} from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import {
  CodexCapacitySensor,
  isCodexHeaderName,
} from "@coool/adaptive-core/sensors/codex-capacity/index"
import { parseCapacityPayload } from "@coool/adaptive-core/state/capacity/parse"
import {
  CAPACITY_VERSION,
  MAX_CAPACITY_READINGS,
  type PersistedCapacityReading,
} from "@coool/adaptive-core/state/capacity/types"
import type { JsonFile } from "./store.js"

export interface SharedCapacity {
  readonly file: JsonFile
  readonly clock: () => number
}

export interface CapacityView {
  readonly capacity: SchedulerInput["capacity"]
  /** Fresh readings for status and reset-aware parking; null means unknown. */
  readonly readings: Readonly<Record<string, CapacityReading | null>>
}

function parse(raw: unknown): PersistedCapacityReading[] {
  if (raw === undefined) return []
  const readings = parseCapacityPayload(raw)
  // The core mirror reader is intentionally tolerant. A shared file must not
  // be rewritten after that reader dropped malformed fields or newer schema.
  if (!isDeepStrictEqual(raw, { version: CAPACITY_VERSION, readings }))
    throw new Error("Adaptive capacity: invalid capacity.json payload")
  return readings
}

function capturedHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Adaptive capacity: headers must be an object")
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isCodexHeaderName(name.toLowerCase())) continue
    if (typeof value !== "string")
      throw new Error("Adaptive capacity: Codex header values must be strings")
    headers[name] = value
  }
  return headers
}

/**
 * Observe only a known dispatched provider, never the selected virtual model.
 * Codex limits are provider-wide. Raw headers, account ids and credentials are
 * never persisted: the core sensor emits numbers and a fixed source label.
 * Missing/invalid telemetry adds nothing; previous observations age out using
 * the same freshness rule as the core mirror.
 */
export async function observeCodexHeaders(
  shared: SharedCapacity,
  providerID: unknown,
  headers: unknown,
): Promise<void> {
  try {
    if (typeof providerID !== "string" || providerID === "" || providerID.length > 128)
      throw new Error("Adaptive capacity: providerID must be a bounded nonempty string")
    const sensor = new CodexCapacitySensor({ providerID })
    sensor.observe(capturedHeaders(headers), shared.clock())
    const reading = normalizeReading(await sensor.read())
    if (reading === null) return
    const entry = { key: sensor.resource, reading }
    await shared.file.update((current) => {
      // Merge inside the cross-process lock so a peer's newer observation
      // cannot be overwritten by a snapshot read before acquiring it.
      const byKey = new Map(parse(current).map((item) => [resourceKeyID(item.key), item]))
      const id = resourceKeyID(entry.key)
      const previous = byKey.get(id)
      if (previous === undefined || reading.observedAt > previous.reading.observedAt)
        byKey.set(id, entry)
      const readings = [...byKey.values()]
        .sort((a, b) => b.reading.observedAt - a.reading.observedAt)
        .slice(0, MAX_CAPACITY_READINGS)
      return { next: { version: CAPACITY_VERSION, readings }, result: undefined }
    })
  } catch {
    // Neither a header getter nor a storage adapter's exception is safe to log.
    logFailOpen("capacity.observe", "Capacity observation unavailable")
  }
}

/** Read the shared mirror afresh; the core owns scope, freshness and draining. */
export async function readCapacity(
  shared: SharedCapacity,
  candidates: readonly ModelRef[],
): Promise<CapacityView> {
  const capacity: Record<string, ReturnType<typeof capacitySignals>> = {}
  const readings: Record<string, CapacityReading | null> = {}
  for (const ref of candidates) readings[schedulerHealthKey(ref)] = null
  try {
    const entries = await shared.file.update((current) => ({
      next: undefined,
      result: parse(current),
    }))
    const now = shared.clock()
    for (const ref of candidates) {
      const chain = new Set(
        resourceChain({ providerID: ref.providerID, modelID: ref.id, variantID: ref.variant }).map(
          resourceKeyID,
        ),
      )
      const reading = mergeReadings(
        entries
          .filter((entry) => chain.has(resourceKeyID(entry.key)))
          .map((entry) => entry.reading),
        now,
      )
      const id = schedulerHealthKey(ref)
      readings[id] = reading
      if (reading !== null) capacity[id] = capacitySignals(reading)
    }
  } catch {
    logFailOpen("capacity.read", "Shared capacity unavailable")
  }
  return { capacity, readings }
}
