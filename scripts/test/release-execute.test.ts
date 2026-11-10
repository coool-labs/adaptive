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

function fixture(failure?: string | readonly string[]): {
  calls: string[]
  effects: ReleaseEffects
} {
  const calls: string[] = []
  const call = (step: string): void => {
    calls.push(step)
    if (typeof failure === "string" ? step === failure : failure?.includes(step))
      throw new Error(step)
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

it("still discards the local commit when restoring the files fails, and says why the release stopped", () => {
  const { calls, effects } = fixture(["verify:opencode,pi", "restore"])
  expect(() => {
    executeRelease(plan, effects)
  }).toThrow("verify:opencode,pi; cleanup failed: restore")
  expect(calls).toEqual(["prepare", "commit", "verify:opencode,pi", "restore", "discardCommit"])
})

it("restores the files when discarding the local commit is refused, keeping the original failure first", () => {
  const { calls, effects } = fixture(["verify:opencode,pi", "discardCommit"])
  const failure = (() => {
    try {
      executeRelease(plan, effects)
    } catch (error) {
      return error
    }
    return undefined
  })()
  expect(failure).toMatchObject({
    message: "verify:opencode,pi; cleanup failed: discardCommit",
    cause: { message: "verify:opencode,pi" },
  })
  expect(calls).toEqual(["prepare", "commit", "verify:opencode,pi", "restore", "discardCommit"])
})

it("reports every failed cleanup step before the release error and never discards an uncommitted tree", () => {
  const both = fixture(["verify:opencode,pi", "restore", "discardCommit"])
  expect(() => {
    executeRelease(plan, both.effects)
  }).toThrow("verify:opencode,pi; cleanup failed: restore; discardCommit")
  const early = fixture(["commit", "restore"])
  expect(() => {
    executeRelease(plan, early.effects)
  }).toThrow("commit; cleanup failed: restore")
  expect(early.calls).not.toContain("discardCommit")
})

it("describes a non-Error failure by its text", () => {
  const { effects } = fixture()
  expect(() => {
    executeRelease(plan, {
      ...effects,
      verify: () => {
        throw "plain string" // eslint-disable-line @typescript-eslint/only-throw-error
      },
      restore: () => {
        throw "cleanup string" // eslint-disable-line @typescript-eslint/only-throw-error
      },
    })
  }).toThrow("plain string; cleanup failed: cleanup string")
})
