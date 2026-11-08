/**
 * Escalation tool tests (T-18, ADP-015): the input schema is a plain JSON
 * Schema object — the host builds the model-facing tool definition by
 * converting the schema and silently drops tools whose schema it cannot
 * convert (a Standard Schema implementation was dropped with "Schema vendor
 * does not support JSON Schema conversion" on 2.2.5). `execute` re-validates
 * defensively before recording against the session's current unit.
 */
// covers: ["ADP-015"]
import { describe, expect, it } from "vitest"

import {
  ESCALATION_TOOL_NAME,
  escalationTool,
} from "../../../src/adapters/opencode/escalation-tool.js"

describe("escalation tool", () => {
  const recorded: { args: [string, string, string][] } = { args: [] }
  const record = (sessionID: string, reason: string, evidence: string): boolean => {
    recorded.args.push([sessionID, reason, evidence])
    return true
  }
  const tool = escalationTool(record)

  it("pins the tool shape", () => {
    expect(tool.name).toBe(ESCALATION_TOOL_NAME)
    expect(tool.name).toBe("adaptive_escalate")
    expect(tool.description).toContain("not a planning")
    expect(tool.description).toContain("reason")
  })

  it("exposes the input as a host-convertible JSON Schema", () => {
    // The host converts the tool's input schema into the model-facing
    // definition; anything it cannot convert silently removes the tool from
    // the agent's tool list, so the JSON Schema shape is the load-bearing
    // contract.
    expect(tool.input).toEqual({
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description: "Short reason why the current work unit needs stronger capability.",
        },
        evidence: {
          type: "string",
          minLength: 1,
          description: "Concrete evidence of the capability gap: what failed or was blocked.",
        },
      },
      required: ["reason", "evidence"],
      additionalProperties: false,
    })
    // Code-mode-bundled tools are only reachable through the host's
    // `execute` tool; a direct call fails with "No tool named ... is
    // currently available" (observed on 2.2.5).
    expect(tool.options).toEqual({ codemode: false })
  })

  it("records a valid request against the session", async () => {
    const result = await tool.execute({ reason: "ctx", evidence: "413" }, { sessionID: "s1" })
    expect(result).toEqual({ content: "escalation request recorded for the current work unit" })
    expect(recorded.args.at(-1)).toEqual(["s1", "ctx", "413"])
  })

  it("rejects invalid input before recording", async () => {
    const before = recorded.args.length
    const result = await tool.execute({ reason: "" }, { sessionID: "s1" })
    expect(result).toEqual({ content: "reason and evidence are required non-empty strings" })
    expect(recorded.args).toHaveLength(before)
  })

  it("reports an unrecorded request when no unit is active", async () => {
    const tool2 = escalationTool(() => false)
    const result = await tool2.execute({ reason: "r", evidence: "e" }, { sessionID: "s9" })
    expect(result).toEqual({ content: "no active work unit; the request was not recorded" })
  })
})
