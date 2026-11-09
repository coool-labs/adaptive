import { expect, it } from "vitest"
import { executeRelease, type ReleaseEffects } from "../release/execute.js"
import type { PlannedRelease } from "../release/plan.js"

const plan: readonly PlannedRelease[] = [
  {
    id: "opencode",
    name: "@coool/opencode-adaptive",
    previous: "1.5.0",
    version: "1.5.1",
    tag: "opencode-adaptive@1.5.1",
    commits: [],
  },
  {
    id: "pi",
    name: "@coool/pi-adaptive",
    previous: "0.1.0",
    version: "0.1.1",
    tag: "pi-adaptive@0.1.1",
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
      tag: (release) => {
        call(`tag:${release.id}`)
      },
      publish: (id) => {
        call(`publish:${id}`)
      },
      push: () => {
        call("push")
      },
    },
  }
}

it("verifies bumped files before committing, tags both packages before publishing either", () => {
  const { calls, effects } = fixture()
  executeRelease(plan, effects)
  expect(calls).toEqual([
    "prepare",
    "verify:opencode,pi",
    "commit",
    "tag:opencode",
    "tag:pi",
    "publish:opencode",
    "publish:pi",
    "push",
  ])
})

it("leaves publication to the human when asked, keeping commit, tags and push", () => {
  const { calls, effects } = fixture()
  executeRelease(plan, effects, { publish: false })
  expect(calls).toEqual([
    "prepare",
    "verify:opencode,pi",
    "commit",
    "tag:opencode",
    "tag:pi",
    "push",
  ])
})

it("restores uncommitted files when preparation or verification fails", () => {
  for (const failure of ["prepare", "verify:opencode,pi"]) {
    const { calls, effects } = fixture(failure)
    expect(() => {
      executeRelease(plan, effects)
    }).toThrow(failure)
    expect(calls.at(-1)).toBe("restore")
    expect(calls).not.toContain("commit")
    expect(calls).not.toContain("publish:opencode")
  }
})

it("never rolls back a commit or repeats publication after a durable failure", () => {
  for (const failure of ["commit", "tag:pi", "publish:pi", "push"]) {
    const { calls, effects } = fixture(failure)
    expect(() => {
      executeRelease(plan, effects)
    }).toThrow(failure)
    expect(calls.at(-1)).toBe(failure)
    expect(calls).not.toContain("restore")
    expect(calls.filter((step) => step === "publish:opencode").length).toBeLessThanOrEqual(1)
  }
})
