/**
 * Parked-work resume selection (ADP-024): at a safe boundary the parked
 * list is partitioned into fresh routing attempts (oldest parked first),
 * holds (tier unconfigured), and drops (session gone). Includes a store
 * integration: select → resume pops the record for clean continuation.
 */
// covers: ["ADP-022", "ADP-024"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { selectResumable } from "../../../src/execution/parking/plan.js"
import type { ResumeContext } from "../../../src/execution/parking/plan.js"
import { ParkedWorkStore } from "../../../src/state/parked-work/store.js"
import type {
  ParkedPayload,
  ParkedRecord,
  ParkedStorage,
} from "../../../src/state/parked-work/types.js"

class FakeParkedStorage implements ParkedStorage {
  #raw: ParkedPayload | undefined = undefined
  constructor(raw?: ParkedPayload) {
    this.#raw = raw
  }
  read(): Promise<unknown> {
    return Promise.resolve(this.#raw)
  }
  write(payload: ParkedPayload): Promise<void> {
    this.#raw = payload
    return Promise.resolve()
  }
}

function record(id: string, parkedAt: number, overrides: Partial<ParkedRecord> = {}): ParkedRecord {
  return {
    id,
    sessionID: id.split("#")[0] ?? id,
    tier: "standard",
    reason: "all-blocked",
    parkedAt,
    ...overrides,
  }
}

function allAlive(): ResumeContext {
  return { tierConfigured: () => true, sessionAlive: () => true }
}

describe("selectResumable", () => {
  it("returns an empty plan for no parked work", () => {
    expect(selectResumable([], allAlive())).toEqual({ attempt: [], hold: [], drop: [] })
  })

  it("attempts records whose tier is configured and session is alive", () => {
    const records = [record("s#1", 10)]
    const plan = selectResumable(records, allAlive())
    expect(plan.attempt).toEqual(records)
    expect(plan.hold).toEqual([])
    expect(plan.drop).toEqual([])
  })

  it("orders attempts oldest parked first", () => {
    const records = [record("s#3", 30), record("s#1", 10), record("s#2", 20)]
    const plan = selectResumable(records, allAlive())
    expect(plan.attempt.map((r) => r.id)).toEqual(["s#1", "s#2", "s#3"])
  })

  it("keeps insertion order for equal parkedAt", () => {
    const records = [record("a#1", 10), record("a#2", 10), record("a#3", 10)]
    const plan = selectResumable(records, allAlive())
    expect(plan.attempt.map((r) => r.id)).toEqual(["a#1", "a#2", "a#3"])
  })

  it("holds records whose tier is no longer configured", () => {
    const records = [record("s#1", 10, { tier: "advanced" }), record("s#2", 20)]
    const plan = selectResumable(records, {
      tierConfigured: (tier) => tier !== "advanced",
      sessionAlive: () => true,
    })
    expect(plan.attempt.map((r) => r.id)).toEqual(["s#2"])
    expect(plan.hold.map((r) => r.id)).toEqual(["s#1"])
    expect(plan.drop).toEqual([])
  })

  it("drops records whose resume attempts reached the budget (E4 regression: the resume loop is bounded)", () => {
    // A persistently failing rePark used to refresh parkedAt (eviction-immune)
    // and retry forever at every idle boundary. Records at the attempt budget
    // must now be dropped, not retried.
    const exhausted = record("s#1", 10, { attempts: 5 })
    const fresh = record("s#2", 20, { attempts: 4 })
    const plan = selectResumable([exhausted, fresh], allAlive())
    expect(plan.attempt.map((r) => r.id)).toEqual(["s#2"])
    expect(plan.drop.map((r) => r.id)).toEqual(["s#1"])
  })

  it("drops records whose session is gone", () => {
    const records = [record("gone#1", 10), record("alive#1", 20)]
    const plan = selectResumable(records, {
      tierConfigured: () => true,
      sessionAlive: (sessionID) => sessionID === "alive",
    })
    expect(plan.attempt.map((r) => r.id)).toEqual(["alive#1"])
    expect(plan.drop.map((r) => r.id)).toEqual(["gone#1"])
    expect(plan.hold).toEqual([])
  })

  it("drop wins over hold for a dead session on an unconfigured tier", () => {
    const records = [record("gone#1", 10, { tier: "advanced" })]
    const plan = selectResumable(records, {
      tierConfigured: () => false,
      sessionAlive: () => false,
    })
    expect(plan.drop.map((r) => r.id)).toEqual(["gone#1"])
  })

  it("does not mutate the input list", () => {
    const records = [record("s#3", 30), record("s#1", 10)]
    const snapshot = [...records]
    selectResumable(records, allAlive())
    expect(records).toEqual(snapshot)
  })

  it("is deterministic", () => {
    const records = [record("s#3", 30), record("s#1", 10, { tier: "quick" }), record("gone#2", 20)]
    const context = {
      tierConfigured: (tier: ParkedRecord["tier"]) => tier !== "quick",
      sessionAlive: (s: string) => s !== "gone",
    }
    expect(selectResumable(records, context)).toEqual(selectResumable(records, context))
  })
})

describe("selectResumable + ParkedWorkStore integration", () => {
  it("resumes a record selected at the boundary (store pops it for continuation)", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.load()
    await store.park(record("s#1", 10))
    await store.park(record("s#2", 20))
    const plan = selectResumable(store.list(), allAlive())
    expect(plan.attempt.map((r) => r.id)).toEqual(["s#1", "s#2"])
    const resumed = await store.resume("s#1")
    expect(resumed?.id).toBe("s#1")
    expect(store.list().map((r) => r.id)).toEqual(["s#2"])
    expect(store.count()).toBe(1)
  })

  it("leaves the store untouched when routing would re-park the attempt", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.load()
    await store.park(record("s#1", 10))
    const plan = selectResumable(store.list(), allAlive())
    expect(plan.attempt).toHaveLength(1)
    expect(store.count()).toBe(1)
  })
})

