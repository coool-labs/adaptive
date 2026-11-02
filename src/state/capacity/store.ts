/**
 * Persistence mirror of the in-memory capacity registry: loads what any
 * instance observed and keeps it bounded (oldest-observed evicted), merging
 * per resource key on every replace.
 *
 * As everywhere else in state/, memory is only advanced after a successful
 * write, so memory and disk never diverge; write failures propagate to the
 * caller — the wiring layer's fail-open wrapper decides how to degrade
 * (ADP-031).
 */
import { resourceKeyID } from "../../health/resource-health/key.js"
import {
  CAPACITY_VERSION,
  MAX_CAPACITY_READINGS,
  type CapacityStorage,
  type PersistedCapacityReading,
} from "./types.js"
import { parseCapacityPayload } from "./parse.js"

export class CapacityReadingStore {
  #readings: PersistedCapacityReading[] = []

  constructor(private readonly storage: CapacityStorage) {}

  /** Load the persisted mirror; unreadable or corrupt data is empty, not an error. */
  async load(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      this.#readings = []
      return
    }
    this.#readings = parseCapacityPayload(raw)
  }

  snapshot(): readonly PersistedCapacityReading[] {
    return this.#readings
  }

  /**
   * Merge one refresh batch into the mirror and persist it. Merge — not
   * replace — per resource key, with the newest `observedAt` winning: the TUI
   * host loads this plugin into several supervisor instances, and an instance
   * whose sensors have seen nothing must never clobber what the observing
   * instance persisted. Bound by MAX_CAPACITY_READINGS, evicting the oldest
   * observations first.
   */
  async replace(entries: readonly PersistedCapacityReading[]): Promise<void> {
    const byKey = new Map<string, PersistedCapacityReading>()
    for (const entry of this.#readings) {
      byKey.set(resourceKeyID(entry.key), entry)
    }
    for (const entry of entries) {
      const id = resourceKeyID(entry.key)
      const previous = byKey.get(id)
      if (previous === undefined || entry.reading.observedAt > previous.reading.observedAt) {
        byKey.set(id, entry)
      }
    }
    const merged = [...byKey.values()]
    merged.sort((a, b) => b.reading.observedAt - a.reading.observedAt)
    const next = merged.slice(0, MAX_CAPACITY_READINGS)
    // Persist BEFORE committing memory: a write failure must leave memory and
    // disk consistent (the caller decides how to fail open).
    await this.storage.write({ version: CAPACITY_VERSION, readings: next })
    this.#readings = next
  }
}
