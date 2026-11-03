/**
 * Capacity reading store tests: the store is a persistence mirror of the
 * capacity registry (readings survive across, and are readable by, every
 * plugin instance in the host process). Defensive parsing, newest-wins
 * merging, the bound and the persist-before-commit rule are asserted through
 * the storage seam.
 */
// covers: ["ADP-031", "ADP-056"]
import { describe, expect, it } from "vitest"

import { CapacityReadingStore, parseCapacityPayload } from "../../../src/state/capacity/index.js"
import {
  CAPACITY_KEY,
  CAPACITY_VERSION,
  MAX_CAPACITY_READINGS,
} from "../../../src/state/capacity/types.js"
import type {
  CapacityPayload,
  CapacityStorage,
  PersistedCapacityReading,
} from "../../../src/state/capacity/types.js"

class FakeCapacityStorage implements CapacityStorage {
  constructor(
    public data: unknown,
    public failWrite = false,
    public failRead = false,
  ) {}

  read(): Promise<unknown> {
    if (this.failRead) return Promise.reject(new Error("read failed"))
    return Promise.resolve(this.data)
  }

  write(payload: CapacityPayload): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("write failed"))
    this.data = payload
    return Promise.resolve()
  }
}

function entry(
  over: { modelID?: string; observedAt?: number; usedRatio?: number } = {},
): PersistedCapacityReading {
  return {
    key: { providerID: "openai", modelID: over.modelID ?? "a" },
    reading: {
      usedRatio: over.usedRatio ?? 0.5,
      confidence: "high",
      observedAt: over.observedAt ?? 1000,
    },
  }
}

/** A raw persisted entry, as the untrusted reader sees it. */
function raw(
  key: unknown = { providerID: "openai" },
  reading: unknown = { usedRatio: 0.5, confidence: "high", observedAt: 1000 },
): unknown {
  return { key, reading }
}

function payload(...readings: unknown[]): unknown {
  return { version: CAPACITY_VERSION, readings }
}

describe("capacity payload parser", () => {
  it("round-trips a valid entry with every scope field and measurement", () => {
    const full = raw(
      { providerID: "openai", accountID: "acct", modelID: "m", variantID: "v" },
      {
        usedRatio: 0.72,
        remainingRatio: 0.28,
        retryAfterMs: 5000,
        resetAt: 9000,
        confidence: "medium",
        observedAt: 1000,
        evidence: "x-codex headers",
      },
    )
    expect(parseCapacityPayload(payload(full))).toEqual([full])
  })

  it("drops payloads that are not the current versioned shape", () => {
    const cases: unknown[] = [
      undefined,
      null,
      [],
      "text",
      {},
      { version: 99, readings: [] },
      { version: CAPACITY_VERSION },
      { version: CAPACITY_VERSION, readings: "nope" },
    ]
    for (const bad of cases) expect(parseCapacityPayload(bad)).toEqual([])
  })

  it("drops entries that are not records", () => {
    expect(parseCapacityPayload(payload(null, "entry", 7, ["key"]))).toEqual([])
  })

  it("keeps a reading that carries only a remaining ratio", () => {
    const parsed = parseCapacityPayload(
      payload(raw(undefined, { remainingRatio: 0.25, confidence: "high", observedAt: 3 })),
    )
    expect(parsed).toEqual([
      {
        key: { providerID: "openai" },
        reading: { remainingRatio: 0.25, confidence: "high", observedAt: 3 },
      },
    ])
  })

  it("drops entries with an unusable key", () => {
    const cases: unknown[] = [
      raw(null),
      raw("openai"),
      raw({}),
      raw({ providerID: 7 }),
      raw({ providerID: "openai", variantID: "v" }),
      raw({ providerID: "" }),
      raw({ providerID: "x".repeat(129) }),
      raw({ providerID: "openai", modelID: "" }),
      raw({ providerID: "openai", accountID: 7 }),
      raw({ providerID: "openai", modelID: "m", variantID: "v".repeat(129) }),
    ]
    expect(parseCapacityPayload(payload(...cases))).toEqual([])
  })

  it("drops entries with an unusable reading", () => {
    const cases: unknown[] = [
      raw(undefined, null),
      raw(undefined, "reading"),
      raw(undefined, { usedRatio: 0.5, confidence: "certain", observedAt: 1 }),
      raw(undefined, { usedRatio: 0.5, confidence: 3, observedAt: 1 }),
      raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: "now" }),
      raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: -1 }),
      raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: Infinity }),
    ]
    expect(parseCapacityPayload(payload(...cases))).toEqual([])
  })

  it("discards a reading none of whose measured fields are valid", () => {
    const base = { confidence: "high", observedAt: 1 }
    const cases: unknown[] = [
      raw(undefined, base),
      raw(undefined, { ...base, usedRatio: 1.5, remainingRatio: -0.1 }),
      raw(undefined, { ...base, usedRatio: "half", retryAfterMs: -5, resetAt: -5 }),
    ]
    expect(parseCapacityPayload(payload(...cases))).toEqual([])
  })

  it("keeps the valid measured fields and drops the invalid ones", () => {
    const parsed = parseCapacityPayload(
      payload(
        raw(undefined, {
          usedRatio: 0.4,
          remainingRatio: 7,
          retryAfterMs: -1,
          resetAt: 500,
          confidence: "low",
          observedAt: 2,
        }),
      ),
    )
    expect(parsed).toEqual([
      {
        key: { providerID: "openai" },
        reading: { usedRatio: 0.4, resetAt: 500, confidence: "low", observedAt: 2 },
      },
    ])
  })

  it("truncates evidence to 128 characters and omits empty evidence", () => {
    const long = "x".repeat(300)
    const parsed = parseCapacityPayload(
      payload(
        raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: 1, evidence: long }),
        raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: 1, evidence: "" }),
        raw(undefined, { usedRatio: 0.5, confidence: "high", observedAt: 1, evidence: 5 }),
      ),
    )
    expect(parsed[0]?.reading.evidence).toHaveLength(128)
    expect(parsed[1]?.reading).not.toHaveProperty("evidence")
    expect(parsed[2]?.reading).not.toHaveProperty("evidence")
  })

  it("reads at most MAX_CAPACITY_READINGS entries", () => {
    const many = Array.from({ length: MAX_CAPACITY_READINGS + 10 }, () => raw())
    expect(parseCapacityPayload(payload(...many))).toHaveLength(MAX_CAPACITY_READINGS)
  })
})

