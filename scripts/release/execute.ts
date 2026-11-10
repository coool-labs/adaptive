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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      const failures: string[] = []
      const cleanup = (step: () => void): void => {
        try {
          step()
        } catch (failure) {
          failures.push(describe(failure))
        }
      }
      // Each cleanup runs even if the other fails, and neither may hide why the release stopped.
      cleanup(() => {
        effects.restore()
      })
      if (committed)
        cleanup(() => {
          effects.discardCommit()
        })
      if (failures.length > 0)
        throw new Error(`${describe(error)}; cleanup failed: ${failures.join("; ")}`, {
          cause: error,
        })
    }
    throw error
  }
}
