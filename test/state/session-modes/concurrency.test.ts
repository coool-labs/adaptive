// covers: ["ADP-054"]
import { describe, expect, it } from "vitest"
import { SessionModeStore } from "../../../src/state/session-modes/index.js"
import { SESSION_MODES_VERSION } from "../../../src/state/session-modes/types.js"
import type { SessionModesPayload } from "../../../src/state/session-modes/types.js"

function gate(): { promise: Promise<void>; release(): void } {
  let release = (): void => {
    throw new Error("gate not initialized")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("session-mode store concurrency", () => {
  it("retains simultaneous sets for different sessions across reload", async () => {
    let data: unknown
    const storage = {
      read: () => Promise.resolve(data),
      write: (payload: SessionModesPayload) => {
        data = payload
        return Promise.resolve()
      },
    }
    const store = new SessionModeStore(storage, () => 1000)
    await Promise.all([store.set("ses_a", "active"), store.set("ses_b", "off")])
    expect(store.get("ses_a")).toBe("active")
    expect(store.get("ses_b")).toBe("off")
    const reloaded = new SessionModeStore(storage, () => 1000)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
  })

  it("does not resurrect a removed session during a concurrent set", async () => {
    let data: unknown
    const store = new SessionModeStore(
      {
        read: () => Promise.resolve(data),
        write: (payload) => {
          data = payload
          return Promise.resolve()
        },
      },
      () => 1000,
    )
    await store.set("ses_a", "active")
    await Promise.all([store.set("ses_a", null), store.set("ses_b", "off")])
    expect(store.get("ses_a")).toBeNull()
    expect(store.get("ses_b")).toBe("off")
    await store.load()
    expect(store.get("ses_a")).toBeNull()
    expect(store.get("ses_b")).toBe("off")
  })

  it("finishes an earlier load before computing a queued mutation", async () => {
    const reading = gate()
    const releaseRead = gate()
    const initial = {
      version: SESSION_MODES_VERSION,
      records: [{ sessionID: "ses_old", mode: "observe", updatedAt: 500 }],
    }
    let data: unknown = initial
    const store = new SessionModeStore(
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
    const setting = store.set("ses_new", "active")
    releaseRead.release()
    await Promise.all([loading, setting])
    expect(store.get("ses_old")).toBe("observe")
    expect(store.get("ses_new")).toBe("active")
    expect(data).toEqual({ version: SESSION_MODES_VERSION, records: store.snapshot() })
  })

  it("does not let a later load read before an in-flight write commits", async () => {
    const writing = gate()
    const releaseWrite = gate()
    let data: unknown
    const store = new SessionModeStore(
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
    const setting = store.set("ses_a", "active")
    await writing.promise
    expect(store.get("ses_a")).toBeNull()
    expect(data).toBeUndefined()
    const loading = store.load()
    releaseWrite.release()
    await setting
    await loading
    expect(store.get("ses_a")).toBe("active")
  })

  it("rejects a failed write without committing or poisoning queued operations", async () => {
    const writing = gate()
    const releaseWrite = gate()
    let data: unknown
    let writes = 0
    const store = new SessionModeStore(
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
    const failed = expect(store.set("ses_failed", "active")).rejects.toThrow("write failed")
    await writing.promise
    const succeeding = store.set("ses_ok", "off")
    const loading = store.load()
    expect(store.snapshot()).toEqual([])
    releaseWrite.release()
    await Promise.all([failed, succeeding, loading])
    expect(store.get("ses_failed")).toBeNull()
    expect(store.get("ses_ok")).toBe("off")
    expect(data).toEqual({ version: SESSION_MODES_VERSION, records: store.snapshot() })
  })
})
