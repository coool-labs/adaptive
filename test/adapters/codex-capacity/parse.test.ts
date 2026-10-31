import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  parseCodexUsage,
  isCodexHeaderName,
  CODEX_HEADER_MARK,
} from "../../../src/adapters/codex-capacity/parse.js"
import { CODEX_SENSOR_ID, CODEX_WINDOW_KINDS } from "../../../src/adapters/codex-capacity/types.js"

describe("codex header vocabulary", () => {
  it("pins the sensor id and window kinds", () => {
    expect(CODEX_SENSOR_ID).toBe("codex-headers")
    expect(CODEX_WINDOW_KINDS).toEqual(["primary", "secondary"])
  })

  it("pins the header mark", () => {
    expect(CODEX_HEADER_MARK).toBe("x-codex-")
  })

  it("matches plain and LiteLLM-prefixed names", () => {
    expect(isCodexHeaderName("x-codex-primary-used-percent")).toBe(true)
    expect(isCodexHeaderName("llm_provider-x-codex-secondary-used-percent")).toBe(true)
    expect(isCodexHeaderName("authorization")).toBe(false)
    expect(isCodexHeaderName("retry-after")).toBe(false)
    expect(isCodexHeaderName("")).toBe(false)
  })
})

describe("parseCodexUsage", () => {
  it("parses both windows", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "17",
      "x-codex-primary-reset-after-seconds": "600",
      "x-codex-secondary-used-percent": "42",
      "x-codex-secondary-window-minutes": "10080",
    })
    expect(usage).toEqual({
      primary: { usedPercent: 17, resetAfterSeconds: 600 },
      secondary: { usedPercent: 42 },
    })
  })

  it("parses a single window", () => {
    const usage = parseCodexUsage({ "x-codex-primary-used-percent": "0" })
    expect(usage).toEqual({ primary: { usedPercent: 0 } })
  })

  it("is case-insensitive and accepts LiteLLM prefixes", () => {
    const usage = parseCodexUsage({
      "X-Codex-Primary-Used-Percent": "5",
      "llm_provider-x-codex-secondary-used-percent": "80",
    })
    expect(usage).toEqual({
      primary: { usedPercent: 5 },
      secondary: { usedPercent: 80 },
    })
  })

  it("prefers reset-after-seconds over reset-at", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-reset-after-seconds": "120",
      "x-codex-primary-reset-at": "9999999999",
    })
    expect(usage?.primary).toEqual({
      usedPercent: 50,
      resetAfterSeconds: 120,
      resetAtSeconds: 9999999999,
    })
  })

  it("accepts reset-at alone (epoch seconds)", () => {
    const usage = parseCodexUsage({
      "x-codex-secondary-used-percent": "1",
      "x-codex-secondary-reset-at": "12345",
    })
    expect(usage?.secondary).toEqual({ usedPercent: 1, resetAtSeconds: 12345 })
  })

  it("drops the documented empty-string reset-at", () => {
    const usage = parseCodexUsage({
      "x-codex-secondary-used-percent": "81",
      "x-codex-secondary-reset-after-seconds": "0",
      "x-codex-secondary-reset-at": "",
    })
    expect(usage?.secondary).toEqual({ usedPercent: 81, resetAfterSeconds: 0 })
  })

  it("rejects percentages out of range or unparseable (window dropped)", () => {
    expect(parseCodexUsage({ "x-codex-primary-used-percent": "101" })).toBeNull()
    expect(parseCodexUsage({ "x-codex-primary-used-percent": "-1" })).toBeNull()
    expect(parseCodexUsage({ "x-codex-primary-used-percent": "abc" })).toBeNull()
    expect(parseCodexUsage({ "x-codex-primary-used-percent": "NaN" })).toBeNull()
    expect(parseCodexUsage({ "x-codex-primary-used-percent": "" })).toBeNull()
  })

  it("keeps a valid window when the other window is invalid", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "30",
      "x-codex-secondary-used-percent": "not-a-number",
    })
    expect(usage).toEqual({ primary: { usedPercent: 30 } })
  })

  it("drops invalid reset fields but keeps the percentage", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-after-seconds": "-5",
      "x-codex-primary-reset-at": "nope",
    })
    expect(usage?.primary).toEqual({ usedPercent: 10 })
  })

  it("ignores unknown fields and unknown window kinds", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "10",
      "x-codex-tertiary-used-percent": "90",
      "x-codex-primary-mood": "fine",
      "x-codex-used-percent": "70",
    })
    expect(usage).toEqual({ primary: { usedPercent: 10 } })
  })

  it("ignores entries without the codex mark", () => {
    expect(parseCodexUsage({ "retry-after": "30", authorization: "secret" })).toBeNull()
  })

  it("first valid value wins over later case-duplicates", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "25",
      "X-CODEX-PRIMARY-USED-PERCENT": "90",
      "x-codex-primary-reset-after-seconds": "60",
      "LITELLM-X-CODEX-PRIMARY-RESET-AFTER-SECONDS": "1",
    })
    expect(usage?.primary).toEqual({ usedPercent: 25, resetAfterSeconds: 60 })
  })

  it("accumulates fields regardless of entry order", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-reset-after-seconds": "45",
      "x-codex-primary-used-percent": "33",
    })
    expect(usage?.primary).toEqual({ usedPercent: 33, resetAfterSeconds: 45 })
  })

  it("returns null for empty capture sets", () => {
    expect(parseCodexUsage({})).toBeNull()
  })

  it("parses whitespace-padded numeric values", () => {
    const usage = parseCodexUsage({ "x-codex-primary-used-percent": " 55 " })
    expect(usage?.primary).toEqual({ usedPercent: 55 })
  })

  it("accepts fractional percentages and reset seconds", () => {
    const usage = parseCodexUsage({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-reset-after-seconds": "90.5",
    })
    expect(usage?.primary).toEqual({ usedPercent: 12.5, resetAfterSeconds: 90.5 })
  })

  it("property: total over arbitrary captures, result always valid or null", () => {
    const valueArb = fc.oneof(
      fc.integer({ min: -50, max: 150 }).map(String),
      fc.constant(""),
      fc.constant("junk"),
      fc.constant("12.5"),
      fc.constant("-3"),
      fc.constant("NaN"),
      fc.constant("Infinity"),
    )
    const nameArb = fc.oneof(
      fc.constant("x-codex-primary-used-percent"),
      fc.constant("x-codex-secondary-used-percent"),
      fc.constant("x-codex-primary-reset-after-seconds"),
      fc.constant("x-codex-secondary-reset-at"),
      fc.constant("LLM-X-Codex-Primary-Reset-After-Seconds"),
      fc.constant("authorization"),
      fc.constant("x-codex-primary-window-minutes"),
    )
    const captureArb = fc
      .uniqueArray(fc.record({ name: nameArb, value: valueArb }), { maxLength: 8 })
      .map((entries) => Object.fromEntries(entries.map((e) => [e.name, e.value])))
    fc.assert(
      fc.property(captureArb, (captured) => {
        const usage = parseCodexUsage(captured)
        if (usage === null) {
          return
        }
        const windows = [usage.primary, usage.secondary]
        const present = windows.filter((w) => w !== undefined)
        expect(present.length).toBeGreaterThan(0)
        for (const window of present) {
          expect(window.usedPercent).toBeGreaterThanOrEqual(0)
          expect(window.usedPercent).toBeLessThanOrEqual(100)
          if (window.resetAfterSeconds !== undefined) {
            expect(window.resetAfterSeconds).toBeGreaterThanOrEqual(0)
          }
          if (window.resetAtSeconds !== undefined) {
            expect(window.resetAtSeconds).toBeGreaterThanOrEqual(0)
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  it("property: deterministic", () => {
    const captureArb = fc.dictionary(
      fc.constantFrom(
        "x-codex-primary-used-percent",
        "x-codex-secondary-used-percent",
        "x-codex-primary-reset-at",
      ),
      fc.integer({ min: -10, max: 120 }).map(String),
      { maxKeys: 3 },
    )
    fc.assert(
      fc.property(captureArb, fc.integer({ min: 0, max: 10 }), (captured, drop) => {
        const trimmed: Record<string, string> = {}
        const keys = Object.keys(captured)
        keys.forEach((key, index) => {
          if (index !== drop % keys.length) {
            trimmed[key] = captured[key] ?? "0"
          }
        })
        expect(parseCodexUsage(trimmed)).toEqual(parseCodexUsage(trimmed))
      }),
      { numRuns: 100 },
    )
  })
})
