/**
 * Escalation tool tests (T-18, ADP-015): the Standard Schema v1 input
 * contract validates reason+evidence, and `execute` re-validates
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

  it("validates through the standard schema contract", () => {
    const success = tool.input["~standard"].validate({ reason: "r", evidence: "e" })
    expect(success).toEqual({ value: { reason: "r", evidence: "e" } })
    const failure = tool.input["~standard"].validate({ reason: "" })
    expect(failure).toEqual({
      issues: [{ message: "reason and evidence are required non-empty strings" }],
    })
    expect(tool.input["~standard"].version).toBe(1)
    expect(tool.input["~standard"].vendor).toBe("coool.adaptive")
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
