import type { PlannedRelease, Plugin } from "./plan.js"

export interface ReleaseEffects {
  prepare(): void
  verify(ids: readonly Plugin[]): void
  restore(): void
  commit(): void
  tag(release: PlannedRelease): void
  publish(id: Plugin): void
  push(): void
}

/** Only uncommitted preparation is reversible. Publication is resumed from tags. */
export function executeRelease(
  plan: readonly PlannedRelease[],
  effects: ReleaseEffects,
  { publish = true }: { publish?: boolean } = {},
): void {
  try {
    effects.prepare()
    effects.verify(plan.map((release) => release.id))
  } catch (error) {
    effects.restore()
    throw error
  }
  effects.commit()
  for (const release of plan) effects.tag(release)
  if (publish) for (const release of plan) effects.publish(release.id)
  effects.push()
}
