/**
 * TUI option-shape helpers. `errorText` renders API failures for toasts:
 * host RPC failures arrive as plain objects, so the object path — including
 * BigInt-safe stringification — is pinned here (a "[object Object]" toast
 * would throw away the only diagnostic the user gets).
 */
// covers: ["ADP-033"]
import { describe, expect, it } from "vitest"

import { errorText } from "../../../src/ui/flow/options.js"

describe("errorText", () => {
  it("uses the message of an Error instance", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
  })

  it("uses the message of a plain RPC-failure object", () => {
    expect(errorText({ type: "rpc.unavailable", message: "RPC is unavailable: x" })).toBe(
      "RPC is unavailable: x",
    )
  })

  it("stringifies an object without a message instead of rendering [object Object]", () => {
    expect(errorText({ type: "rpc.timeout" })).toBe('{"type":"rpc.timeout"}')
  })

  it("stringifies BigInt values as strings instead of throwing", () => {
    const error = { retries: 9007199254740993n }
    expect(errorText(error)).toBe('{"retries":"9007199254740993"}')
  })

  it("falls back to String() for primitives", () => {
    expect(errorText("plain")).toBe("plain")
    expect(errorText(42)).toBe("42")
    expect(errorText(undefined)).toBe("undefined")
  })
})
