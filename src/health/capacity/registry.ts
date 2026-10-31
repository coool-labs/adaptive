/**
 * Capacity registry: owns sensors, refreshes them, and answers scheduler
 * queries (ADP-020). Pull-based and timer-free — the wiring layer decides
 * when to refresh; queries sweep for staleness lazily, mirroring the
 * resource-health registry.
 *
 * Lookups are hierarchical: a sensor attached to any ancestor of the queried
 * key (provider → account → model → variant) contributes to it, so a
 * provider- or account-wide quota reading covers its models without each
 * model needing its own sensor.
 */
import { resourceChain, resourceKeyID } from "../resource-health/key.js"
import type { Clock } from "../resource-health/types.js"
import type { ResourceKey } from "../resource-health/types.js"
import { capacitySignals, mergeReadings, normalizeReading } from "./merge.js"
import type {
  CapacityAssessment,
  CapacityConfig,
  CapacityReading,
  CapacitySensor,
} from "./types.js"
import { DEFAULT_CAPACITY_CONFIG } from "./types.js"

interface SensorEntry {
  readonly sensor: CapacitySensor
  latest: CapacityReading | null
}

export class CapacityRegistry {
  readonly #clock: Clock
  readonly #config: CapacityConfig
  readonly #sensors = new Map<string, SensorEntry>()
  readonly #inFlight = new Set<string>()

  constructor(clock: Clock, config: CapacityConfig = DEFAULT_CAPACITY_CONFIG) {
    this.#clock = clock
    this.#config = config
  }

  /** Registers a sensor; re-registering an id replaces its previous sensor. */
  register(sensor: CapacitySensor): void {
    this.#sensors.set(sensor.id, { sensor, latest: null })
  }

  /** Removes a sensor; returns whether an entry existed. */
  unregister(id: string): boolean {
    return this.#sensors.delete(id)
  }

  /**
   * Reads every sensor registered at call time once. A sensor already being
   * read is skipped (its in-flight result will land) so concurrent refreshes
   * never hammer a quota endpoint. A sensor that throws or returns malformed
   * data stores "no observation" — fail-open, never a guess. A sensor
   * unregistered or replaced while its read is in flight stores nothing.
   */
  async refresh(): Promise<void> {
    const entries = [...this.#sensors.values()]
    await Promise.all(entries.map(async (entry) => this.#readSensor(entry)))
  }

  async #readSensor(entry: SensorEntry): Promise<void> {
    const id = entry.sensor.id
    if (this.#inFlight.has(id)) {
      return
    }
    this.#inFlight.add(id)
    try {
      let reading: CapacityReading | null = null
      try {
        reading = await entry.sensor.read()
      } catch {
        reading = null
      }
      const current = this.#sensors.get(id)
      if (current?.sensor === entry.sensor) {
        current.latest = reading === null ? null : normalizeReading(reading)
      }
    } finally {
      this.#inFlight.delete(id)
    }
  }

  /**
   * Merged reading for a resource, from sensors at the key itself or any of
   * its ancestors. `null` means no fresh trustworthy estimate.
   */
  reading(key: ResourceKey): CapacityReading | null {
    const chainIDs = new Set(resourceChain(key).map(resourceKeyID))
    const candidates: CapacityReading[] = []
    for (const entry of this.#sensors.values()) {
      if (!chainIDs.has(resourceKeyID(entry.sensor.resource))) {
        continue
      }
      if (entry.latest !== null) {
        candidates.push(entry.latest)
      }
    }
    return mergeReadings(candidates, this.#clock(), this.#config)
  }

  /**
   * Scheduler-facing assessment for a resource. `none` is unknown capacity —
   * callers must not interpret it as healthy.
   */
  assessment(key: ResourceKey): CapacityAssessment {
    const reading = this.reading(key)
    if (reading === null) {
      return { kind: "none" }
    }
    return { kind: "estimate", reading, signals: capacitySignals(reading, this.#config) }
  }
}
