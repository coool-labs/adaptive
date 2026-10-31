import { describe, expect, it } from "vitest"

import adaptivePlugin, { PLUGIN_ID } from "../src/index.js"

/**
 * The full plugin `Context` carries every OpenCode domain; the entry point
 * touches none of them yet. Tests pass a minimal object through an explicit
 * cast instead of faking ~30 domains that the scaffold does not use.
 */
const fakeContext = {} as Parameters<typeof adaptivePlugin.setup>[0]

describe("plugin entry", () => {
  it("exposes the stable plugin id", () => {
    expect(PLUGIN_ID).toBe("coool.adaptive")
    expect(adaptivePlugin.id).toBe(PLUGIN_ID)
  })

  it("activates without requiring a teardown", () => {
    const result = adaptivePlugin.setup(fakeContext)
    expect(result).toBeUndefined()
  })
})
