import type { PlannedRelease, Plugin } from "./plan.js"

export interface ReleaseEffects {
  prepare(): void
  commit(): void
  verify(ids: readonly Plugin[]): void
  /** Drop the local bump commit after a failed verification (never pushed). */
  discardCommit(): void
  restore(): void
  push(): void
}

/**
 * The bumps are committed before verification so the git stage stays clean
 * while the battery runs; a failed verification restores the original files
 * and discards the still-local commit. Publication (and the tag that
 * certifies it) happens in the publish scripts, after `npm publish` succeeds.
 */
export function executeRelease(plan: readonly PlannedRelease[], effects: ReleaseEffects): void {
  let committed = false
  let verified = false
  try {
    effects.prepare()
    effects.commit()
    committed = true
    effects.verify(plan.map((release) => release.id))
    verified = true
    effects.push()
  } catch (error) {
    if (!verified) {
      effects.restore()
      if (committed) effects.discardCommit()
    }
    throw error
  }
}
