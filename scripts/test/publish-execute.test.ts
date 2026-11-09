// covers: ["ADP-050"]
import { describe, expect, it } from "vitest"
import { executePublish, type PublishEffects } from "../publish/execute.js"

const TARGET = { id: "pi" as const, name: "@coool/pi-adaptive", version: "1.0.0", tag: "pi-v1.0.0" }

interface RecordingEffects extends PublishEffects {
  readonly calls: string[]
}

function recording(state: { published: boolean; localTag: "absent" | "on-head" | "detached" }) {
  const calls: string[] = []
  const effects: RecordingEffects = {
    calls,
    registryState: () => {
      calls.push("registryState")
      return state.published ? "published" : "missing"
    },
    localTag: () => {
      calls.push("localTag")
      return state.localTag
    },
    publish: () => calls.push("publish"),
    createTag: () => calls.push("createTag"),
    pushTag: () => calls.push("pushTag"),
  }
  return effects
}

describe("executePublish", () => {
  it("publishes, tags and pushes in dependency order", () => {
    const effects = recording({ published: false, localTag: "absent" })
    expect(executePublish(TARGET, effects)).toEqual(["publish", "tag", "pushTag"])
    expect(effects.calls).toEqual(["registryState", "localTag", "publish", "createTag", "pushTag"])
  })

  it("does not publish or tag again when both already agree", () => {
    const effects = recording({ published: true, localTag: "on-head" })
    expect(executePublish(TARGET, effects)).toEqual(["pushTag"])
    expect(effects.calls).toEqual(["registryState", "localTag", "pushTag"])
  })

  it("propagates a detached-tag refusal before any effect runs", () => {
    const effects = recording({ published: false, localTag: "detached" })
    expect(() => executePublish(TARGET, effects)).toThrow(
      "publish: pi-v1.0.0 points at a different commit",
    )
    expect(effects.calls).toEqual(["registryState", "localTag"])
  })
})
