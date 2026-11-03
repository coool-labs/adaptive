// covers: ["ADP-007", "ADP-019", "ADP-031", "ADP-056"]
import { describe, expect, it } from "vitest"
import { CapacityReadingStore } from "../../src/state/capacity/index.js"
import { HealthRecordStore } from "../../src/state/health/index.js"
import type { PersistedCapacityReading } from "../../src/state/capacity/types.js"
import type { ResourceRecord } from "../../src/health/resource-health/types.js"

function gate() {
  let release: () => void = () => {
    // Replaced by the promise executor below before any caller can run it.
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

class Storage {
  data: unknown
  writes = 0

  read(): Promise<unknown> {
    return Promise.resolve(this.data)
  }

  write(payload: unknown): Promise<void> {
    this.writes++
    this.data = payload
    return Promise.resolve()
  }
}

function health(updatedAt: number): ResourceRecord {
  return {
    key: { providerID: "p" },
    health: "healthy",
    breaker: { state: "closed", failures: 0, openCount: 0 },
    updatedAt,
  }
}

function capacity(observedAt: number): PersistedCapacityReading {
  return {
    key: { providerID: "p" },
    reading: { observedAt, usedRatio: 0.5, confidence: "high" },
  }
}

describe.each(["health", "capacity"])("%s persistence ordering", (name) => {
  // Both stores expose the same lifecycle; convert the fixture input at this
  // boundary so the tests exercise their public interfaces without assertions.
  function fixture(storage: Storage) {
    if (name === "health") {
      const store = new HealthRecordStore(storage)
      return { store, replace: (at: number) => store.replace([health(at)]), entry: health }
    }
    const store = new CapacityReadingStore(storage)
    return { store, replace: (at: number) => store.replace([capacity(at)]), entry: capacity }
  }

  it("commits overlapping writes in invocation order, including after restart", async () => {
    const storage = new Storage()
    const { store, replace, entry } = fixture(storage)
    const started = gate()
    const finish = gate()
    storage.write = async (payload) => {
      storage.writes++
      if (storage.writes === 1) {
        started.release()
        await finish.promise
      }
      storage.data = payload
    }
    const first = replace(1)
    await started.promise
    const second = replace(2)
    try {
      await Promise.resolve()
      expect(storage.writes).toBe(1)
      expect(store.snapshot()).toEqual([])
    } finally {
      finish.release()
      await Promise.all([first, second])
    }
    expect(store.snapshot()).toEqual([entry(2)])
    const restarted = fixture(storage).store
    await restarted.load()
    expect(restarted.snapshot()).toEqual([entry(2)])
  })

  it("loads after a pending write instead of restoring its older snapshot", async () => {
    const storage = new Storage()
    const { store, replace, entry } = fixture(storage)
    await replace(1)
    const started = gate()
    const finish = gate()
    storage.write = async (payload) => {
      started.release()
      await finish.promise
      storage.data = payload
    }
    let reads = 0
    storage.read = () => {
      reads++
      return Promise.resolve(storage.data)
    }
    const writing = replace(2)
    await started.promise
    const loading = store.load()
    try {
      await Promise.resolve()
      expect(reads).toBe(0)
    } finally {
      finish.release()
      await Promise.all([writing, loading])
    }
    expect(store.snapshot()).toEqual([entry(2)])
  })

  it("waits for a pending load before applying the next write", async () => {
    const storage = new Storage()
    const { store, replace, entry } = fixture(storage)
    await replace(1)
    const started = gate()
    const finish = gate()
    storage.read = async () => {
      const snapshot = storage.data
      started.release()
      await finish.promise
      return snapshot
    }
    const loading = store.load()
    await started.promise
    const writing = replace(2)
    try {
      await Promise.resolve()
      expect(storage.writes).toBe(1)
    } finally {
      finish.release()
      await Promise.all([loading, writing])
    }
    expect(store.snapshot()).toEqual([entry(2)])
  })

  it("preserves write errors without poisoning subsequent queued updates", async () => {
    const storage = new Storage()
    const { store, replace, entry } = fixture(storage)
    const failure = new Error("write failed")
    storage.write = (payload) => {
      storage.writes++
      if (storage.writes === 1) return Promise.reject(failure)
      storage.data = payload
      return Promise.resolve()
    }
    const failed = replace(1)
    const succeeded = replace(2)
    await expect(failed).rejects.toBe(failure)
    await succeeded
    expect(store.snapshot()).toEqual([entry(2)])
    const restarted = fixture(storage).store
    await restarted.load()
    expect(restarted.snapshot()).toEqual(store.snapshot())
  })
})
