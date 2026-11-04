// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"

import { matchOptions } from "../../../src/ui/tui/search.js"

describe("matchOptions", () => {
  const options = [
    { title: "openai/gpt-5", description: "GPT-5" },
    { title: "anthropic/claude-x", description: "Claude X" },
    { title: "local/plain" },
  ]

  it("matches title or description case-insensitively and keeps everything on a blank query", () => {
    expect(matchOptions("", options)).toEqual(options)
    expect(matchOptions("  ", options)).toEqual(options)
    expect(matchOptions("OPENAI", options)).toEqual([options[0]])
    expect(matchOptions("claude x", options)).toEqual([options[1]])
    expect(matchOptions("plain", options)).toEqual([options[2]])
    expect(matchOptions("zzz", options)).toEqual([])
  })

  it("still finds everything the old per-field search did (provider, model id, name) and also the full id", () => {
    expect(matchOptions("openai", options)).toEqual([options[0]])
    expect(matchOptions("gpt-5", options)).toEqual([options[0]])
    expect(matchOptions("claude x", options)).toEqual([options[1]])
    expect(matchOptions("anthropic/claude-x", options)).toEqual([options[1]])
  })
})
