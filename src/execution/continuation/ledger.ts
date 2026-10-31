/**
 * Tracks which work units have accumulated tool side effects (ADP-014).
 * The adapter marks units as tool events stream through; the continuation
 * planner and executor consult the ledger to pick the prompt strategy and
 * to prove the never-replay invariant. The wiring forgets a unit's entry
 * when the unit closes, so the ledger stays bounded by live units — the
 * same memory model as the work-unit tracker (leaked units are memory-only
 * and bounded by host sessions).
 */
export class SideEffectLedger {
  readonly #marked = new Map<string, true>()

  /** Record that the unit has tool side effects. Idempotent. */
  mark(unitID: string): void {
    this.#marked.set(unitID, true)
  }

  had(unitID: string): boolean {
    return this.#marked.has(unitID)
  }

  /** Drop the unit's entry (call when the unit closes and is evaluated). */
  forget(unitID: string): void {
    this.#marked.delete(unitID)
  }

  /** Drop every entry for a session (unit IDs are `${sessionID}#episode`). */
  forgetSession(sessionID: string): void {
    for (const unitID of this.#marked.keys()) {
      if (unitID.startsWith(`${sessionID}#`)) this.#marked.delete(unitID)
    }
  }
}
