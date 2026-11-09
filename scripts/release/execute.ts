import type { PlannedRelease, Plugin } from "./plan.js"

export interface ReleaseEffects {
  prepare(): void
  verify(ids: readonly Plugin[]): void
  restore(): void
  commit(): void
  push(): void
}

/**
 * Only uncommitted preparation is reversible. Publication (and the tag that
 * certifies it) happens in the publish scripts, after `npm publish` succeeds.
 */
export function executeRelease(plan: readonly PlannedRelease[], effects: ReleaseEffects): void {
  try {
    effects.prepare()
    effects.verify(plan.map((release) => release.id))
  } catch (error) {
    effects.restore()
    throw error
  }
  effects.commit()
  effects.push()
}
