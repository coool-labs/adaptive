/**
 * Bounded per-session operating-mode override store. Keeps the most recently
 * updated records (bounded, least-recently-updated evicted) and persists on
 * every change. As everywhere else in `state/`, memory is only advanced after
 * a successful write, so memory and disk never diverge; write failures
 * propagate to the caller — the wiring layer's fail-open wrapper decides how
 * to degrade (ADP-031).
 */
import { parseSessionModesPayload, isValidSessionID } from "./parse.js"
import { MAX_SESSION_ID_LENGTH, MAX_SESSION_MODE_RECORDS, SESSION_MODES_VERSION } from "./types.js"
import type { OperatingMode } from "../../routing/scheduler/types.js"
import type { SessionModeRecord, SessionModesPayload, SessionModesStorage } from "./types.js"
import { OPERATING_MODES } from "../../routing/scheduler/types.js"

export class SessionModeStore {
  #records: SessionModeRecord[] = []
  #queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly storage: SessionModesStorage,
    private readonly clock: () => number,
  ) {}

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
    this.#records = parseSessionModesPayload(raw)
  }

  /** All retained records. */
  snapshot(): readonly SessionModeRecord[] {
    return this.#records
  }

  /** The session's override, or `null` when it follows the global mode. */
  get(sessionID: string): OperatingMode | null {
    return this.#records.find((record) => record.sessionID === sessionID)?.mode ?? null
  }

  /**
   * Set (or with `null`, remove) one session's override. The bound keeps the
   * most recently updated records — overrides for long-gone sessions matter
   * less than the ones being actively steered.
   */
  async set(sessionID: string, mode: OperatingMode | null): Promise<void> {
    // Defensive re-validation at the persistence boundary: the RPC handler
    // validates first and reports named errors; these guards keep malformed
    // in-process callers from persisting junk.
    if (!isValidSessionID(sessionID)) {
      throw new Error(
        `sessionID must be a non-empty string of at most ${String(MAX_SESSION_ID_LENGTH)} characters`,
      )
    }
    if (mode !== null && !(OPERATING_MODES as readonly string[]).includes(mode)) {
      throw new Error(`mode must be one of ${OPERATING_MODES.join(", ")} or null`)
    }
    return this.#serialize(() => this.#set(sessionID, mode))
  }

  async #set(sessionID: string, mode: OperatingMode | null): Promise<void> {
    const updatedAt = this.clock()
    const kept = this.#records.filter((record) => record.sessionID !== sessionID)
    const next =
      mode === null
        ? kept
        : bound([...kept, { sessionID, mode, updatedAt }], MAX_SESSION_MODE_RECORDS)
    // Persist BEFORE committing memory: a write failure must leave memory
    // and disk consistent (the caller decides how to fail open).
    const payload: SessionModesPayload = { version: SESSION_MODES_VERSION, records: next }
    await this.storage.write(payload)
    this.#records = next
  }

  // Reloads share the mutation queue so stale reads cannot overwrite commits.
  // Recover only the queue tail: the failed operation still rejects its caller.
  #serialize(operation: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(operation)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

/** Keep the newest records when over the cap. */
function bound(records: SessionModeRecord[], max: number): SessionModeRecord[] {
  if (records.length <= max) return records
  return [...records].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, max)
}
