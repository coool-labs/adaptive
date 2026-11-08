// covers: ["ADP-024"]
import { describe, expect, test } from "vitest"
import { ParkedWorkStore } from "../../../src/state/parked-work/index.js"
import type {
  ParkedPayload,
  ParkedRecord,
  ParkedStorage,
} from "../../../src/state/parked-work/index.js"

function gate() {
  let release: () => void = () => {
    throw new Error("gate not initialized")
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function record(id: string): ParkedRecord {
  return { id, sessionID: "s", tier: "standard", reason: "all-blocked", parkedAt: 1 }
}

class Storage implements ParkedStorage {
  payload: ParkedPayload = { version: 1, parked: [] }
  writes: ParkedPayload[] = []

  read(): Promise<unknown> {
    return Promise.resolve(this.payload)
  }

  write(payload: ParkedPayload): Promise<void> {
    this.writes.push(payload)
    this.payload = payload
    return Promise.resolve()
  }
}

describe("ParkedWorkStore per-instance concurrency", () => {
  test("concurrent parks retain both records in memory and across restart", async () => {
    const storage = new Storage()
    const store = new ParkedWorkStore(storage)
    await Promise.all([store.park(record("s#1")), store.park(record("s#2"))])
    expect(store.list()).toEqual([record("s#1"), record("s#2")])
    const restarted = new ParkedWorkStore(storage)
    await restarted.load()
    expect(restarted.list()).toEqual(store.list())
  })

  test("simultaneous resumes have one winner and only one removal write", async () => {
    const storage = new Storage()
    const store = new ParkedWorkStore(storage)
    await store.park(record("s#1"))
    const results = await Promise.all([store.resume("s#1"), store.resume("s#1")])
    expect(results).toEqual([record("s#1"), undefined])
    expect(storage.writes).toHaveLength(2)
    expect(store.count()).toBe(0)
    expect(storage.payload.parked).toEqual([])
  })

  test("a pending load completes before a later park computes its state", async () => {
    const started = gate()
    const finishRead = gate()
    const storage = new Storage()
    storage.payload = { version: 1, parked: [record("s#old")] }
    storage.read = async () => {
      const snapshot = storage.payload
      started.release()
      await finishRead.promise
      return snapshot
    }
    const store = new ParkedWorkStore(storage)
    const loading = store.load()
    await started.promise
    const parking = store.park(record("s#new"))
    await Promise.resolve()
    expect(storage.writes).toEqual([])
    expect(store.count()).toBe(0)
    finishRead.release()
    await Promise.all([loading, parking])
    expect(store.list()).toEqual([record("s#old"), record("s#new")])
    expect(storage.payload.parked).toEqual(store.list())
  })

  test("a load waits for an earlier write and memory changes only after persistence", async () => {
    const started = gate()
    const finishWrite = gate()
    const storage = new Storage()
    let reads = 0
    storage.read = () => {
      reads++
      return Promise.resolve(storage.payload)
    }
    storage.write = async (payload) => {
      started.release()
      await finishWrite.promise
      storage.payload = payload
    }
    const store = new ParkedWorkStore(storage)
    const parking = store.park(record("s#1"))
    await started.promise
    const loading = store.load()
    await Promise.resolve()
    // The park's own pre-mutation read only; the load has not started.
    expect(reads).toBe(1)
    expect(store.list()).toEqual([])
    finishWrite.release()
    await Promise.all([parking, loading])
    expect(reads).toBe(2)
    expect(store.list()).toEqual([record("s#1")])
    expect(storage.payload.parked).toEqual(store.list())
  })

  test("a rejected park keeps its rejection and does not poison the next queued park", async () => {
    const storage = new Storage()
    const failure = new Error("write failed")
    storage.write = (payload) => {
      storage.writes.push(payload)
      if (storage.writes.length === 1) return Promise.reject(failure)
      storage.payload = payload
      return Promise.resolve()
    }
    const store = new ParkedWorkStore(storage)
    const failed = store.park(record("s#failed"))
    const succeeded = store.park(record("s#ok"))
    await expect(failed).rejects.toBe(failure)
    await succeeded
    expect(store.list()).toEqual([record("s#ok")])
    expect(storage.payload.parked).toEqual(store.list())
  })

  test("a failed resume leaves the record for the next queued resume", async () => {
    const storage = new Storage()
    const store = new ParkedWorkStore(storage)
    await store.park(record("s#1"))
    const failure = new Error("removal failed")
    storage.write = (payload) => {
      storage.writes.push(payload)
      if (storage.writes.length === 2) return Promise.reject(failure)
      storage.payload = payload
      return Promise.resolve()
    }
    const failed = store.resume("s#1")
    const succeeded = store.resume("s#1")
    await expect(failed).rejects.toBe(failure)
    await expect(succeeded).resolves.toEqual(record("s#1"))
    expect(store.count()).toBe(0)
    expect(storage.payload.parked).toEqual([])
  })

  test("a stale instance cannot resurrect or re-resume a record another instance resumed", async () => {
    const storage = new Storage()
    const pump = new ParkedWorkStore(storage)
    const other = new ParkedWorkStore(storage)
    await pump.park(record("s#1"))
    await other.load()
    await expect(pump.resume("s#1")).resolves.toEqual(record("s#1"))
    await expect(other.resume("s#1")).resolves.toBeUndefined()
    await other.park(record("s#2"))
    expect(storage.payload.parked).toEqual([record("s#2")])
  })

  test("refresh adopts storage and keeps memory when the read fails", async () => {
    const storage = new Storage()
    const pump = new ParkedWorkStore(storage)
    const other = new ParkedWorkStore(storage)
    await pump.park(record("s#1"))
    await other.refresh()
    expect(other.list()).toEqual([record("s#1")])
    storage.read = () => Promise.reject(new Error("read failed"))
    await other.refresh()
    expect(other.list()).toEqual([record("s#1")])
  })
})
