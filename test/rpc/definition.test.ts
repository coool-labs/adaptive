// covers: ["ADP-036", "ADP-051"]
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
  it("pins the id, method names, and event names", () => {
    expect(ADAPTIVE_RPC_ID).toBe("coool.adaptive")
    expect(Object.keys(adaptiveRpc.methods).sort()).toEqual([
      "receipts.list",
      "settings.get",
      "settings.set",
      "status.get",
    ])
    expect(Object.keys(adaptiveRpc.events)).toEqual(["settings-changed"])
  })

  it("void schemas accept undefined and reject any other input", () => {
    for (const name of ["settings.get", "status.get", "receipts.list"] as const) {
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
})
