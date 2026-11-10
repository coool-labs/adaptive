/**
 * Parked-work module tests (ADP-024): durable park/resume records keyed by
 * unit id, bounded retention with oldest-eviction, restart round-trips, and
 * total read-side parsing (ADP-031 discipline for state).
 */
// covers: ["ADP-024"]
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { PARK_REASONS } from "../../../src/routing/scheduler/types.js"
import { TIERS } from "../../../src/routing/tier-policy/types.js"
import {
  MAX_PARKED,
  MAX_PARKED_TEXT,
  PARKED_KEY,
  PARKED_VERSION,
  ParkedWorkStore,
  parseParkedPayload,
} from "../../../src/state/parked-work/index.js"
import type {
  ParkedPayload,
  ParkedRecord,
  ParkedStorage,
} from "../../../src/state/parked-work/index.js"

class FakeParkedStorage implements ParkedStorage {
  #raw: unknown = undefined
  #failRead = false
  #failWrite = false
  writes = 0
  lastPayload: ParkedPayload | undefined

  constructor(raw?: unknown) {
    this.#raw = raw
  }

  failRead(): void {
    this.#failRead = true
  }

  failWrite(): void {
    this.#failWrite = true
  }

  read(): Promise<unknown> {
    if (this.#failRead) return Promise.reject(new Error("storage read failed"))
    return Promise.resolve(this.#raw)
  }

  write(payload: ParkedPayload): Promise<void> {
    this.writes += 1
    this.lastPayload = payload
    if (this.#failWrite) return Promise.reject(new Error("storage write failed"))
    this.#raw = payload
    return Promise.resolve()
  }
}

function record(overrides: Partial<ParkedRecord> = {}): ParkedRecord {
  return {
    id: "s#1",
    sessionID: "s",
    tier: "standard",
    reason: "all-blocked",
    detail: "rate-limited,breaker-open",
    parkedAt: 1_000,
    ...overrides,
  }
}

const longText = "x".repeat(MAX_PARKED_TEXT + 50)

test("accepts nonnegative whole wake counts and drops invalid persisted counts", () => {
  for (const attempts of [undefined, "1", -1, 0.5, Infinity]) {
    const parsed = parseParkedPayload([record({ attempts: 1 }), { ...record(), attempts }])
    expect(parsed[0]?.attempts).toBe(1)
    expect(parsed[1]).not.toHaveProperty("attempts")
  }
  expect(parseParkedPayload([{ ...record(), attempts: 0 }])[0]?.attempts).toBe(0)
})

describe("parked constants", () => {
  test("pinned product constants", () => {
    expect(PARKED_KEY).toBe("coool.adaptive/parked")
    expect(PARKED_VERSION).toBe(1)
    expect(MAX_PARKED).toBe(64)
    expect(MAX_PARKED_TEXT).toBe(128)
  })
})

describe("parseParkedPayload", () => {
  test("round-trips a versioned payload and versionless drafts", () => {
    const valid = record()
    expect(parseParkedPayload({ version: 1, parked: [valid] })).toEqual([valid])
    expect(parseParkedPayload([valid])).toEqual([valid])
  })

  test("rejects other versions, non-payloads, and non-array lists", () => {
    expect(parseParkedPayload({ version: 2, parked: [] })).toEqual([])
    expect(parseParkedPayload({ version: "1", parked: [] })).toEqual([])
    expect(parseParkedPayload({ version: 1, parked: "nope" })).toEqual([])
    expect(parseParkedPayload("junk")).toEqual([])
    expect(parseParkedPayload(null)).toEqual([])
    expect(parseParkedPayload(undefined)).toEqual([])
  })

  test("drops invalid records", () => {
    const broken: unknown[] = [
      { ...record(), id: "" },
      { ...record(), id: undefined },
      { ...record(), sessionID: "" },
      { ...record(), tier: "massive" },
      { ...record(), tier: undefined },
      { ...record(), reason: "because" },
      { ...record(), parkedAt: -1 },
      { ...record(), parkedAt: Number.NaN },
      { ...record(), parkedAt: "1000" },
      null,
      7,
    ]
    expect(parseParkedPayload({ version: 1, parked: broken })).toEqual([])
  })

  test("drops records with an invalid optional detail but keeps the rest", () => {
    const parsed = parseParkedPayload([{ ...record(), detail: 42 }])
    expect(parsed).toEqual([{ ...record(), detail: undefined }])
  })

  test("re-bounds over-long detail on read", () => {
    const parsed = parseParkedPayload([{ ...record(), detail: longText }])
    expect(parsed[0]?.detail).toBe("x".repeat(MAX_PARKED_TEXT))
  })

  test("keeps the newest records at the cap", () => {
    const many = Array.from({ length: MAX_PARKED + 5 }, (_, index) =>
      record({ id: `s#${String(index)}`, parkedAt: index }),
    )
    const parsed = parseParkedPayload({ version: 1, parked: many })
    expect(parsed).toHaveLength(MAX_PARKED)
    expect(parsed[0]?.id).toBe("s#5")
    expect(parsed[MAX_PARKED - 1]?.id).toBe(`s#${String(MAX_PARKED + 4)}`)
  })
})

describe("ParkedWorkStore", () => {
  test("parks records and lists them in insertion order", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record())
    await store.park(record({ id: "s#2", parkedAt: 2_000 }))
    expect(store.list().map((entry) => entry.id)).toEqual(["s#1", "s#2"])
    expect(store.count()).toBe(2)
    expect(storage.writes).toBe(2)
  })

  test("parks the same unit again with latest-wins replacement", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record({ reason: "all-blocked", parkedAt: 1_000 }))
    await store.park(
      record({ reason: "no-compatible-resource", detail: undefined, parkedAt: 2_000 }),
    )
    expect(store.count()).toBe(1)
    expect(store.list()[0]?.reason).toBe("no-compatible-resource")
    expect(store.list()[0]?.parkedAt).toBe(2_000)
  })