describe("capacity reading store", () => {
  it("round-trips readings through the storage seam", async () => {
    const storage = new FakeCapacityStorage(undefined)
    const store = new CapacityReadingStore(storage)
    await store.replace([entry(), entry({ modelID: "b", observedAt: 900 })])
    expect(storage.data).toMatchObject({ version: CAPACITY_VERSION })

    const reloaded = new CapacityReadingStore(storage)
    await reloaded.load()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
    expect(CAPACITY_KEY).toBe("coool.adaptive/capacity")
  })

  it("reads readings another instance persisted (cross-instance status mirror)", async () => {
    const storage = new FakeCapacityStorage(payload(entry()))
    const store = new CapacityReadingStore(storage)
    await store.load()
    expect(store.snapshot()).toEqual([entry()])
  })

  it("treats an unreadable mirror as empty instead of failing", async () => {
    const storage = new FakeCapacityStorage(payload(entry()))
    const store = new CapacityReadingStore(storage)
    await store.load()
    expect(store.snapshot()).toHaveLength(1)
    storage.failRead = true
    await store.load()
    expect(store.snapshot()).toEqual([])
  })

  it("merges per resource with the newest observation winning", async () => {
    const storage = new FakeCapacityStorage(undefined)
    const store = new CapacityReadingStore(storage)
    await store.replace([entry({ observedAt: 2000, usedRatio: 0.7 })])
    // An instance whose sensors saw nothing newer (or nothing at all) must
    // not clobber what the observing instance persisted.
    await store.replace([entry({ observedAt: 1000, usedRatio: 0.1 })])
    await store.replace([])
    expect(store.snapshot()).toEqual([entry({ observedAt: 2000, usedRatio: 0.7 })])

    await store.replace([entry({ observedAt: 3000, usedRatio: 0.9 })])
    expect(store.snapshot()).toEqual([entry({ observedAt: 3000, usedRatio: 0.9 })])
  })

  it("is bounded and evicts the oldest observations first", async () => {
    const storage = new FakeCapacityStorage(undefined)
    const store = new CapacityReadingStore(storage)
    const entries = Array.from({ length: MAX_CAPACITY_READINGS + 5 }, (_, index) =>
      entry({ modelID: `m${String(index)}`, observedAt: 1000 + index }),
    )
    await store.replace(entries)
    const kept = store.snapshot()
    expect(kept).toHaveLength(MAX_CAPACITY_READINGS)
    expect(kept.some((item) => item.key.modelID === "m0")).toBe(false)
    expect(kept[0]?.key.modelID).toBe(`m${String(MAX_CAPACITY_READINGS + 4)}`)
  })

  it("leaves memory unchanged when the write fails", async () => {
    const storage = new FakeCapacityStorage(undefined)
    const store = new CapacityReadingStore(storage)
    await store.replace([entry({ observedAt: 1000 })])
    storage.failWrite = true
    await expect(store.replace([entry({ modelID: "b", observedAt: 2000 })])).rejects.toThrow(
      "write failed",
    )
    expect(store.snapshot()).toEqual([entry({ observedAt: 1000 })])
  })
})
