// covers: ["ADP-050"]
import { tagName, type Plugin } from "../release/plan.js"

export interface PublishTarget {
  readonly id: Plugin
  readonly name: string
  readonly version: string
  readonly tag: string
}

export function planPublish(pkg: {
  readonly id: Plugin
  readonly name: string
  readonly version: string
  readonly private: boolean
}): PublishTarget {
  if (pkg.private) throw new Error(`publish: ${pkg.id} is private`)
  return { id: pkg.id, name: pkg.name, version: pkg.version, tag: tagName(pkg.id, pkg.version) }
}

/** The tag state on the local repository relative to HEAD. */
export type LocalTag = "absent" | "on-head" | "detached"

export interface PublishState {
  readonly published: boolean
  readonly localTag: LocalTag
}

export type PublishAction = "publish" | "tag" | "pushTag"

/**
 * Sequence that makes the registry and the certification tag agree with the
 * published manifest version. The push is always requested: pushing an
 * up-to-date tag is a no-op, and an existing local tag still has to reach the
 * remote after a manual publish.
 */
export function publishActions(state: PublishState, tag: string): readonly PublishAction[] {
  if (state.localTag === "detached") throw new Error(`publish: ${tag} points at a different commit`)
  const actions: PublishAction[] = []
  if (!state.published) actions.push("publish")
  if (state.localTag === "absent") actions.push("tag")
  actions.push("pushTag")
  return actions
}
