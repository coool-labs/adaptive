/**
 * Tier-request store tests (ADP-055): round-trip, get/set/remove,
 * defensiveness against corrupted payloads, the record cap, and the
 * persist-before-commit rule — asserted through the storage seam, mirroring
 * the session-mode store tests (ADP-054).
 */
// covers: ["ADP-055"]
import { describe, expect, it } from "vitest"

import {
  parseTierRequestsPayload,
  TierRequestStore,
} from "../../../src/state/tier-requests/index.js"
import {
  MAX_TIER_REQUEST_RECORDS,
  TIER_REQUESTS_KEY,
  TIER_REQUESTS_VERSION,
} from "../../../src/state/tier-requests/types.js"
import type {
  TierRequestRecord,
  TierRequestsPayload,
  TierRequestsStorage,
} from "../../../src/state/tier-requests/types.js"

class FakeTierRequestsStorage implements TierRequestsStorage {
  constructor(
    public data: unknown,
    public failWrite = false,
    public failRead = false,
  ) {}

  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("read failed"))
    return Promise.resolve(this.data)
  }

  write(payload: TierRequestsPayload): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("write failed"))
    this.data = payload
    return Promise.resolve()
  }
}

function record(over: Partial<TierRequestRecord> = {}): TierRequestRecord {
  return { sessionID: "ses_1", tier: "standard", updatedAt: 1000, ...over }
}

function stored(storage: FakeTierRequestsStorage): unknown {
  return storage.data
}

