/**
 * Parked-work store (ADP-024). Records are keyed by unit id — parking the
 * same unit again replaces the record (latest park wins). The cap
 * `MAX_PARKED` evicts the oldest `parkedAt` first: parked work is waiting
 * work, and unbounded growth would mean recovery never happens. Write
 * failures propagate to the caller (fail-open is the wiring layer's call), and
 * the in-memory list is only advanced after a successful write — memory and
 * disk never diverge.
 *
 * Storage is shared: the host may load the plugin twice in one process, and
 * only one instance's store changes on each event. Every mutation therefore
 * re-reads storage first, so a stale instance can neither resurrect a record
 * another instance resumed nor resume it a second time.
 */
import { parseParkedPayload } from "./parse.js"
import { MAX_PARKED, MAX_PARKED_TEXT, PARKED_VERSION } from "./types.js"
import type { ParkedPayload, ParkedRecord, ParkedStorage } from "./types.js"

function boundDetail(raw: string): string {
  return raw.length > MAX_PARKED_TEXT ? raw.slice(0, MAX_PARKED_TEXT) : raw
}

export class ParkedWorkStore {
  #records: ParkedRecord[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: ParkedStorage) {}

  /** Rebuild from storage (restart behavior). A read failure yields an empty store. */
  load(): Promise<void> {
    return this.#serialize(() => this.#load())
  }

  async #load(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      this.#records = []
      return
    }
    this.#records = parseParkedPayload(raw)
  }

  /**
   * Re-read storage without the load-time failure policy: a read failure
   * keeps the current records instead of forgetting parked work.
   */
  refresh(): Promise<void> {
    return this.#serialize(() => this.#refresh())
  }

  async #refresh(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      return
    }
    this.#records = parseParkedPayload(raw)
  }

  /** All parked records, insertion order. */
  list(): readonly ParkedRecord[] {
    return this.#records
  }

  count(): number {
    return this.#records.length
  }

  park(record: ParkedRecord): Promise<void> {
    return this.#serialize(() => this.#park(record))
  }

  async #park(record: ParkedRecord): Promise<void> {
    await this.#refresh()
    const bounded: ParkedRecord = {
      ...record,
      ...(record.detail !== undefined ? { detail: boundDetail(record.detail) } : {}),
    }
    const withoutId = this.#records.filter((entry) => entry.id !== bounded.id)
    const next = this.#evictOldest([...withoutId, bounded])
    // Persist BEFORE committing memory: a failed resume must not silently
    // drop the parked unit (memory and disk stay consistent on failure).
    await this.#persist(next)
    this.#records = next
  }

  /**
   * Remove a parked record and return it so the execution layer knows what
   * to continue. `undefined` (no record, no write) when the id is unknown.
   */
  resume(id: string): Promise<ParkedRecord | undefined> {
    return this.#serialize(() => this.#resume(id))
  }

  async #resume(id: string): Promise<ParkedRecord | undefined> {
    await this.#refresh()
    const record = this.#records.find((entry) => entry.id === id)
    if (record === undefined) return undefined
    const next = this.#records.filter((entry) => entry.id !== id)
    await this.#persist(next)
    this.#records = next
    return record
  }

  #evictOldest(records: ParkedRecord[]): ParkedRecord[] {
    if (records.length <= MAX_PARKED) return records
    const byOldest = [...records].sort((a, b) => a.parkedAt - b.parkedAt)
    const dropped = new Set(byOldest.slice(0, records.length - MAX_PARKED).map((r) => r.id))
    return records.filter((record) => !dropped.has(record.id))
  }

  // Reads share the queue so reloads cannot overwrite newer commits. Recover
  // the queue after rejection while preserving the failing caller's promise.
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** Writes the given next state; the caller commits memory only on success. */
  async #persist(parked: readonly ParkedRecord[]): Promise<void> {
    const payload: ParkedPayload = {
      version: PARKED_VERSION,
      parked,
    }
    await this.storage.write(payload)
  }
}
