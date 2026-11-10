/**
 * Parked records must keep their identity across the persistence round trip
 * (ADP-024): whatever the store accepts is exactly what comes back, and
 * whatever would not survive is rejected up front so the wiring layer can fail
 * open instead of silently orphaning waiting work.
 */
// covers: ["ADP-011", "ADP-024", "ADP-031"]
import { describe, expect, it } from "vitest"

import { MAX_PARKED_TEXT } from "../../../src/state/parked-work/index.js"
import {
  ParkedWorkStore,
  type ParkedPayload,
  type ParkedRecord,
  type ParkedStorage,
} from "../../../src/state/parked-work/index.js"

class MemoryStorage implements ParkedStorage {
  raw: unknown
  writes = 0

  read(): Promise<unknown> {
    return Promise.resolve(
      this.raw === undefined ? undefined : JSON.parse(JSON.stringify(this.raw)),
    )
  }

  write(payload: ParkedPayload): Promise<void> {
    this.writes += 1
    this.raw = payload
    return Promise.resolve()
  }
}

function record(overrides: Partial<ParkedRecord> = {}): ParkedRecord {
  return {
    id: "s#1",
    sessionID: "s",
    tier: "standard",
    reason: "all-blocked",
    parkedAt: 1,
    ...overrides,
  }
}

describe("parked identity round trip", () => {
  it("resumes a record whose identifiers sit exactly at the bound", async () => {
    const storage = new MemoryStorage()
    const store = new ParkedWorkStore(storage)
    const id = "i".repeat(MAX_PARKED_TEXT)
    const sessionID = "s".repeat(MAX_PARKED_TEXT)
    await store.park(record({ id, sessionID }))
    const restarted = new ParkedWorkStore(storage)
    await restarted.load()
    expect(restarted.list().map((entry) => [entry.id, entry.sessionID])).toEqual([[id, sessionID]])
    expect(await restarted.resume(id)).toMatchObject({ id, sessionID })
  })

  it.each([
    ["an empty id", { id: "" }, "id"],
    ["an empty sessionID", { sessionID: "" }, "sessionID"],
    ["an over-long id", { id: "x".repeat(MAX_PARKED_TEXT + 1) }, "id"],
    ["an over-long sessionID", { sessionID: "x".repeat(MAX_PARKED_TEXT + 1) }, "sessionID"],
  ])(
    "rejects %s instead of persisting a record that cannot be resumed",
    async (_name, overrides, field) => {
      const storage = new MemoryStorage()
      const store = new ParkedWorkStore(storage)
      await expect(store.park(record(overrides))).rejects.toThrow(field)
      expect(storage.writes).toBe(0)
      expect(store.list()).toEqual([])
    },
  )

  it.each([
    ["a negative parkedAt", { parkedAt: -1 }, "parkedAt"],
    ["a NaN parkedAt", { parkedAt: Number.NaN }, "parkedAt"],
    ["an infinite parkedAt", { parkedAt: Number.POSITIVE_INFINITY }, "parkedAt"],
    ["a fractional attempts count", { attempts: 1.5 }, "attempts"],
    ["a negative attempts count", { attempts: -1 }, "attempts"],
    ["a NaN attempts count", { attempts: Number.NaN }, "attempts"],
  ])(
    "rejects %s (it would reset or lose the record on reload)",
    async (_name, overrides, field) => {
      const storage = new MemoryStorage()
      const store = new ParkedWorkStore(storage)
      await expect(store.park(record(overrides))).rejects.toThrow(field)
      expect(storage.writes).toBe(0)
    },
  )

  it("keeps a rejected park from poisoning the next queued park", async () => {
    const store = new ParkedWorkStore(new MemoryStorage())
    const bad = store.park(record({ id: "" }))
    const good = store.park(record({ id: "ok#1" }))
    await expect(bad).rejects.toThrow("id")
    await expect(good).resolves.toBeUndefined()
    expect(store.list().map((entry) => entry.id)).toEqual(["ok#1"])
  })

  it("accepts the boundary values 0 attempts and parkedAt 0", async () => {
    const store = new ParkedWorkStore(new MemoryStorage())
    await store.park(record({ attempts: 0, parkedAt: 0 }))
    expect(store.list()[0]).toMatchObject({ attempts: 0, parkedAt: 0 })
  })
})
