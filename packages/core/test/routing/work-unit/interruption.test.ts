// covers: ["ADP-001", "ADP-010"]
import { describe, expect, it } from "vitest"

import { INTERRUPT_REASONS } from "../../../src/routing/work-unit/index.js"

/**
 * These values mirror the verified `session.execution.interrupted` event
 * payload. If OpenCode ever changes the vocabulary, this pin must fail here
 * before anything downstream misclassifies an interruption.
 */
describe("INTERRUPT_REASONS", () => {
  it("matches the verified OpenCode interruption vocabulary", () => {
    expect([...INTERRUPT_REASONS]).toEqual(["user", "shutdown", "superseded", "inactivity"])
  })
})