describe("selectResumable properties", () => {
  const recordArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }).chain((s) => fc.constant(`${s}#1`)),
    sessionID: fc.string({ minLength: 1, maxLength: 8 }),
    tier: fc.constantFrom("quick", "standard", "advanced"),
    reason: fc.constantFrom(
      "all-blocked",
      "no-candidates",
      "no-compatible-resource",
      "pin-blocked",
    ),
    parkedAt: fc.integer({ min: 0, max: 1_000_000 }),
  }) as fc.Arbitrary<ParkedRecord>

  const contextArb = fc
    .record({
      deadSessions: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
      unconfigured: fc.uniqueArray(fc.constantFrom("quick", "standard", "advanced")),
    })
    .map(({ deadSessions, unconfigured }) => ({
      tierConfigured: (tier: ParkedRecord["tier"]) => !unconfigured.includes(tier),
      sessionAlive: (sessionID: string) => !deadSessions.includes(sessionID),
    }))

  it("partitions every record exactly once, attempts oldest first", () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 40 }), contextArb, (records, context) => {
        const plan = selectResumable(records, context)
        const total = plan.attempt.length + plan.hold.length + plan.drop.length
        expect(total).toBe(records.length)
        const all = [...plan.attempt, ...plan.hold, ...plan.drop]
        expect(new Set(all.map((r) => r.id)).size).toBe(new Set(records.map((r) => r.id)).size)
        const sorted = [...plan.attempt].sort((a, b) => a.parkedAt - b.parkedAt)
        expect(plan.attempt).toEqual(sorted)
        for (const r of plan.hold) expect(context.tierConfigured(r.tier)).toBe(false)
        for (const r of plan.drop) expect(context.sessionAlive(r.sessionID)).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  it("is deterministic and does not mutate input", () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 40 }), contextArb, (records, context) => {
        const snapshot = [...records]
        const first = selectResumable(records, context)
        expect(selectResumable(records, context)).toEqual(first)
        expect(records).toEqual(snapshot)
      }),
      { numRuns: 200 },
    )
  })
})
