/**
 * Bounded health-record store: a persistence mirror of the in-memory
 * resource-health registry. The store keeps the newest-updated records
 * (bounded, least-recently-updated evicted) and persists on every replace.
 * As everywhere else in `state/`, memory is only advanced after a successful
 * write, so memory and disk never diverge; write failures propagate to the
 * caller — the wiring layer's fail-open wrapper decides how to degrade
 * (ADP-031).
 */
import { parseHealthPayload } from "./parse.js"
import { MAX_HEALTH_RECORDS, HEALTH_VERSION } from "./types.js"
import type { HealthPayload, HealthStorage } from "./types.js"
import type { ResourceRecord } from "../../health/resource-health/types.js"

export class HealthRecordStore {
  #records: ResourceRecord[] = []

  constructor(private readonly storage: HealthStorage) {}

  /** Rebuild from storage (restart behavior). A read failure yields an empty store. */
  async load(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      this.#records = []
      return
    }
    this.#records = parseHealthPayload(raw)
  }

  /** All retained records. */
  snapshot(): readonly ResourceRecord[] {
    return this.#records
  }

  /**
   * Replace the whole record set with a fresh registry snapshot. The bound
   * keeps the most recently updated records — stale scopes matter less than
   * the resources that are actually failing right now.
   */
  async replace(records: readonly ResourceRecord[]): Promise<void> {
    const next =
      records.length > MAX_HEALTH_RECORDS
        ? [...records]
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_HEALTH_RECORDS)
        : [...records]
    // Persist BEFORE committing memory: a write failure must leave memory
    // and disk consistent (the caller decides how to fail open).
    const payload: HealthPayload = {
      version: HEALTH_VERSION,
      records: next,
    }
    await this.storage.write(payload)
    this.#records = next
  }
}