  test("bounds the persisted detail", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record({ detail: longText }))
    expect(storage.lastPayload?.parked[0]?.detail).toBe("x".repeat(MAX_PARKED_TEXT))
  })

  test("resume removes, returns, and persists", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record())
    await store.park(record({ id: "s#2" }))
    const resumed = await store.resume("s#1")
    expect(resumed).toEqual(record())
    expect(store.list().map((entry) => entry.id)).toEqual(["s#2"])
    expect(storage.writes).toBe(3)
  })

  test("resume of an unknown id returns undefined and does not write", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record())
    const writesBefore = storage.writes
    const resumed = await store.resume("missing")
    expect(resumed).toBeUndefined()
    expect(storage.writes).toBe(writesBefore)
  })

  test("evicts the oldest parkedAt beyond the cap", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    // Parked out of chronological order; eviction is by parkedAt, not position.
    for (let index = 0; index < MAX_PARKED; index += 1) {
      await store.park(record({ id: `s#${String(index)}`, parkedAt: MAX_PARKED - index }))
    }
    await store.park(record({ id: "s#new", parkedAt: 10_000 }))
    const list = store.list()
    expect(list).toHaveLength(MAX_PARKED)
    expect(list.map((entry) => entry.id)).not.toContain("s#63")
    expect(list.map((entry) => entry.id)).toContain("s#new")
    const oldest = Math.min(...list.map((entry) => entry.parkedAt))
    expect(oldest).toBe(2)
  })

  test("replacement does not change the record count under the cap", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    for (let index = 0; index < MAX_PARKED; index += 1) {
      await store.park(record({ id: `s#${String(index)}`, parkedAt: index }))
    }
    await store.park(record({ id: "s#0", parkedAt: 5_000 }))
    expect(store.count()).toBe(MAX_PARKED)
    expect(store.list()[MAX_PARKED - 1]?.id).toBe("s#0")
    expect(store.list()[MAX_PARKED - 1]?.parkedAt).toBe(5_000)
  })

  test("load round-trips records across restart", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record())
    await store.park(record({ id: "s#2", tier: "advanced", reason: "pin-blocked" }))
    const restarted = new ParkedWorkStore(storage)
    await restarted.load()
    expect(restarted.list()).toEqual(store.list())
  })

  test("load degrades to empty on read failure or garbage", async () => {
    const failing = new FakeParkedStorage()
    failing.failRead()
    const store = new ParkedWorkStore(failing)
    await store.load()
    expect(store.list()).toEqual([])
    const garbage = new ParkedWorkStore(new FakeParkedStorage({ nope: true }))
    await garbage.load()
    expect(garbage.list()).toEqual([])
  })

  test("park write failure propagates and memory stays unchanged", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    storage.failWrite()
    const pending = store.park(record())
    await expect(pending).rejects.toThrow("storage write failed")
    expect(store.count()).toBe(0)
  })

  test("resume write failure propagates and the record stays parked", async () => {
    const storage = new FakeParkedStorage()
    const store = new ParkedWorkStore(storage)
    await store.park(record())
    storage.failWrite()
    const pending = store.resume("s#1")
    await expect(pending).rejects.toThrow("storage write failed")
    expect(store.count()).toBe(1)
    expect(store.list()[0]?.id).toBe("s#1")
  })
})

describe("parked properties", () => {
  test("parse is total over arbitrary values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const parsed = parseParkedPayload(raw)
        expect(Array.isArray(parsed)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  test("parking stays bounded, id-unique, and round-trips through storage", async () => {
    const reasonArb = fc.constantFrom(...PARK_REASONS)
    const tierArb = fc.constantFrom(...TIERS)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.nat({ max: 20 }),
            reason: reasonArb,
            tier: tierArb,
            parkedAt: fc.nat({ max: 2 ** 40 }),
            detail: fc.option(fc.string({ maxLength: 300 }), { nil: undefined }),
          }),
          { maxLength: 40 },
        ),
        async (parks) => {
          const storage = new FakeParkedStorage()
          const store = new ParkedWorkStore(storage)
          for (const park of parks) {
            await store.park(
              record({
                id: `s#${String(park.id)}`,
                reason: park.reason,
                tier: park.tier,
                parkedAt: park.parkedAt,
                ...(park.detail !== undefined ? { detail: park.detail } : {}),
              }),
            )
          }
          const list = store.list()
          expect(list.length).toBeLessThanOrEqual(MAX_PARKED)
          const ids = new Set(list.map((entry) => entry.id))
          expect(ids.size).toBe(list.length)
          const parsed = parseParkedPayload(storage.lastPayload)
          expect(parsed).toEqual(list)
        },
      ),
      { numRuns: 100 },
    )
  })
})
