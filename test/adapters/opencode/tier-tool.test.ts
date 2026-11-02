/**
 * Tier-tool tests (ADP-055): the agent's tier-declaration surface, a typed
 * sibling of adaptive_escalate. The input schema is a plain JSON Schema
 * object — the host builds the model-facing tool definition by converting
 * the schema and silently drops tools whose schema it cannot convert.
 * `execute` re-validates defensively before recording against the session.
 */
// covers: ["ADP-055"]
import { describe, expect, it } from "vitest"

import { tierTool } from "../../../src/adapters/opencode/tier-tool.js"

describe("tier tool", () => {
  const recorded: { args: [string, string][] } = { args: [] }
  const record = (sessionID: string, tier: string): boolean => {
    recorded.args.push([sessionID, tier])
    return true
  }
  const tool = tierTool(record)

  it("pins the tool shape", () => {
    expect(tool.name).toBe("adaptive_tier")
    expect(tool.description).toContain("quick")
    expect(tool.description).toContain("advanced")
    expect(tool.description).toContain("stays in force")
    expect(tool.description).toContain("never use this to work around unavailability")
  })

  it("exposes the input as a host-convertible JSON Schema", () => {
    expect(tool.input).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        tier: {
          description: "The tier the current task needs.",
          enum: ["quick", "standard", "advanced"],
        },
      },
      required: ["tier"],
      additionalProperties: false,
    })
    // Code-mode-bundled tools are only reachable through the host's
    // `execute` tool; a direct call fails with "No tool named ... is
    // currently available" (observed on 2.2.5).
    expect(tool.options).toEqual({ codemode: false })
  })

  it("records a valid tier against the session", async () => {
    const result = await tool.execute({ tier: "quick" }, { sessionID: "s1" })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Tier request recorded: quick. It steers this session's next admissions until cleared.",
        },
      ],
    })
    expect(recorded.args.at(-1)).toEqual(["s1", "quick"])
  })

  it("accepts every tier name", async () => {
    for (const tier of ["standard", "advanced"] as const) {
      const result = await tool.execute({ tier }, { sessionID: "s2" })
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: `Tier request recorded: ${tier}. It steers this session's next admissions until cleared.`,
          },
        ],
      })
    }
    expect(recorded.args.slice(-2)).toEqual([
      ["s2", "standard"],
      ["s2", "advanced"],
    ])
  })

  it("rejects invalid input before recording", async () => {
    const before = recorded.args.length
    for (const input of [
      { tier: "sideways" },
      {},
      { tier: 7 },
      "quick",
      null,
      { tier: null },
      undefined,
    ]) {
      const result = await tierTool(record).execute(input, { sessionID: "s1" })
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "adaptive_tier rejected: tier must be quick, standard, or advanced.",
          },
        ],
      })
    }
    expect(recorded.args).toHaveLength(before)
  })

  it("reports an unaccepted request when the supervisor refuses", async () => {
    const tool2 = tierTool(() => false)
    const result = await tool2.execute({ tier: "quick" }, { sessionID: "s9" })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "adaptive_tier rejected: the tier request was not accepted.",
        },
      ],
    })
  })
})
