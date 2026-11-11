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
        // npm's exit status alone is not proof: 1.6.3 exited 0 and never
        // reached the registry, yet was tagged. Tag only what is listed.
        if (effects.registryState() !== "published") {
          throw new Error(
            `publish: npm publish exited 0 but the registry does not list ${target.name}@${target.version}; nothing was tagged, rerun once it does or publish again`,
          )
        }
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
