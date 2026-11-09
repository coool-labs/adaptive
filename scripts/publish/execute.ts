// covers: ["ADP-050"]
import type { PublishAction, PublishState, PublishTarget } from "./plan.js"
import { publishActions } from "./plan.js"

export interface PublishEffects {
  registryState(): "published" | "missing"
  localTag(): PublishState["localTag"]
  publish(): void
  createTag(): void
  pushTag(): void
}

export function executePublish(
  target: PublishTarget,
  effects: PublishEffects,
): readonly PublishAction[] {
  const actions = publishActions(
    { published: effects.registryState() === "published", localTag: effects.localTag() },
    target.tag,
  )
  for (const action of actions) {
    switch (action) {
      case "publish":
        effects.publish()
        break
      case "tag":
        effects.createTag()
        break
      case "pushTag":
        effects.pushTag()
        break
    }
  }
  return actions
}
