// covers: ["ADP-001"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  IGNORED_REASONS,
  MODEL_SOURCES,
  sameModelRef,
  type ApplyResult,
  type ExecutionError,
  type ModelRef,
  type WorkUnitEvent,
} from "@coool/adaptive-core/routing/work-unit/index"
import { WorkUnitTracker } from "../../src/supervisor/tracker.js"

const SID_A = "ses_a"
const SID_B = "ses_b"

const M1: ModelRef = { providerID: "prov", id: "model-1" }
const M2: ModelRef = { providerID: "prov", id: "model-2" }
const M1_HIGH: ModelRef = { providerID: "prov", id: "model-1", variant: "high" }

const ERROR: ExecutionError = {
  type: "ServiceUnavailableError",
  message: "upstream unavailable",
  status: 503,
}

const started = (sessionID: string, at: number): WorkUnitEvent => ({
  kind: "execution-started",
  sessionID,
  at,
})
const succeeded = (sessionID: string, at: number): WorkUnitEvent => ({
  kind: "execution-succeeded",
  sessionID,
  at,
})
const failed = (sessionID: string, at: number, error: ExecutionError = ERROR): WorkUnitEvent => ({
  kind: "execution-failed",
  sessionID,
  at,
  error,
})
const interrupted = (
  sessionID: string,
  at: number,
  reason: "user" | "shutdown" | "superseded" | "inactivity",
): WorkUnitEvent => ({
  kind: "execution-interrupted",
  sessionID,
  at,
  reason,
})
const selected = (sessionID: string, at: number, model: ModelRef): WorkUnitEvent => ({
  kind: "model-selected",
  sessionID,
  at,
  model,
})
const request = (sessionID: string, at: number, model: ModelRef): WorkUnitEvent => ({
  kind: "model-request",
  sessionID,
  at,
  model,
})

describe("IGNORED_REASONS", () => {
  it("exposes the single ignore reason", () => {
    expect([...IGNORED_REASONS]).toEqual(["terminal-without-active-unit"])
  })
})

describe("MODEL_SOURCES", () => {
  it("exposes the attribution vocabulary", () => {
    expect([...MODEL_SOURCES]).toEqual(["selected-adaptive", "selected-external", "request"])
  })
})

describe("sameModelRef", () => {
  it("distinguishes by provider, id, and variant", () => {
    expect(sameModelRef(M1, M1)).toBe(true)
    expect(sameModelRef(M1, M2)).toBe(false)
    expect(sameModelRef(M1, M1_HIGH)).toBe(false)
    expect(sameModelRef(M1_HIGH, { providerID: "prov", id: "model-1", variant: "high" })).toBe(true)
    expect(sameModelRef(M1_HIGH, { providerID: "other", id: "model-1", variant: "high" })).toBe(
      false,
    )
  })
})

