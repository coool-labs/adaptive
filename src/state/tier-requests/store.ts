/**
 * Bounded per-session tier-request store. Keeps the most recently updated
 * records (bounded, least-recently-updated evicted) and persists on every
 * change. As everywhere else in `state/`, memory is only advanced after a
 * successful write, so memory and disk never diverge; write failures
 * propagate to the caller — the wiring layer's fail-open wrapper decides how
 * to degrade (ADP-031).
 */
import { TIERS, isTierName } from "../../core/tier-policy/types.js"
import { parseTierRequestsPayload, isValidSessionID } from "./parse.js"
import { MAX_SESSION_ID_LENGTH, MAX_TIER_REQUEST_RECORDS, TIER_REQUESTS_VERSION } from "./types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { TierRequestRecord, TierRequestsPayload, TierRequestsStorage } from "./types.js"

export class TierRequestStore {
  #records: TierRequestRecord[] = []
  #queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly storage: TierRequestsStorage,
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
    this.#records = parseTierRequestsPayload(raw)
  }

  /** All retained records. */
  snapshot(): readonly TierRequestRecord[] {
    return this.#records
  }

  /** The session's request, or `null` when it follows the routing ladder. */
  get(sessionID: string): TierName | null {
    return this.#records.find((record) => record.sessionID === sessionID)?.tier ?? null
  }

  /**
   * Set (or with `null`, remove) one session's request. The bound keeps the
   * most recently updated records — requests for long-gone sessions matter
   * less than the ones being actively steered.
   */
  async set(sessionID: string, tier: TierName | null): Promise<void> {
    // Defensive re-validation at the persistence boundary: the tool and the
    // RPC handler validate first; these guards keep malformed in-process
    // callers from persisting junk.
    if (!isValidSessionID(sessionID)) {
      throw new Error(
        `sessionID must be a non-empty string of at most ${String(MAX_SESSION_ID_LENGTH)} characters`,
      )
    }
    if (tier !== null && !isTierName(tier)) {
      throw new Error(`tier must be one of ${TIERS.join(", ")} or null`)
    }
    return this.#serialize(() => this.#set(sessionID, tier))
  }

  async #set(sessionID: string, tier: TierName | null): Promise<void> {
    const updatedAt = this.clock()
    const kept = this.#records.filter((record) => record.sessionID !== sessionID)
    const next =
      tier === null
        ? kept
        : bound([...kept, { sessionID, tier, updatedAt }], MAX_TIER_REQUEST_RECORDS)
    // Persist BEFORE committing memory: a write failure must leave memory
    // and disk consistent (the caller decides how to fail open).
    const payload: TierRequestsPayload = { version: TIER_REQUESTS_VERSION, records: next }
    await this.storage.write(payload)
    this.#records = next
  }

  /**
   * Resolve only after every operation queued before this call has committed.
   * The `adaptive_tier` tool records its request fire-and-forget (the tool
   * handler is sync on the RPC surface), so readers — routing and the control
   * surfaces — flush before reading to observe it deterministically.
   */
  flush(): Promise<void> {
    return this.#serialize(() => Promise.resolve())
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
function bound(records: TierRequestRecord[], max: number): TierRequestRecord[] {
  if (records.length <= max) return records
  return [...records].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, max)
}
