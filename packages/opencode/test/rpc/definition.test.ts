// covers: ["ADP-036", "ADP-051", "ADP-054"]
import { describe, expect, it } from "vitest"
import { adaptiveRpc, ADAPTIVE_RPC_ID } from "../../src/rpc/definition.js"

type Result = { value: unknown } | { issues: readonly { message: string }[] }

function validate(
  schema: { "~standard": { validate: (value: unknown) => Result | Promise<Result> } },
  value: unknown,
): Result | Promise<Result> {
  return schema["~standard"].validate(value)
}

describe("adaptiveRpc definition", () => {
  it("declares an internal error on every method", () => {
    for (const method of Object.values(adaptiveRpc.methods)) {
      expect(Object.keys(method.errors)).toEqual(["internal"])
    }
  })

  it("rejects empty and oversized session identifiers on read methods", () => {
    for (const name of [
      "session-mode.get",
      "tier-request.get",
      "parked.resume",
      "parked.cancel",
    ] as const) {
      for (const sessionID of ["", "s".repeat(129)]) {
        const verdict = validate(adaptiveRpc.methods[name].input, { sessionID })
        expect("issues" in verdict).toBe(true)
        if (!("issues" in verdict)) return
        expect(verdict.issues[0]?.message).toContain("sessionID")
      }
      const sessionID = "s".repeat(128)
      expect(validate(adaptiveRpc.methods[name].input, { sessionID })).toEqual({
        value: { sessionID },
      })
    }
  })

  it("pins the id, method names, and event names", () => {
    expect(ADAPTIVE_RPC_ID).toBe("coool.adaptive")
    expect(Object.keys(adaptiveRpc.methods).sort()).toEqual([
      "doctor.run",
      "health.reset",
      "parked.cancel",
      "parked.resume",
      "receipts.list",
      "session-mode.get",
      "session-mode.set",
      "settings.get",
      "settings.set",
      "status.get",
      "tier-request.get",
      "tier-request.set",
    ])
    expect(Object.keys(adaptiveRpc.events)).toEqual([
      "settings-changed",
      "session-mode-changed",
      "tier-request-changed",
    ])
  })

  it("void schemas accept undefined and reject any other input", () => {
    for (const name of ["settings.get", "status.get", "receipts.list", "doctor.run"] as const) {
      const input = adaptiveRpc.methods[name].input
      expect(validate(input, undefined)).toEqual({ value: undefined })
      expect("issues" in validate(input, 1)).toBe(true)
      expect("issues" in validate(input, {})).toBe(true)
    }
  })

  it("the settings.set input gate accepts records and rejects the rest", () => {
    const input = adaptiveRpc.methods["settings.set"].input
    const ok = validate(input, { mode: "off" })
    expect(ok).toEqual({ value: { mode: "off" } })
    expect("issues" in validate(input, null)).toBe(true)
    expect("issues" in validate(input, "x")).toBe(true)
    expect("issues" in validate(input, [])).toBe(true)
  })

  it("output schemas pass trusted values through", () => {
    const output = adaptiveRpc.methods["settings.get"].output
    const value = { version: 1, mode: "observe" }
    expect(validate(output, value)).toEqual({ value })
  })

  it("health reset requires bounded model identifiers including any variant", () => {
    const input = adaptiveRpc.methods["health.reset"].input
    for (const value of [
      null,
      [],
      {},
      { providerID: 1 },
      { providerID: " " },
      { providerID: "x".repeat(1025) },
      { providerID: "p", id: "" },
      { providerID: "p", id: "m", variant: null },
      { providerID: "p", id: "m", variant: " " },
    ]) {
      expect(validate(input, value)).toHaveProperty("issues")
    }
    for (const value of [
      { providerID: "p", id: "m" },
      { providerID: "p", id: "m", variant: "high" },
    ])
      expect(validate(input, value)).toEqual({ value })
    expect(validate(adaptiveRpc.methods["health.reset"].output, undefined)).toEqual({
      value: undefined,
    })
    expect(validate(adaptiveRpc.methods["parked.resume"].output, "waiting")).toEqual({
      value: "waiting",
    })
    expect(validate(adaptiveRpc.methods["parked.cancel"].output, "cancelled")).toEqual({
      value: "cancelled",
    })
    expect(validate(adaptiveRpc.methods["doctor.run"].output, [])).toEqual({ value: [] })
  })

  it("the settings-changed event schema validates its data object", () => {
    const schema = adaptiveRpc.events["settings-changed"].schema
    expect(validate(schema, { version: 1 })).toEqual({ value: { version: 1 } })
    expect("issues" in validate(schema, 3)).toBe(true)
  })

  it("gate failures name the expectation, not just 'invalid input'", () => {
    const firstIssue = (result: Result | Promise<Result>): string | undefined => {
      if (result instanceof Promise) return undefined
      return "issues" in result ? result.issues[0]?.message : undefined
    }
    const setInput = adaptiveRpc.methods["settings.set"].input
    expect(firstIssue(validate(setInput, null))).toBe("input must be an object")
    const voidInput = adaptiveRpc.methods["settings.get"].input
    expect(firstIssue(validate(voidInput, 1))).toBe("unexpected input: no input expected")
    const listOutput = adaptiveRpc.methods["receipts.list"].output
    expect(firstIssue(validate(listOutput, {}))).toBe("output must be an array")
    const event = adaptiveRpc.events["settings-changed"].schema
    expect(firstIssue(validate(event, 3))).toBe("event data must be an object")
  })

  it("the session-mode.get gate requires a sessionID string", () => {
    const input = adaptiveRpc.methods["session-mode.get"].input
    expect(validate(input, { sessionID: "ses_1" })).toEqual({ value: { sessionID: "ses_1" } })
    expect("issues" in validate(input, {})).toBe(true)
    expect("issues" in validate(input, { sessionID: 7 })).toBe(true)
    expect("issues" in validate(input, null)).toBe(true)
  })

  it("the session-mode.set gate requires a sessionID string and a mode string or null", () => {
    const input = adaptiveRpc.methods["session-mode.set"].input
    expect(validate(input, { sessionID: "ses_1", mode: null })).toEqual({
      value: { sessionID: "ses_1", mode: null },
    })
    expect(validate(input, { sessionID: "ses_1", mode: "active" })).toEqual({
      value: { sessionID: "ses_1", mode: "active" },
    })
    expect("issues" in validate(input, { sessionID: "ses_1", mode: 7 })).toBe(true)
    expect("issues" in validate(input, { sessionID: "ses_1" })).toBe(true)
    expect("issues" in validate(input, "x")).toBe(true)
  })

  it("the session-mode-changed event schema validates its data object", () => {
    const schema = adaptiveRpc.events["session-mode-changed"].schema
    expect(validate(schema, { sessionID: "ses_1" })).toEqual({ value: { sessionID: "ses_1" } })
    expect("issues" in validate(schema, { version: 1 })).toBe(true)
    expect("issues" in validate(schema, 3)).toBe(true)
  })

  it("the tier-request.set gate requires a sessionID string and a tier string or null", () => {
    const input = adaptiveRpc.methods["tier-request.set"].input
    expect(validate(input, { sessionID: "ses_1", tier: null })).toEqual({
      value: { sessionID: "ses_1", tier: null },
    })
    expect(validate(input, { sessionID: "ses_1", tier: "quick" })).toEqual({
      value: { sessionID: "ses_1", tier: "quick" },
    })
    expect("issues" in validate(input, { sessionID: "ses_1", tier: 7 })).toBe(true)
    expect("issues" in validate(input, { sessionID: "ses_1" })).toBe(true)
    expect("issues" in validate(input, "x")).toBe(true)
  })

  it("the tier-request.get gate requires a sessionID string", () => {
    const input = adaptiveRpc.methods["tier-request.get"].input
    expect(validate(input, { sessionID: "ses_1" })).toEqual({ value: { sessionID: "ses_1" } })
    expect("issues" in validate(input, {})).toBe(true)
    expect("issues" in validate(input, { sessionID: 7 })).toBe(true)
    expect("issues" in validate(input, null)).toBe(true)
  })

  it("the tier-request-changed event schema validates its data object", () => {
    const schema = adaptiveRpc.events["tier-request-changed"].schema
    expect(validate(schema, { sessionID: "ses_1" })).toEqual({ value: { sessionID: "ses_1" } })
    expect("issues" in validate(schema, { version: 1 })).toBe(true)
    expect("issues" in validate(schema, 3)).toBe(true)
  })
})
