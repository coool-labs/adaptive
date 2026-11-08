/**
 * Session-mode override store tests (ADP-054): round-trip, get/set/remove,
 * defensiveness against corrupted payloads, the record cap, and the
 * persist-before-commit rule — asserted through the storage seam, mirroring
 * the health-record store tests.
 */
// covers: ["ADP-051", "ADP-054"]
import { describe, expect, it } from "vitest"

import { parseSessionModesPayload } from "../../../src/state/session-modes/index.js"
import { SessionModeStore } from "../../../src/state/session-modes/index.js"
import {
  MAX_SESSION_MODE_RECORDS,
  SESSION_MODES_KEY,
  SESSION_MODES_VERSION,
} from "../../../src/state/session-modes/types.js"
import type {
  SessionModeRecord,
  SessionModesPayload,
  SessionModesStorage,
} from "../../../src/state/session-modes/types.js"

class FakeSessionModesStorage implements SessionModesStorage {
  constructor(
    public data: unknown,
    public failWrite = false,
    public failRead = false,
  ) {}

  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("read failed"))
    return Promise.resolve(this.data)
  }

  write(payload: SessionModesPayload): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("write failed"))
    this.data = payload
    return Promise.resolve()
  }
}

function record(over: Partial<SessionModeRecord> = {}): SessionModeRecord {
  return { sessionID: "ses_1", mode: "observe", updatedAt: 1000, ...over }
}

function stored(storage: FakeSessionModesStorage): unknown {
  return storage.data
}

describe("session-mode store", () => {
  it("round-trips records through the storage seam", async () => {
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => 1000)
    await store.set("ses_1", "active")
    await store.set("ses_2", "off")
    expect(stored(storage)).toMatchObject({ version: SESSION_MODES_VERSION })

    const reloaded = new SessionModeStore(storage, () => 1000)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
    expect(reloaded.get("ses_1")).toBe("active")
    expect(reloaded.get("ses_2")).toBe("off")
  })

  it("reads records another instance persisted (cross-instance mirror)", async () => {
    const storage = new FakeSessionModesStorage({
      version: SESSION_MODES_VERSION,
      records: [record()],
    })
    const store = new SessionModeStore(storage, () => 1000)
    await store.load()
    expect(store.get("ses_1")).toBe("observe")
    expect(SESSION_MODES_KEY).toBe("coool.adaptive/session-modes")
  })

  it("get returns null for unknown sessions and after removal", async () => {
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => 1000)
    expect(store.get("ses_1")).toBeNull()
    await store.set("ses_1", "active")
    await store.set("ses_1", null)
    expect(store.get("ses_1")).toBeNull()
    expect(store.snapshot()).toEqual([])
  })

  it("drops invalid entries instead of throwing (corrupted payload)", async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { version: 99, records: [] },
      { version: SESSION_MODES_VERSION },
      { version: SESSION_MODES_VERSION, records: "nope" },
      { version: SESSION_MODES_VERSION, records: [null, 7, "x"] },
      { version: SESSION_MODES_VERSION, records: [record({ mode: "fibonacci" as never })] },
      { version: SESSION_MODES_VERSION, records: [record({ mode: 7 as never })] },
      { version: SESSION_MODES_VERSION, records: [record({ sessionID: "" })] },
      { version: SESSION_MODES_VERSION, records: [record({ sessionID: 7 as never })] },
      { version: SESSION_MODES_VERSION, records: [record({ sessionID: null as never })] },
      { version: SESSION_MODES_VERSION, records: [record({ updatedAt: Number.NaN })] },
      { version: SESSION_MODES_VERSION, records: [record({ updatedAt: "soon" as never })] },
    ]
    for (const payload of cases) {
      const store = new SessionModeStore(new FakeSessionModesStorage(payload), () => 1000)
      await store.load()
      expect(store.snapshot()).toEqual([])
    }
  })

  it("keeps only well-formed records from a partially corrupted payload", async () => {
    const storage = new FakeSessionModesStorage({
      version: SESSION_MODES_VERSION,
      records: [
        record({ sessionID: "ses_ok", updatedAt: 2000 }),
        record({ mode: "nope" as never }),
      ],
    })
    const store = new SessionModeStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.sessionID).toBe("ses_ok")
  })

  it("drops a sessionID beyond the 128-character bound", async () => {
    const storage = new FakeSessionModesStorage({
      version: SESSION_MODES_VERSION,
      records: [record({ sessionID: "x".repeat(129) }), record({ sessionID: "x".repeat(128) })],
    })
    const store = new SessionModeStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.sessionID).toHaveLength(128)
  })

  it("keeps the most recently updated record for a duplicated session", async () => {
    const storage = new FakeSessionModesStorage({
      version: SESSION_MODES_VERSION,
      records: [
        record({ sessionID: "ses_1", mode: "observe", updatedAt: 1000 }),
        record({ sessionID: "ses_1", mode: "active", updatedAt: 2000 }),
        record({ sessionID: "ses_1", mode: "off", updatedAt: 500 }),
      ],
    })
    const store = new SessionModeStore(storage, () => 1000)
    await store.load()
    expect(store.snapshot()).toEqual([
      record({ sessionID: "ses_1", mode: "active", updatedAt: 2000 }),
    ])
  })

  it("yields an empty store when the read fails", async () => {
    const store = new SessionModeStore(
      new FakeSessionModesStorage(undefined, false, true),
      () => 1000,
    )
    await store.load()
    expect(store.snapshot()).toEqual([])
  })

  it("caps the record set, keeping the most recently updated", async () => {
    let now = 0
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => ++now)
    for (let index = 0; index < MAX_SESSION_MODE_RECORDS + 10; index++) {
      await store.set(`ses_${String(index)}`, "observe")
    }
    const persisted = parseSessionModesPayload(stored(storage))
    expect(persisted).toHaveLength(MAX_SESSION_MODE_RECORDS)
    // The first ten overrides (stamped earliest) are the evicted ones.
    expect(persisted.some((entry) => entry.sessionID === "ses_0")).toBe(false)
    expect(persisted.some((entry) => entry.sessionID === "ses_9")).toBe(false)
    expect(persisted.some((entry) => entry.sessionID === "ses_10")).toBe(true)
  })

  it("rejects malformed writes without touching memory", async () => {
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => 1000)
    await store.set("ses_1", "active")
    await expect(store.set("", "active")).rejects.toThrow("sessionID")
    await expect(store.set("x".repeat(129), "active")).rejects.toThrow("sessionID")
    await expect(store.set("ses_1", "bogus" as never)).rejects.toThrow("mode must be one of")
    expect(store.snapshot()).toEqual([{ sessionID: "ses_1", mode: "active", updatedAt: 1000 }])
  })

  it("propagates write failures and leaves memory unchanged", async () => {
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => 1000)
    await store.set("ses_1", "active")
    const before = store.snapshot()
    storage.failWrite = true
    await expect(store.set("ses_1", "observe")).rejects.toThrow("write failed")
    await expect(store.set("ses_1", null)).rejects.toThrow("write failed")
    expect(store.snapshot()).toEqual(before)
  })

  it("stamps updatedAt from the injected clock", async () => {
    let now = 5000
    const storage = new FakeSessionModesStorage(undefined)
    const store = new SessionModeStore(storage, () => now)
    await store.set("ses_1", "active")
    now = 6000
    await store.set("ses_1", "observe")
    const persisted = parseSessionModesPayload(stored(storage))
    expect(persisted).toEqual([{ sessionID: "ses_1", mode: "observe", updatedAt: 6000 }])
  })
})
