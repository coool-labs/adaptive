/**
 * Health-record store tests: the store is a persistence mirror of the
 * resource-health registry (records survive restarts and are readable by
 * every plugin instance in the host process). Round-trip, defensiveness and
 * the persist-before-commit rule are asserted through the storage seam.
 */
// covers: ["ADP-007", "ADP-019", "ADP-033"]
import { describe, expect, it } from "vitest"

import { parseHealthPayload } from "../../../src/state/health/index.js"
import { HealthRecordStore } from "../../../src/state/health/index.js"
import { HEALTH_KEY, HEALTH_VERSION, MAX_HEALTH_RECORDS } from "../../../src/state/health/types.js"
import type { HealthPayload, HealthStorage } from "../../../src/state/health/types.js"
import type { ResourceRecord } from "../../../src/health/resource-health/types.js"

class FakeHealthStorage implements HealthStorage {
  constructor(
    public data: unknown,
    public failWrite = false,
    public failRead = false,
  ) {}

  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("read failed"))
    return Promise.resolve(this.data)
  }

  write(payload: HealthPayload): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("write failed"))
    this.data = payload
    return Promise.resolve()
  }
}

/** A rate-limited record with a one-minute window (the common persisted shape). */
function record(over: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    key: { providerID: "prov", modelID: "a" },
    health: "rate_limited",
    breaker: { state: "closed", failures: 1, openCount: 0 },
    window: { kind: "rate-limit", until: 31_000 },
    updatedAt: 1000,
    ...over,
  }
}

function stored(storage: FakeHealthStorage): unknown {
  return storage.data
}

