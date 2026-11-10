// covers: ["ADP-025"]
import { describe, expect, it } from "vitest"

import { shouldResumeGoal } from "../../../src/execution/continuation/goal.js"

describe("shouldResumeGoal", () => {
  it("resumes a goal the host paused over a session failure", () => {
    expect(
      shouldResumeGoal({
        status: "paused",
        reason: "The session failed: Model API quota exceeded across all providers",
      }),
    ).toBe(true)
  })

  it("leaves every deliberate pause paused", () => {
    const deliberate = [
      "Paused by the user",
      "Stopped by the user",
      "Not making progress: the reviewer found no tool calls",
      "The goal reviewer gave no usable verdict",
      "The goal reviewer's request is too large for the model",
      "The goal stopped after an error",
      "Nothing ran for 5 minutes while the goal waited on background work",
      "The server restarted while the goal was active",
      "Reached the limit of 50 rounds",
    ]
    for (const reason of deliberate) {
      expect(shouldResumeGoal({ status: "paused", reason })).toBe(false)
    }
  })

  it("ignores the reason on non-paused goals and missing reasons", () => {
    expect(shouldResumeGoal({ status: "active" })).toBe(false)
    expect(shouldResumeGoal({ status: "complete" })).toBe(false)
    expect(shouldResumeGoal({ status: "paused" })).toBe(false)
  })

  it("treats an absent goal as nothing to resume", () => {
    expect(shouldResumeGoal(null)).toBe(false)
    expect(shouldResumeGoal(undefined)).toBe(false)
  })
})