describe("WorkUnitTracker", () => {
  it("opens the first episode for a session", () => {
    const tracker = new WorkUnitTracker()
    const result = tracker.apply(started(SID_A, 100))
    expect(result).toEqual({
      kind: "opened",
      unit: {
        kind: "active",
        id: `${SID_A}#1`,
        sessionID: SID_A,
        episode: 1,
        startedAt: 100,
        transitions: [],
      },
    })
    expect(tracker.active(SID_A)?.id).toBe(`${SID_A}#1`)
    expect(tracker.lastModel(SID_A)).toBeUndefined()
  })

  it("seedEpisodes raises the per-session floor so ids are never reused after restart (C2)", () => {
    const tracker = new WorkUnitTracker()
    tracker.seedEpisodes(new Map([[SID_A, 3]]))
    const result = tracker.apply(started(SID_A, 100))
    expect(result.kind === "opened" && result.unit.id).toBe(`${SID_A}#4`)
    // A session without a seed starts at 1 as before.
    const other = tracker.apply(started(SID_B, 100))
    expect(other.kind === "opened" && other.unit.id).toBe(`${SID_B}#1`)
    // Seeding never lowers an existing counter.
    tracker.seedEpisodes(new Map([[SID_A, 1]]))
    const next = tracker.apply(started(SID_A, 200))
    expect(next.kind === "opened" && next.unit.id).toBe(`${SID_A}#5`)
  })

  it("keeps a tool continuation inside the same unit", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    const first = tracker.apply(selected(SID_A, 110, M1))
    const second = tracker.apply(request(SID_A, 120, M1))
    expect(first.kind).toBe("model-tracked")
    expect(second.kind).toBe("model-tracked")
    const unit = tracker.active(SID_A)
    expect(unit?.id).toBe(`${SID_A}#1`)
    expect(unit?.episode).toBe(1)
    expect(unit?.model).toEqual(M1)
    expect(unit?.transitions).toEqual([
      { at: 110, model: M1, source: "selected-external" },
      { at: 120, model: M1, source: "request" },
    ])
  })

  it("closes a unit as succeeded", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    const result = tracker.apply(succeeded(SID_A, 150))
    expect(result).toEqual({
      kind: "closed",
      unit: {
        kind: "succeeded",
        id: `${SID_A}#1`,
        sessionID: SID_A,
        episode: 1,
        startedAt: 100,
        closedAt: 150,
        transitions: [],
      },
    })
    expect(tracker.active(SID_A)).toBeUndefined()
  })

  it("closes a unit as failed and carries the error", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    const result = tracker.apply(failed(SID_A, 150))
    expect(result.kind).toBe("closed")
    if (result.kind !== "closed" || result.unit.kind !== "failed")
      throw new Error("expected failed closure")
    expect(result.unit.error).toEqual(ERROR)
    expect(result.unit.closedAt).toBe(150)
  })

  it("closes a unit as interrupted with the reason", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    const result = tracker.apply(interrupted(SID_A, 150, "user"))
    expect(result.kind).toBe("closed")
    if (result.kind !== "closed" || result.unit.kind !== "interrupted")
      throw new Error("expected interruption closure")
    expect(result.unit.reason).toBe("user")
  })

  it("ignores terminal events without an active unit", () => {
    const tracker = new WorkUnitTracker()
    for (const event of [
      succeeded(SID_A, 10),
      failed(SID_A, 11),
      interrupted(SID_A, 12, "shutdown"),
    ]) {
      expect(tracker.apply(event)).toEqual({
        kind: "ignored",
        reason: "terminal-without-active-unit",
      })
    }
  })

  it("ignores a duplicate terminal after the unit already closed", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    expect(tracker.apply(succeeded(SID_A, 150)).kind).toBe("closed")
    expect(tracker.apply(failed(SID_A, 160))).toEqual({
      kind: "ignored",
      reason: "terminal-without-active-unit",
    })
  })

  it("opens a new episode for a later goal continuation on the same session", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    tracker.apply(selected(SID_A, 110, M2))
    tracker.apply(succeeded(SID_A, 150))
    const result = tracker.apply(started(SID_A, 200))
    expect(result.kind).toBe("opened")
    if (result.kind !== "opened") throw new Error("expected opened")
    expect(result.unit.id).toBe(`${SID_A}#2`)
    expect(result.unit.episode).toBe(2)
    expect(result.unit.model).toEqual(M2)
    expect(result.unit.transitions).toEqual([])
    expect(result.superseded).toBeUndefined()
  })

  it("tracks subagent sessions independently, without cross-session model leaks", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    tracker.apply(selected(SID_A, 105, M1))
    tracker.apply(started(SID_B, 110))
    tracker.apply(succeeded(SID_A, 120))
    tracker.apply(started(SID_A, 130))
    tracker.apply(succeeded(SID_B, 140))
    tracker.apply(started(SID_B, 150))

    expect(tracker.active(SID_A)?.id).toBe(`${SID_A}#2`)
    expect(tracker.active(SID_A)?.model).toEqual(M1)
    expect(tracker.active(SID_B)?.id).toBe(`${SID_B}#2`)
    expect(tracker.active(SID_B)?.model).toBeUndefined()
    expect(tracker.lastModel(SID_B)).toBeUndefined()
  })

  it("closes a still-active unit as superseded when a new execution starts", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    tracker.apply(selected(SID_A, 110, M1))
    const result = tracker.apply(started(SID_A, 200))
    expect(result.kind).toBe("opened")
    if (result.kind !== "opened" || result.superseded === undefined)
      throw new Error("expected superseded closure")
    expect(result.superseded).toEqual({
      kind: "interrupted",
      id: `${SID_A}#1`,
      sessionID: SID_A,
      episode: 1,
      startedAt: 100,
      closedAt: 200,
      reason: "superseded",
      model: M1,
      transitions: [{ at: 110, model: M1, source: "selected-external" }],
    })
    expect(result.unit.id).toBe(`${SID_A}#2`)
  })

  it("notes model selections with no active unit and seeds the next admission", () => {
    const tracker = new WorkUnitTracker()
    const result = tracker.apply(selected(SID_A, 50, M1))
    expect(result).toEqual({
      kind: "model-noted",
      transition: { at: 50, model: M1, source: "selected-external" },
    })
    expect(tracker.lastModel(SID_A)).toEqual({ at: 50, model: M1, source: "selected-external" })
    tracker.apply(started(SID_A, 60))
    expect(tracker.active(SID_A)?.model).toEqual(M1)
  })

  it("attributes a matching pending own switch as adaptive and consumes the note", () => {
    const tracker = new WorkUnitTracker()
    tracker.noteOwnSwitch(SID_A, M1_HIGH)
    tracker.apply(started(SID_A, 100))
    const result = tracker.apply(selected(SID_A, 110, M1_HIGH))
    expect(result.kind).toBe("model-tracked")
    if (result.kind !== "model-tracked") throw new Error("expected tracked")
    expect(result.transition.source).toBe("selected-adaptive")
    const after = tracker.apply(selected(SID_A, 120, M1_HIGH))
    if (after.kind !== "model-tracked") throw new Error("expected tracked")
    expect(after.transition.source).toBe("selected-external")
  })

  it("clears a stale pending note on a non-matching selection so user picks are never claimed", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 50))
    tracker.noteOwnSwitch(SID_A, M1)
    const other = tracker.apply(selected(SID_A, 100, M2))
    if (other.kind !== "model-tracked") throw new Error("expected tracked")
    expect(other.transition.source).toBe("selected-external")
    const late = tracker.apply(selected(SID_A, 110, M1))
    if (late.kind !== "model-tracked") throw new Error("expected tracked")
    expect(late.transition.source).toBe("selected-external")
  })

  it("replaces an unconsumed pending note with a newer one", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 50))
    tracker.noteOwnSwitch(SID_A, M1)
    tracker.noteOwnSwitch(SID_A, M2)
    const event = tracker.apply(selected(SID_A, 100, M2))
    if (event.kind !== "model-tracked") throw new Error("expected tracked")
    expect(event.transition.source).toBe("selected-adaptive")
    const stale = tracker.apply(selected(SID_A, 110, M1))
    if (stale.kind !== "model-tracked") throw new Error("expected tracked")
    expect(stale.transition.source).toBe("selected-external")
  })

  it("does not let request observations consume the pending note", () => {
    const tracker = new WorkUnitTracker()
    tracker.noteOwnSwitch(SID_A, M1)
    tracker.apply(started(SID_A, 100))
    tracker.apply(request(SID_A, 110, M2))
    const result = tracker.apply(selected(SID_A, 120, M1))
    if (result.kind !== "model-tracked") throw new Error("expected tracked")
    expect(result.transition.source).toBe("selected-adaptive")
  })

  it("records a re-selection of the same model as a transition", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    tracker.apply(selected(SID_A, 110, M1))
    const result = tracker.apply(selected(SID_A, 120, M1))
    if (result.kind !== "model-tracked") throw new Error("expected tracked")
    expect(result.unit.transitions).toHaveLength(2)
    expect(result.unit.model).toEqual(M1)
  })

  it("records a variant change on the same model as a new reference", () => {
    const tracker = new WorkUnitTracker()
    tracker.apply(started(SID_A, 100))
    const result = tracker.apply(selected(SID_A, 110, M1_HIGH))
    if (result.kind !== "model-tracked") throw new Error("expected tracked")
    expect(result.unit.model).toEqual(M1_HIGH)
    const model = result.unit.model
    expect(model !== undefined && sameModelRef(model, M1)).toBe(false)
  })

  it("never mutates previously returned units", () => {
    const tracker = new WorkUnitTracker()
    const opened = tracker.apply(started(SID_A, 100))
    const firstSnapshot = structuredClone(opened)
    tracker.apply(selected(SID_A, 110, M1))
    tracker.apply(succeeded(SID_A, 150))
    expect(opened).toEqual(firstSnapshot)
  })
})