describe("health record store", () => {
  it("round-trips records through the storage seam", async () => {
    const storage = new FakeHealthStorage(undefined)
    const store = new HealthRecordStore(storage)
    await store.replace([record(), record({ key: { providerID: "prov" }, updatedAt: 900 })])
    expect(stored(storage)).toMatchObject({ version: HEALTH_VERSION })

    const reloaded = new HealthRecordStore(storage)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
  })

  it("reads records another instance persisted (cross-instance status mirror)", async () => {
    const storage = new FakeHealthStorage({
      version: HEALTH_VERSION,
      records: [record()],
    })
    const store = new HealthRecordStore(storage)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.health).toBe("rate_limited")
    expect(HEALTH_KEY).toBe("coool.adaptive/health")
  })

  it("drops invalid records instead of throwing (corrupted payload)", async () => {
    const cases: unknown[] = [
      undefined,
      {},
      { version: 99, records: [] },
      { version: HEALTH_VERSION },
      { version: HEALTH_VERSION, records: "nope" },
      { version: HEALTH_VERSION, records: [null, 7, "x"] },
      { version: HEALTH_VERSION, records: [record({ health: "fibonacci" as never })] },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: "" } })] },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: "p", variantID: "v" } })] },
      {
        version: HEALTH_VERSION,
        records: [record({ key: { providerID: "p", accountID: 7 } as never })],
      },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: "p", modelID: "" } })] },
      {
        version: HEALTH_VERSION,
        records: [record({ key: { providerID: "p", modelID: "m", variantID: "v".repeat(129) } })],
      },
      { version: HEALTH_VERSION, records: [record({ updatedAt: Number.NaN })] },
      { version: HEALTH_VERSION, records: [record({ breaker: { state: "broken" } as never })] },
      {
        version: HEALTH_VERSION,
        records: [record({ breaker: { state: "closed", failures: -1, openCount: 0 } })],
      },
    ]
    for (const payload of cases) {
      const store = new HealthRecordStore(new FakeHealthStorage(payload))
      await store.load()
      expect(store.snapshot()).toEqual([])
    }
  })

  it("keeps only well-formed records from a partially corrupted payload", async () => {
    const storage = new FakeHealthStorage({
      version: HEALTH_VERSION,
      records: [record({ updatedAt: 2000 }), record({ health: "nope" as never })],
    })
    const store = new HealthRecordStore(storage)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]?.updatedAt).toBe(2000)
  })

  it("yields an empty store when the read fails", async () => {
    const store = new HealthRecordStore(new FakeHealthStorage(undefined, false, true))
    await store.load()
    expect(store.snapshot()).toEqual([])
  })

  it("caps the record set, keeping the most recently updated", async () => {
    const storage = new FakeHealthStorage(undefined)
    const store = new HealthRecordStore(storage)
    const records: ResourceRecord[] = []
    for (let index = 0; index < MAX_HEALTH_RECORDS + 10; index++) {
      records.push(
        record({ key: { providerID: "prov", modelID: `m${String(index)}` }, updatedAt: index }),
      )
    }
    await store.replace(records)
    const persisted = parseHealthPayload(stored(storage))
    expect(persisted).toHaveLength(MAX_HEALTH_RECORDS)
    // The ten oldest records (updatedAt 0..9) are the evicted ones.
    expect(persisted.some((entry) => entry.updatedAt < 10)).toBe(false)
  })

  it("round-trips every optional scope and breaker field", async () => {
    const storage = new FakeHealthStorage(undefined)
    const store = new HealthRecordStore(storage)
    const full: ResourceRecord = record({
      key: { providerID: "prov", accountID: "acc", modelID: "a", variantID: "v" },
      health: "degraded",
      breaker: {
        state: "half_open",
        failures: 5,
        openCount: 2,
        reopenAt: 40_000,
        probeId: "p7",
        probeAt: 39_000,
      },
      window: { kind: "quota", until: 99_000 },
    })
    await store.replace([full])
    const reloaded = new HealthRecordStore(storage)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual([full])
  })

  it("drops records whose identifiers exceed the bound instead of truncating them", async () => {
    // Regression: truncation hydrated the record under a different key (the
    // writer never truncates), orphaning it and colliding shared prefixes.
    const longID = "p".repeat(200)
    const storage = new FakeHealthStorage({
      version: HEALTH_VERSION,
      records: [record({ key: { providerID: longID, modelID: "a" } }), record()],
    })
    const store = new HealthRecordStore(storage)
    await store.load()
    expect(store.snapshot()).toEqual([record()])
  })

  it("drops a windowed state whose window is invalid", async () => {
    // Regression: dropping only the window left a windowless rate limit,
    // which blocks the resource with nothing able to lift it.
    const storage = new FakeHealthStorage({
      version: HEALTH_VERSION,
      records: [
        record({ window: "nope" as never }),
        record({ window: { kind: "weird", until: 5 } as never }),
        record({
          health: "quota_exhausted",
          window: { kind: "quota", until: Number.NaN } as never,
        }),
        record({ health: "rate_limited", window: undefined }),
      ],
    })
    const store = new HealthRecordStore(storage)
    await store.load()
    expect(store.snapshot()).toEqual([])
  })

  it("drops an invalid window from a state that needs none", async () => {
    const storage = new FakeHealthStorage({
      version: HEALTH_VERSION,
      records: [record({ health: "degraded", window: "nope" as never })],
    })
    const store = new HealthRecordStore(storage)
    await store.load()
    expect(store.snapshot()).toEqual([record({ health: "degraded", window: undefined })])
  })

  it("drops records with malformed scope shapes and typed fields", async () => {
    const cases: unknown[] = [
      { version: HEALTH_VERSION, records: [record({ key: 7 as never })] },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: 7 } as never })] },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: "p", variantID: "v" } })] },
      {
        version: HEALTH_VERSION,
        records: [record({ key: { providerID: "p", accountID: 7 } as never })],
      },
      { version: HEALTH_VERSION, records: [record({ key: { providerID: "p", modelID: "" } })] },
      {
        version: HEALTH_VERSION,
        records: [record({ key: { providerID: "p", modelID: "m", variantID: "v".repeat(129) } })],
      },
      { version: HEALTH_VERSION, records: [record({ health: 7 as never })] },
      { version: HEALTH_VERSION, records: [record({ breaker: "broken" as never })] },
      {
        version: HEALTH_VERSION,
        records: [record({ breaker: { state: 7, failures: 1, openCount: 0 } as never })],
      },
      {
        version: HEALTH_VERSION,
        records: [record({ breaker: { state: "closed", failures: 1.5, openCount: 0 } as never })],
      },
      {
        version: HEALTH_VERSION,
        records: [
          record({ breaker: { state: "closed", failures: 1, openCount: "many" } as never }),
        ],
      },
    ]
    for (const payload of cases) {
      const store = new HealthRecordStore(new FakeHealthStorage(payload))
      await store.load()
      expect(store.snapshot()).toEqual([])
    }
  })

  it("propagates write failures and leaves memory unchanged", async () => {
    const storage = new FakeHealthStorage(undefined)
    const store = new HealthRecordStore(storage)
    await store.replace([record()])
    const before = store.snapshot()
    storage.failWrite = true
    await expect(store.replace([record({ updatedAt: 2 })])).rejects.toThrow("write failed")
    expect(store.snapshot()).toEqual(before)
  })
})
