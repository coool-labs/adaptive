import type { ParkedRecord } from "../../state/parked-work/types.js"

/**
 * Resume-attempt budget (ADP-011): a record whose continuation prompt kept
 * failing is dropped once its attempts reach this count — the idle loop
 * must be provably bounded, not "as long as idle events keep firing".
 */
export const MAX_PARKED_ATTEMPTS = 5

/**
 * Predicates supplied by the wiring at each safe boundary. Kept as
 * injected predicates so this module stays host-agnostic and fully
 * unit-testable with fakes.
 */
export interface ResumeContext {
  /** Whether the parked record's tier still has configured resources. */
  tierConfigured(tier: ParkedRecord["tier"]): boolean
  /** Whether the session the record belongs to still exists. */
  sessionAlive(sessionID: string): boolean
}

export interface ResumePlan {
  /**
   * Records worth a fresh routing attempt now, oldest parked first (ties
   * keep park order). The wiring re-runs routing for each; a successful
   * route pops the record via the store and starts a clean continuation.
   */
  readonly attempt: readonly ParkedRecord[]
  /** Tier no longer configured — keep parked until the user configures it. */
  readonly hold: readonly ParkedRecord[]
  /**
   * Session gone, or the record exhausted its resume-attempt budget — the
   * record can never (or may no longer) resume; the wiring drops it.
   */
  readonly drop: readonly ParkedRecord[]
}

/**
 * Parked-work resume selection at a safe boundary (ADP-024). Total,
 * deterministic, pure: partitions the parked list by resumability without
 * consulting health (routing re-decides with fresh health per attempt).
 */
export function selectResumable(
  records: readonly ParkedRecord[],
  context: ResumeContext,
): ResumePlan {
  const attempt: ParkedRecord[] = []
  const hold: ParkedRecord[] = []
  const drop: ParkedRecord[] = []
  const byAge = [...records].sort((a, b) => a.parkedAt - b.parkedAt)
  for (const record of byAge) {
    if (!context.sessionAlive(record.sessionID)) {
      drop.push(record)
      continue
    }
    if ((record.attempts ?? 0) >= MAX_PARKED_ATTEMPTS) {
      drop.push(record)
      continue
    }
    if (!context.tierConfigured(record.tier)) {
      hold.push(record)
      continue
    }
    attempt.push(record)
  }
  return { attempt, hold, drop }
}
