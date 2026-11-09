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
      verify: (ids) => {
        call(`verify:${ids.join(",")}`)
      },
      restore: () => {
        call("restore")
      },
      commit: () => {
        call("commit")
      },
      push: () => {
        call("push")
      },
    },
  }
}

it("verifies bumped files before committing and pushing; publication is a separate leg", () => {
  const { calls, effects } = fixture()
  executeRelease(plan, effects)
  expect(calls).toEqual(["prepare", "verify:opencode,pi", "commit", "push"])
})

it("restores uncommitted files when preparation or verification fails", () => {
  for (const failure of ["prepare", "verify:opencode,pi"]) {
    const { calls, effects } = fixture(failure)
    expect(() => {
      executeRelease(plan, effects)
    }).toThrow(failure)
    expect(calls.at(-1)).toBe("restore")
    expect(calls).not.toContain("commit")
  }
})

it("never rolls back a commit after a durable failure", () => {
  for (const failure of ["commit", "push"]) {
    const { calls, effects } = fixture(failure)
    expect(() => {
      executeRelease(plan, effects)
    }).toThrow(failure)
    expect(calls.at(-1)).toBe(failure)
    expect(calls).not.toContain("restore")
  }
})