describe("WorkUnitTracker properties", () => {
  const sessionIDs = [SID_A, SID_B, "ses_c"]
  const modelArb: fc.Arbitrary<ModelRef> = fc.record({
    providerID: fc.constantFrom("prov", "other"),
    id: fc.constantFrom("model-1", "model-2", "model-3"),
    variant: fc.option(fc.constantFrom("low", "high"), { nil: undefined }),
  })
  const errorArb: fc.Arbitrary<ExecutionError> = fc.record({
    type: fc.constantFrom("UnknownError", "ServiceUnavailableError", "ProviderRequestError"),
    message: fc.string({ maxLength: 40 }),
    status: fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined }),
    retryAfterMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: undefined }),
  })
  const atArb = fc.integer({ min: 0, max: 1_000_000_000 })
  const eventArb: fc.Arbitrary<WorkUnitEvent> = fc.oneof(
    fc.record({
      kind: fc.constant("execution-started" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
    }),
    fc.record({
      kind: fc.constant("execution-succeeded" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
    }),
    fc.record({
      kind: fc.constant("execution-failed" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
      error: errorArb,
    }),
    fc.record({
      kind: fc.constant("execution-interrupted" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
      reason: fc.constantFrom(
        "user" as const,
        "shutdown" as const,
        "superseded" as const,
        "inactivity" as const,
      ),
    }),
    fc.record({
      kind: fc.constant("model-selected" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
      model: modelArb,
    }),
    fc.record({
      kind: fc.constant("model-request" as const),
      sessionID: fc.constantFrom(...sessionIDs),
      at: atArb,
      model: modelArb,
    }),
  )

  it("maintains the episode-machine invariants over arbitrary event sequences", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const tracker = new WorkUnitTracker()
        const oracleActive = new Set<string>()
        const oracleEpisodes = new Map<string, number>()
        const oracleModelEventsSinceStart = new Map<string, number>()

        for (const event of events) {
          const result: ApplyResult = tracker.apply(event)
          const sessionID = event.sessionID
          switch (event.kind) {
            case "execution-started": {
              expect(result.kind).toBe("opened")
              if (result.kind !== "opened") return
              if (oracleActive.has(sessionID)) {
                expect(result.superseded).toBeDefined()
                expect(result.superseded?.kind).toBe("interrupted")
                const superseded = result.superseded
                if (superseded?.kind === "interrupted") expect(superseded.reason).toBe("superseded")
                oracleActive.delete(sessionID)
              } else {
                expect(result.superseded).toBeUndefined()
              }
              oracleActive.add(sessionID)
              const episode = (oracleEpisodes.get(sessionID) ?? 0) + 1
              oracleEpisodes.set(sessionID, episode)
              oracleModelEventsSinceStart.set(sessionID, 0)
              expect(result.unit.episode).toBe(episode)
              expect(result.unit.id).toBe(`${sessionID}#${String(episode)}`)
              expect(tracker.active(sessionID)?.id).toBe(result.unit.id)
              break
            }
            case "execution-succeeded":
            case "execution-failed":
            case "execution-interrupted": {
              if (oracleActive.has(sessionID)) {
                expect(result.kind).toBe("closed")
                if (result.kind !== "closed") return
                const expectedKind = {
                  "execution-succeeded": "succeeded",
                  "execution-failed": "failed",
                  "execution-interrupted": "interrupted",
                }[event.kind]
                expect(result.unit.kind).toBe(expectedKind)
                oracleActive.delete(sessionID)
              } else {
                expect(result).toEqual({ kind: "ignored", reason: "terminal-without-active-unit" })
              }
              expect(tracker.active(sessionID)).toBeUndefined()
              break
            }
            case "model-selected":
            case "model-request": {
              if (oracleActive.has(sessionID)) {
                expect(result.kind).toBe("model-tracked")
                if (result.kind !== "model-tracked") return
                const count = (oracleModelEventsSinceStart.get(sessionID) ?? 0) + 1
                oracleModelEventsSinceStart.set(sessionID, count)
                expect(result.unit.transitions).toHaveLength(count)
                expect(result.unit.transitions[count - 1]).toEqual(result.transition)
                // No noteOwnSwitch calls in this property, so nothing may be
                // attributed to Adaptive.
                expect(result.transition.source).not.toBe("selected-adaptive")
              } else {
                expect(result.kind).toBe("model-noted")
              }
              break
            }
          }
        }
      }),
    )
  })

  it("is deterministic: the same sequence produces identical results and state", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        const first = new WorkUnitTracker()
        const second = new WorkUnitTracker()
        const firstResults: ApplyResult[] = events.map((event) => first.apply(event))
        const secondResults: ApplyResult[] = events.map((event) => second.apply(event))
        expect(secondResults).toEqual(firstResults)
        for (const sessionID of sessionIDs) {
          expect(second.active(sessionID)).toEqual(first.active(sessionID))
          expect(second.lastModel(sessionID)).toEqual(first.lastModel(sessionID))
        }
      }),
    )
  })

  // covers: ["ADP-037"]
  describe("bounded per-session maps (long-lived host)", () => {
    it("evicts the oldest last-model past the cap instead of growing forever", () => {
      const tracker = new WorkUnitTracker()
      for (let index = 0; index < WorkUnitTracker.MAX_TRACKED_SESSIONS; index += 1) {
        tracker.apply({
          kind: "model-request",
          sessionID: `s${String(index)}`,
          at: index,
          model: M1,
        })
      }
      expect(tracker.lastModel("s0")).toBeDefined()
      // One more session pushes the oldest (s0) out; the newest still rides.
      tracker.apply({ kind: "model-request", sessionID: "s-new", at: 1, model: M1 })
      expect(tracker.lastModel("s0")).toBeUndefined()
      expect(tracker.lastModel("s-new")).toBeDefined()
      expect(
        tracker.lastModel(`s${String(WorkUnitTracker.MAX_TRACKED_SESSIONS - 1)}`),
      ).toBeDefined()
    })

    it("evicts the oldest pending own-switch note past the cap (safe direction: looks external)", () => {
      const tracker = new WorkUnitTracker()
      for (let index = 0; index < WorkUnitTracker.MAX_TRACKED_SESSIONS; index += 1) {
        tracker.noteOwnSwitch(`s${String(index)}`, M1)
      }
      tracker.noteOwnSwitch("s-new", M1)
      // The evicted note can no longer claim its selection event: the switch
      // is attributed external (manual) — never the reverse (ADP-028).
      expect(tracker.apply({ kind: "model-selected", sessionID: "s0", at: 1, model: M1 })).toEqual({
        kind: "model-noted",
        transition: { at: 1, model: M1, source: "selected-external" },
      })
    })

    it("keeps last models of sessions tracked after an eviction wave", () => {
      const tracker = new WorkUnitTracker()
      for (let index = 0; index < WorkUnitTracker.MAX_TRACKED_SESSIONS + 1; index += 1) {
        tracker.apply({
          kind: "model-request",
          sessionID: `s${String(index)}`,
          at: index,
          model: M1,
        })
      }
      expect(tracker.lastModel(`s${String(WorkUnitTracker.MAX_TRACKED_SESSIONS)}`)).toMatchObject({
        model: M1,
      })
    })
  })
})
