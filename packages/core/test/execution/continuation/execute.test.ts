// covers: ["ADP-014", "ADP-023"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { executeContinuation } from "../../../src/execution/continuation/execute.js"
import { CONTINUATION_ACTIONS } from "../../../src/execution/continuation/types.js"
import { CONTINUATION_PROMPT } from "../../../src/execution/continuation/prompts.js"
import type {
  ContinuationAction,
  ContinuationExecuteInput,
  ContinuationOps,
} from "../../../src/execution/continuation/types.js"
import type { ModelRef } from "../../../src/routing/work-unit/types.js"

class FakeOps implements ContinuationOps {
  readonly calls: string[] = []
  failOn?: "settle" | "switchModel" | "prompt" | undefined

  settle(sessionID: string): Promise<void> {
    this.calls.push(`settle:${sessionID}`)
    if (this.failOn === "settle") return Promise.reject(new Error("settle failed"))
    return Promise.resolve()
  }

  switchModel(sessionID: string, model: ModelRef): Promise<void> {
    this.calls.push(`switch:${sessionID}:${model.providerID}/${model.id}`)
    if (this.failOn === "switchModel") return Promise.reject(new Error("switch failed"))
    return Promise.resolve()
  }

  prompt(sessionID: string, text: string): Promise<void> {
    this.calls.push(`prompt:${sessionID}:${text}`)
    if (this.failOn === "prompt") return Promise.reject(new Error("prompt failed"))
    return Promise.resolve()
  }
}

function baseInput(overrides?: Partial<ContinuationExecuteInput>): ContinuationExecuteInput {
  return {
    sessionID: "s1",
    action: { kind: "clean-continuation" },
    ops: new FakeOps(),
    ...overrides,
  }
}

describe("continuation vocabulary", () => {
  it("pins the continuation actions", () => {
    expect(CONTINUATION_ACTIONS).toEqual(["allow-native", "in-session", "clean-continuation"])
  })

  it("pins the fixed continuation prompt (never empty, never caller-chosen)", () => {
    expect(typeof CONTINUATION_PROMPT).toBe("string")
    expect(CONTINUATION_PROMPT.length).toBeGreaterThan(0)
  })
})

describe("executeContinuation", () => {
  it("performs no host operations for allow-native", async () => {
    const ops = new FakeOps()
    const input = baseInput({ action: { kind: "allow-native" }, ops })
    await expect(executeContinuation(input)).resolves.toEqual({ kind: "left-native" })
    expect(ops.calls).toEqual([])
  })

  it("settles, switches, then resumes the in-session path with the continuation prompt", async () => {
    const ops = new FakeOps()
    const action: ContinuationAction = { kind: "in-session", model: { providerID: "p", id: "m" } }
    await expect(executeContinuation(baseInput({ action, ops }))).resolves.toEqual({
      kind: "resumed",
    })
    expect(ops.calls).toEqual([`settle:s1`, `switch:s1:p/m`, `prompt:s1:${CONTINUATION_PROMPT}`])
  })

  it("skips the switch when the plan carries none (clean continuation)", async () => {
    const ops = new FakeOps()
    await expect(executeContinuation(baseInput({ ops }))).resolves.toEqual({
      kind: "continuation-started",
    })
    expect(ops.calls).toEqual([`settle:s1`, `prompt:s1:${CONTINUATION_PROMPT}`])
  })

  it("propagates settle failures before any switch or prompt", async () => {
    const ops = new FakeOps()
    ops.failOn = "settle"
    const action: ContinuationAction = { kind: "in-session", model: { providerID: "p", id: "m" } }
    await expect(executeContinuation(baseInput({ action, ops }))).rejects.toThrow("settle failed")
    expect(ops.calls).toEqual([`settle:s1`])
  })

  it("propagates switch failures before any prompt", async () => {
    const ops = new FakeOps()
    ops.failOn = "switchModel"
    const action: ContinuationAction = { kind: "in-session", model: { providerID: "p", id: "m" } }
    await expect(executeContinuation(baseInput({ action, ops }))).rejects.toThrow("switch failed")
    expect(ops.calls).toEqual([`settle:s1`, `switch:s1:p/m`])
  })

  it("propagates prompt failures", async () => {
    const ops = new FakeOps()
    ops.failOn = "prompt"
    await expect(executeContinuation(baseInput({ ops }))).rejects.toThrow("prompt failed")
    expect(ops.calls).toEqual([`settle:s1`, `prompt:s1:${CONTINUATION_PROMPT}`])
  })
})

describe("executeContinuation properties", () => {
  const actionArb: fc.Arbitrary<ContinuationAction> = fc
    .constantFrom("allow-native", "in-session", "clean")
    .chain((kind): fc.Arbitrary<ContinuationAction> => {
      if (kind === "allow-native") return fc.constant({ kind: "allow-native" })
      if (kind === "clean") return fc.constant({ kind: "clean-continuation" })
      return fc
        .record({
          providerID: fc.string({ minLength: 1 }),
          id: fc.string({ minLength: 1 }),
          probeId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        })
        .map((r) =>
          r.probeId === undefined
            ? { kind: "in-session", model: { providerID: r.providerID, id: r.id } }
            : {
                kind: "in-session",
                model: { providerID: r.providerID, id: r.id },
                probeId: r.probeId,
              },
        )
    })

  it("enforces settle-first ordering and delivers exactly the continuation prompt", async () => {
    await fc.assert(
      fc.asyncProperty(actionArb, async (action) => {
        const ops = new FakeOps()
        const outcome = await executeContinuation({ sessionID: "sX", action, ops })
        const promptCalls = ops.calls.filter((call) => call.startsWith("prompt:"))
        if (action.kind === "allow-native") {
          expect(outcome).toEqual({ kind: "left-native" })
          expect(ops.calls).toEqual([])
          return
        }
        expect(ops.calls[0]).toBe("settle:sX")
        expect(promptCalls).toEqual([`prompt:sX:${CONTINUATION_PROMPT}`])
        if (action.kind === "in-session") {
          expect(ops.calls).toEqual([
            `settle:sX`,
            `switch:sX:${action.model.providerID}/${action.model.id}`,
            `prompt:sX:${CONTINUATION_PROMPT}`,
          ])
          expect(outcome).toEqual({ kind: "resumed" })
        } else {
          expect(outcome).toEqual({ kind: "continuation-started" })
        }
      }),
      { numRuns: 200 },
    )
  })

  it("never replays an original instruction — every delivered prompt is the fixed continuation prompt", async () => {
    // Originals that happen to be substrings of the only prompt call the
    // executor can make (prefix + prompt text) cannot distinguish a replay
    // from continue-from-state; exclude them from the generated space.
    const onlyCall = `prompt:s1:${CONTINUATION_PROMPT}`
    const originalArb = fc.string({ minLength: 1 }).filter((s) => !onlyCall.includes(s))
    await fc.assert(
      fc.asyncProperty(actionArb, originalArb, async (action, originalInstruction) => {
        const ops = new FakeOps()
        await executeContinuation({ sessionID: "s1", action, ops })
        // No generated text ever reaches the session: the executor has no
        // path to anything but the fixed continuation prompt, so a replay
        // of the original instruction is unrepresentable.
        expect(ops.calls.some((call) => call.startsWith("prompt:") && call !== onlyCall)).toBe(
          false,
        )
        expect(
          ops.calls.some(
            (call) => call.startsWith("prompt:") && call.includes(originalInstruction),
          ),
        ).toBe(false)
      }),
      { numRuns: 200 },
    )
  })
})
