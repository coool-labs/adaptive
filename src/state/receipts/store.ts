/**
 * Bounded receipt store (ADP-030). Receipts live in a ring capped at
 * `MAX_RECEIPTS` (newest kept, oldest evicted) and persist through the
 * storage seam on every mutation. Ids are monotonic across restarts (they
 * continue from the persisted maximum) so a receipt can always be told apart
 * from its neighbors. Write failures propagate to the caller — the wiring
 * layer's fail-open wrapper decides how to degrade (ADP-031).
 */
import { boundDecision } from "./bound.js"
import { parseReceiptsPayload } from "./parse.js"
import { MAX_RECEIPTS, RECEIPTS_VERSION } from "./types.js"
import type {
  Receipt,
  ReceiptInput,
  ReceiptOutcome,
  ReceiptsPayload,
  ReceiptsStorage,
} from "./types.js"

export interface ReceiptRef {
  readonly sessionID: string
  /** When given, only receipts of that unit are updated; otherwise only receipts without a unit. */
  readonly unitID?: string | undefined
}

export class ReceiptStore {
  #receipts: Receipt[] = []
  #counter = 0

  constructor(private readonly storage: ReceiptsStorage) {}

  /** Rebuild from storage (restart behavior). A read failure yields an empty store. */
  async load(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      this.#receipts = []
      return
    }
    const parsed = parseReceiptsPayload(raw)
    this.#receipts = parsed
    this.#counter = parsed.reduce((max, receipt) => Math.max(max, receipt.id), 0)
  }

  /** All retained receipts, oldest → newest. */
  snapshot(): readonly Receipt[] {
    return this.#receipts
  }

  async record(input: ReceiptInput): Promise<Receipt> {
    const id = ++this.#counter
    const receipt: Receipt = {
      id,
      at: input.at,
      sessionID: input.sessionID,
      ...(input.unitID !== undefined ? { unitID: input.unitID } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      decision: boundDecision(input.decision),
    }
    this.#receipts =
      this.#receipts.length >= MAX_RECEIPTS
        ? [...this.#receipts.slice(1 - MAX_RECEIPTS), receipt]
        : [...this.#receipts, receipt]
    await this.#persist()
    return receipt
  }

  /**
   * Attach a unit outcome to matching receipts that do not have one yet
   * (first outcome wins). Returns how many receipts were updated; zero
   * updates do not touch storage.
   */
  async attachOutcome(ref: ReceiptRef, outcome: ReceiptOutcome): Promise<number> {
    let updated = 0
    this.#receipts = this.#receipts.map((receipt) => {
      if (receipt.outcome !== undefined) return receipt
      if (receipt.sessionID !== ref.sessionID) return receipt
      const matches =
        ref.unitID !== undefined ? receipt.unitID === ref.unitID : receipt.unitID === undefined
      if (!matches) return receipt
      updated++
      return { ...receipt, outcome }
    })
    if (updated > 0) await this.#persist()
    return updated
  }

  /**
   * Stamps the unit that just opened onto the session's pending unit-less
   * admission receipts (recorded in the awaited prompt hook, before the unit
   * existed). After adoption the receipt carries the unitID, so outcomes
   * attach to it like any unit-scoped receipt.
   *
   * One opened unit adopts ONE admission — the newest pending receipt. With
   * several pending receipts (a prompt admitted but superseded before its
   * unit ever opened), stamping all of them would attach this unit's outcome
   * to foreign admission decisions; the older receipts stay pending instead.
   */
  async adoptUnit(sessionID: string, unitID: string): Promise<number> {
    let target: number | undefined
    this.#receipts.forEach((receipt, index) => {
      if (receipt.unitID !== undefined || receipt.outcome !== undefined) return
      if (receipt.sessionID !== sessionID) return
      target = index
    })
    if (target === undefined) return 0
    const at = target
    this.#receipts = this.#receipts.map((receipt, index) =>
      index === at ? { ...receipt, unitID } : receipt,
    )
    await this.#persist()
    return 1
  }

  async #persist(): Promise<void> {
    const payload: ReceiptsPayload = {
      version: RECEIPTS_VERSION,
      receipts: this.#receipts,
    }
    await this.storage.write(payload)
  }
}