describe("tier-request store", () => {
  it("round-trips records through the storage seam", async () => {
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => 1000)
    await store.set("ses_1", "quick")
    await store.set("ses_2", "advanced")
    expect(stored(storage)).toMatchObject({ version: TIER_REQUESTS_VERSION })

    const reloaded = new TierRequestStore(storage, () => 1000)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
    expect(reloaded.get("ses_1")).toBe("quick")
    expect(reloaded.get("ses_2")).toBe("advanced")
  })

  it("reads records another instance persisted (cross-instance mirror)", async () => {
    const storage = new FakeTierRequestsStorage({
      version: TIER_REQUESTS_VERSION,
      records: [record()],
    })
    const store = new TierRequestStore(storage, () => 1000)
    await store.load()
    expect(store.get("ses_1")).toBe("standard")
    expect(TIER_REQUESTS_KEY).toBe("coool.adaptive/tier-requests")
  })

  it("get returns null for unknown sessions and after removal", async () => {
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => 1000)
    expect(store.get("ses_1")).toBeNull()
    await store.set("ses_1", "quick")
    await store.set("ses_1", null)
    expect(store.get("ses_1")).toBeNull()
    expect(store.snapshot()).toEqual([])
  })

  it("drops invalid entries instead of throwing (corrupted payload)", async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { version: 99, records: [] },
      { version: TIER_REQUESTS_VERSION },
      { version: TIER_REQUESTS_VERSION, records: "nope" },
      { version: TIER_REQUESTS_VERSION, records: [null, 7, "x"] },
      { version: TIER_REQUESTS_VERSION, records: [record({ tier: "fibonacci" as never })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ tier: 7 as never })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ sessionID: "" })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ sessionID: 7 as never })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ sessionID: null as never })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ updatedAt: Number.NaN })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ updatedAt: Infinity })] },
      { version: TIER_REQUESTS_VERSION, records: [record({ updatedAt: "soon" as never })] },
    ]
    for (const payload of cases) {
      const store = new TierRequestStore(new FakeTierRequestsStorage(payload), () => 1000)
      await store.load()
      expect(store.snapshot()).toEqual([])
    }
  })

  it("keeps only well-formed records from a partially corrupted payload", async () => {
    const storage = new FakeTierRequestsStorage({
      version: TIER_REQUESTS_VERSION,
      records: [
        record({ sessionID: "ses_ok", updatedAt: 2000 }),
        record({ tier: "nope" as never }),
      ],
    })
    const store = new TierRequestStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.sessionID).toBe("ses_ok")
  })

  it("drops a sessionID beyond the 128-character bound", async () => {
    const storage = new FakeTierRequestsStorage({
      version: TIER_REQUESTS_VERSION,
      records: [record({ sessionID: "x".repeat(129) }), record({ sessionID: "x".repeat(128) })],
    })
    const store = new TierRequestStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.sessionID).toHaveLength(128)
  })

  it("keeps the most recently updated record for a duplicated session", async () => {
    const storage = new FakeTierRequestsStorage({
      version: TIER_REQUESTS_VERSION,
      records: [
        record({ sessionID: "ses_1", tier: "quick", updatedAt: 1000 }),
        record({ sessionID: "ses_1", tier: "standard", updatedAt: 2000 }),
        record({ sessionID: "ses_1", tier: "advanced", updatedAt: 500 }),
      ],
    })
    const store = new TierRequestStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toEqual([
      record({ sessionID: "ses_1", tier: "standard", updatedAt: 2000 }),
    ])
  })

  it("yields an empty store when the read fails", async () => {
    const store = new TierRequestStore(
      new FakeTierRequestsStorage(undefined, false, true),
      () => 1000,
    )
    await store.load()
    expect(store.snapshot()).toEqual([])
  })

  it("caps the record set, keeping the most recently updated", async () => {
    let now = 0
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => ++now)
    for (let index = 0; index < MAX_TIER_REQUEST_RECORDS + 10; index++) {
      await store.set(`ses_${String(index)}`, "standard")
    }
    const persisted = parseTierRequestsPayload(stored(storage))
    expect(persisted).toHaveLength(MAX_TIER_REQUEST_RECORDS)
    // The first ten requests (stamped earliest) are the evicted ones.
    expect(persisted.some((entry) => entry.sessionID === "ses_0")).toBe(false)
    expect(persisted.some((entry) => entry.sessionID === "ses_9")).toBe(false)
    expect(persisted.some((entry) => entry.sessionID === "ses_10")).toBe(true)
  })

  it("rejects malformed writes without touching memory", async () => {
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => 1000)
    await store.set("ses_1", "quick")
    await expect(store.set("", "quick")).rejects.toThrow("sessionID")
    await expect(store.set("x".repeat(129), "quick")).rejects.toThrow("sessionID")
    await expect(store.set("ses_1", "bogus" as never)).rejects.toThrow("tier must be one of")
    expect(store.snapshot()).toEqual([{ sessionID: "ses_1", tier: "quick", updatedAt: 1000 }])
  })

  it("propagates write failures and leaves memory unchanged", async () => {
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => 1000)
    await store.set("ses_1", "quick")
    const before = store.snapshot()
    storage.failWrite = true
    await expect(store.set("ses_1", "standard")).rejects.toThrow("write failed")
    await expect(store.set("ses_1", null)).rejects.toThrow("write failed")
    expect(store.snapshot()).toEqual(before)
  })

  it("stamps updatedAt from the injected clock", async () => {
    let now = 5000
    const storage = new FakeTierRequestsStorage(undefined)
    const store = new TierRequestStore(storage, () => now)
    await store.set("ses_1", "quick")
    now = 6000
    await store.set("ses_1", "advanced")
    const persisted = parseTierRequestsPayload(stored(storage))
    expect(persisted).toEqual([{ sessionID: "ses_1", tier: "advanced", updatedAt: 6000 }])
  })

  it("flush resolves only after a queued write has committed", async () => {
    const writing = gate()
    const releaseWrite = gate()
    let data: unknown
    const store = new TierRequestStore(
      {
        read: () => Promise.resolve(data),
        write: async (payload) => {
          writing.release()
          await releaseWrite.promise
          data = payload
        },
      },
      () => 1000,
    )
    void store.set("ses_a", "quick").catch(() => undefined)
    await writing.promise
    expect(store.get("ses_a")).toBeNull()
    expect(data).toBeUndefined()
    const flushing = store.flush()
    releaseWrite.release()
    await flushing
    expect(store.get("ses_a")).toBe("quick")
    expect(data).toMatchObject({ version: TIER_REQUESTS_VERSION })
  })
})

