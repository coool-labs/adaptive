// covers: ["ADP-014", "ADP-023"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { executeContinuation } from "../../../src/execution/continuation/execute.js"
import {
  CONTINUATION_ACTIONS,
  PROMPT_STRATEGIES,
  promptStrategy,
} from "../../../src/execution/continuation/types.js"
import type {
  ContinuationAction,
  ContinuationExecuteInput,
  ContinuationOps,
} from "../../../src/execution/continuation/types.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"

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

const CONTINUATION = "continue where you left off"
const ORIGINAL = "refactor the parser"

function baseInput(overrides?: Partial<ContinuationExecuteInput>): ContinuationExecuteInput {
  return {
    sessionID: "s1",
    action: { kind: "clean-continuation" },
    sideEffects: true,
    prompts: { continuation: CONTINUATION, original: ORIGINAL },
    ops: new FakeOps(),
    ...overrides,
  }
}

describe("continuation vocabulary", () => {
  it("pins the prompt strategies", () => {
    expect(PROMPT_STRATEGIES).toEqual(["continue-from-state", "re-dispatch"])
  })

  it("pins the continuation actions", () => {
    expect(CONTINUATION_ACTIONS).toEqual(["allow-native", "in-session", "clean-continuation"])
  })

  it("maps side effects to the prompt strategy", () => {
    expect(promptStrategy(true)).toBe("continue-from-state")
    expect(promptStrategy(false)).toBe("re-dispatch")
  })
})

describe("executeContinuation", () => {
  it("performs no host operations for allow-native", async () => {
    const ops = new FakeOps()
    const input = baseInput({ action: { kind: "allow-native" }, ops })
    await expect(executeContinuation(input)).resolves.toEqual({ kind: "left-native" })
    expect(ops.calls).toEqual([])
  })

  it("settles, switches, then resumes the in-session path", async () => {
    const ops = new FakeOps()
    const action: ContinuationAction = { kind: "in-session", model: { providerID: "p", id: "m" } }
    await expect(executeContinuation(baseInput({ action, ops }))).resolves.toEqual({
      kind: "resumed",
    })
    expect(ops.calls).toEqual([`settle:s1`, `switch:s1:p/m`, `prompt:s1:${CONTINUATION}`])
  })

  it("skips the switch when the plan carries none (clean continuation)", async () => {
    const ops = new FakeOps()
    await expect(executeContinuation(baseInput({ ops }))).resolves.toEqual({
      kind: "continuation-started",
    })
    expect(ops.calls).toEqual([`settle:s1`, `prompt:s1:${CONTINUATION}`])
  })

  it("sends the continuation prompt when side effects exist", async () => {
    const ops = new FakeOps()
    await executeContinuation(baseInput({ ops, sideEffects: true }))
    expect(ops.calls.some((call) => call.includes(ORIGINAL))).toBe(false)
    expect(ops.calls.some((call) => call.includes(CONTINUATION))).toBe(true)
  })

  it("re-dispatches the original instruction only without side effects", async () => {
    const ops = new FakeOps()
    await executeContinuation(baseInput({ ops, sideEffects: false }))
    expect(ops.calls.some((call) => call.includes(CONTINUATION))).toBe(false)
    expect(ops.calls.some((call) => call.includes(ORIGINAL))).toBe(true)
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
    expect(ops.calls).toEqual([`settle:s1`, `prompt:s1:${CONTINUATION}`])
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

  it("enforces settle-first ordering and the never-replay prompt choice", async () => {
    await fc.assert(
      fc.asyncProperty(
        actionArb,
        fc.boolean(),
        fc.string({ minLength: 1 }),
        async (action, sideEffects, tag) => {
          const ops = new FakeOps()
          const prompts = { continuation: `cont-${tag}`, original: `orig-${tag}` }
          const outcome = await executeContinuation({
            sessionID: "sX",
            action,
            sideEffects,
            prompts,
            ops,
          })
          const promptCalls = ops.calls.filter((call) => call.startsWith("prompt:"))
          if (action.kind === "allow-native") {
            expect(outcome).toEqual({ kind: "left-native" })
            expect(ops.calls).toEqual([])
            return
          }
          expect(ops.calls[0]).toBe("settle:sX")
          const expectedText = sideEffects ? prompts.continuation : prompts.original
          const forbiddenText = sideEffects ? prompts.original : prompts.continuation
          expect(promptCalls).toEqual([`prompt:sX:${expectedText}`])
          expect(promptCalls.some((call) => call.includes(forbiddenText))).toBe(false)
          if (action.kind === "in-session") {
            expect(ops.calls).toEqual([
              `settle:sX`,
              `switch:sX:${action.model.providerID}/${action.model.id}`,
              `prompt:sX:${expectedText}`,
            ])
            expect(outcome).toEqual({ kind: "resumed" })
          } else {
            expect(outcome).toEqual({ kind: "continuation-started" })
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("never sends the original instruction once side effects exist", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        fc.string({ minLength: 1 }),
        async (probeId, tag) => {
          const ops = new FakeOps()
          const model = { providerID: "p", id: "m" }
          const action: ContinuationAction =
            probeId === undefined
              ? { kind: "in-session", model }
              : { kind: "in-session", model, probeId }
          await executeContinuation({
            sessionID: "s1",
            action,
            sideEffects: true,
            prompts: { continuation: `cont-${tag}`, original: `orig-${tag}` },
            ops,
          })
          expect(
            ops.calls.some((call) => call.startsWith("prompt:") && call.includes(`orig-`)),
          ).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })
})
