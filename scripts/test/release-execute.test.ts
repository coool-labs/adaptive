import { expect, it } from "vitest"
import { executeRelease, type ReleaseEffects } from "../release/execute.js"
import type { PlannedRelease } from "../release/plan.js"

const plan: readonly PlannedRelease[] = [
  {
    id: "opencode",
    name: "@coool/opencode-adaptive",
    previous: "1.5.0",
    version: "1.6.0",
    tag: "opencode-v1.6.0",
    commits: [],
  },
  {
    id: "pi",
    name: "@coool/pi-adaptive",
    previous: "0.0.0",
    version: "1.0.0",
    tag: "pi-v1.0.0",
    commits: [],
  },
]

function fixture(failure?: string): { calls: string[]; effects: ReleaseEffects } {
  const calls: string[] = []
  const call = (step: string): void => {
    calls.push(step)
    if (step === failure) throw new Error(step)
  }
  return {
    calls,
    effects: {
      prepare: () => {
        call("prepare")
      },
      commit: () => {
        call("commit")
      },
      verify: (ids) => {
        call(`verify:${ids.join(",")}`)
      },
      discardCommit: () => {
        call("discardCommit")
      },
      restore: () => {
        call("restore")
      },
      push: () => {
        call("push")
      },
    },
  }
}

it("commits the bumps before verifying so the stage stays clean; publication is a separate leg", () => {
  const { calls, effects } = fixture()
  executeRelease(plan, effects)
  expect(calls).toEqual(["prepare", "commit", "verify:opencode,pi", "push"])
})

it("restores and discards the local commit when verification fails", () => {
  const { calls, effects } = fixture("verify:opencode,pi")
  expect(() => {
    executeRelease(plan, effects)
  }).toThrow("verify:opencode,pi")
  expect(calls).toEqual(["prepare", "commit", "verify:opencode,pi", "restore", "discardCommit"])
})

it("restores uncommitted bumps when preparation or the commit fails", () => {
  for (const failure of ["prepare", "commit"]) {
    const { calls, effects } = fixture(failure)
    expect(() => {
      executeRelease(plan, effects)
    }).toThrow(failure)
    expect(calls.at(-1)).toBe("restore")
    expect(calls).not.toContain("discardCommit")
  }
})

it("keeps the verified commit when the push fails", () => {
  const { calls, effects } = fixture("push")
  expect(() => {
    executeRelease(plan, effects)
  }).toThrow("push")
  expect(calls.at(-1)).toBe("push")
  expect(calls).not.toContain("restore")
  expect(calls).not.toContain("discardCommit")
})
