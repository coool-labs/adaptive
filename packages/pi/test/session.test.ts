// covers: ["ADP-028", "ADP-029", "ADP-054", "ADP-055", "ADP-057"]
import { expect, it } from "vitest"
import { effectiveMode, requestedTier, SESSION_ENTRY, sessionModeOverride } from "../src/session.js"
import type { BranchEntry } from "../src/task.js"

const entry = (data: unknown): BranchEntry => ({ type: "custom", customType: SESSION_ENTRY, data })
it("activates Adaptive selections but never takes a manually chosen model", () => {
  const physical = { provider: "p", id: "m" }
  for (const global of ["off", "observe", "active"] as const) {
    expect(effectiveMode({ provider: "adaptive", id: "auto" }, global, [])).toBe("active")
    expect(effectiveMode(physical, global, [])).toBe(global === "off" ? "off" : "observe")
  }
  expect(effectiveMode(undefined, "observe", [])).toBe("observe")
  expect(effectiveMode({ provider: "adaptive", id: "unknown" }, "off", [])).toBe("off")
  expect(effectiveMode(physical, "off", [entry({ version: 1, mode: "observe" })])).toBe("observe")
  expect(effectiveMode(physical, "observe", [entry({ version: 1, mode: "off" })])).toBe("off")
  expect(
    sessionModeOverride([
      { type: "custom", customType: "other" },
      entry({ version: 1, mode: "active" }),
      entry({ version: 1, mode: null }),
    ]),
  ).toBeNull()
  expect(sessionModeOverride([entry({ version: 1, tier: "quick" })])).toBeNull()
})

it("resolves dialog and agent tier requests chronologically and supports clearing/forks", () => {
  const agent = (tier: unknown): BranchEntry => ({
    type: "message",
    message: { role: "toolResult", toolName: "adaptive_tier", details: { tier } },
  })
  const branch = [
    agent("quick"),
    entry({ version: 1, tier: "advanced" }),
    agent("standard"),
    entry({ version: 1, tier: null }),
  ]
  expect(requestedTier(branch.slice(0, 1))).toBe("quick")
  expect(requestedTier(branch.slice(0, 2))).toBe("advanced")
  expect(requestedTier(branch.slice(0, 3))).toBe("standard")
  expect(requestedTier(branch)).toBeNull()
  expect(
    requestedTier([
      agent("bad"),
      {
        type: "message",
        message: { role: "toolResult", toolName: "adaptive_tier", details: null },
      },
      entry({ version: 1, mode: "off" }),
      agent(null),
    ]),
  ).toBeNull()
  expect(requestedTier([{ type: "custom" }])).toBeNull()
})

it("rejects malformed owned session metadata instead of inventing a policy", () => {
  for (const data of [
    null,
    { version: 2 },
    { version: 1, mode: 1 },
    { version: 1, tier: "bad" },
    { version: 1, tier: 1 },
  ])
    expect(() => sessionModeOverride([entry(data)])).toThrow("Adaptive session")
})