function gate(): { promise: Promise<void>; release(): void } {
  let release = (): void => {
    throw new Error("gate not initialized")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("tier-request store concurrency", () => {
  it("retains simultaneous sets for different sessions across reload", async () => {
    let data: unknown
    const storage = {
      read: () => Promise.resolve(data),
      write: (payload: TierRequestsPayload) => {
        data = payload
        return Promise.resolve()
      },
    }
    const store = new TierRequestStore(storage, () => 1000)
    await Promise.all([store.set("ses_a", "quick"), store.set("ses_b", "advanced")])
    expect(store.get("ses_a")).toBe("quick")
    expect(store.get("ses_b")).toBe("advanced")
    const reloaded = new TierRequestStore(storage, () => 1000)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
  })

  it("does not resurrect a removed session during a concurrent set", async () => {
    let data: unknown
    const store = new TierRequestStore(
      {
        read: () => Promise.resolve(data),
        write: (payload) => {
          data = payload
          return Promise.resolve()
        },
      },
      () => 1000,
    )
    await store.set("ses_a", "quick")
    await Promise.all([store.set("ses_a", null), store.set("ses_b", "advanced")])
    expect(store.get("ses_a")).toBeNull()
    expect(store.get("ses_b")).toBe("advanced")
    await store.load()
    expect(store.get("ses_a")).toBeNull()
    expect(store.get("ses_b")).toBe("advanced")
  })

  it("finishes an earlier load before computing a queued mutation", async () => {
    const reading = gate()
    const releaseRead = gate()
    const initial = {
      version: TIER_REQUESTS_VERSION,
      records: [{ sessionID: "ses_old", tier: "quick", updatedAt: 500 }],
    }
    let data: unknown = initial
    const store = new TierRequestStore(
      {
        read: async () => {
          reading.release()
          await releaseRead.promise
          return initial
        },
        write: (payload) => {
          data = payload
          return Promise.resolve()
        },
      },
      () => 1000,
    )
    const loading = store.load()
    await reading.promise
    const setting = store.set("ses_new", "advanced")
    releaseRead.release()
    await Promise.all([loading, setting])
    expect(store.get("ses_old")).toBe("quick")
    expect(store.get("ses_new")).toBe("advanced")
    expect(data).toEqual({ version: TIER_REQUESTS_VERSION, records: store.snapshot() })
  })

  it("does not let a later load read before an in-flight write commits", async () => {
    const writing = gate()
    const releaseWrite = gate()
    let data: unknown
    const store = new TierRequestStore(
      {
        read: async () => {
          const captured = data
          await releaseWrite.promise
          return captured
        },
        write: async (payload) => {
          writing.release()
          await releaseWrite.promise
          data = payload
        },
      },
      () => 1000,
    )
    const setting = store.set("ses_a", "quick")
    await writing.promise
    expect(store.get("ses_a")).toBeNull()
    expect(data).toBeUndefined()
    const loading = store.load()
    releaseWrite.release()
    await setting
    await loading
    expect(store.get("ses_a")).toBe("quick")
  })

  it("rejects a failed write without committing or poisoning queued operations", async () => {
    const writing = gate()
    const releaseWrite = gate()
    let data: unknown
    let writes = 0
    const store = new TierRequestStore(
      {
        read: () => Promise.resolve(data),
        write: async (payload) => {
          writes++
          if (writes === 1) {
            writing.release()
            await releaseWrite.promise
            throw new Error("write failed")
          }
          data = payload
        },
      },
      () => 1000,
    )
    const failed = expect(store.set("ses_failed", "quick")).rejects.toThrow("write failed")
    await writing.promise
    const succeeding = store.set("ses_ok", "advanced")
    const loading = store.load()
    expect(store.snapshot()).toEqual([])
    releaseWrite.release()
    await Promise.all([failed, succeeding, loading])
    expect(store.get("ses_failed")).toBeNull()
    expect(store.get("ses_ok")).toBe("advanced")
    expect(data).toEqual({ version: TIER_REQUESTS_VERSION, records: store.snapshot() })
  })
})
