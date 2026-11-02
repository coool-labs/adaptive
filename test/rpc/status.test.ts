// covers: ["ADP-030", "ADP-036"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { buildStatus } from "../../src/rpc/status.js"
import type { ResourceRecord } from "../../src/health/resource-health/types.js"
import { resourceKeyID } from "../../src/health/resource-health/index.js"
import type { CapacityReading } from "../../src/health/capacity/types.js"
import { schedulerHealthKey } from "../../src/core/scheduler/index.js"
import type { SettingsV1 } from "../../src/state/settings/index.js"
import { defaultSettings } from "../../src/state/settings/index.js"
import type { ModelRef } from "../../src/core/work-unit/types.js"

function ref(providerID: string, id: string, variant?: string): ModelRef {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

function record(
  key: { providerID: string; modelID: string; variantID?: string },
  overrides: Partial<ResourceRecord> = {},
): ResourceRecord {
  return {
    key,
    health: "degraded",
    breaker: { state: "closed", failures: 0, openCount: 0 },
    updatedAt: 10,
    ...overrides,
  }
}

function reading(overrides: Partial<CapacityReading> = {}): CapacityReading {
  return { confidence: "high", observedAt: 5, ...overrides }
}

describe("buildStatus", () => {
  it("defaults missing records to healthy/closed/unwindowed", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, standard: [ref("prov", "a")] },
    }
    const snapshot = buildStatus({ settings, health: [], capacity: {}, parked: 0, receipts: 0 })
    expect(snapshot.mode).toBe("observe")
    expect(snapshot.pin).toBeNull()
    expect(snapshot.tiers.standard).toEqual([
      {
        ref: ref("prov", "a"),
        health: "healthy",
        breaker: "closed",
        windowed: false,
        windowUntil: null,
        usedPercent: null,
        resetAt: null,
      },
    ])
    expect(snapshot.tiers.quick).toEqual([])
    expect(snapshot.tiers.advanced).toEqual([])
  })

  it("maps health, breaker, and window state by scheduler key", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, standard: [ref("prov", "a"), ref("prov", "b", "high")] },
    }
    const health = [
      record(
        { providerID: "prov", modelID: "a" },
        { health: "rate_limited", window: { kind: "rate-limit", until: 99 } },
      ),
      record(
        { providerID: "prov", modelID: "b", variantID: "high" },
        { health: "healthy", breaker: { state: "open", failures: 5, openCount: 1, reopenAt: 50 } },
      ),
    ]
    const snapshot = buildStatus({ settings, health, capacity: {}, parked: 2, receipts: 7 })
    const [a, b] = snapshot.tiers.standard
    expect(a).toEqual({
      ref: ref("prov", "a"),
      health: "rate_limited",
      breaker: "closed",
      windowed: true,
      windowUntil: 99,
      usedPercent: null,
      resetAt: null,
    })
    expect(b).toEqual({
      ref: ref("prov", "b", "high"),
      health: "healthy",
      breaker: "open",
      windowed: false,
      // null, not undefined: the host RPC encoder rejects present-but-undefined keys.
      windowUntil: null,
      usedPercent: null,
      resetAt: null,
    })
    expect(snapshot.parked).toBe(2)
    expect(snapshot.receipts).toBe(7)
  })

  it("keys records with the same canonical key the scheduler uses", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, quick: [ref("p", "m", "v")] },
    }
    const health = [record({ providerID: "p", modelID: "m", variantID: "v" })]
    const snapshot = buildStatus({ settings, health, capacity: {}, parked: 0, receipts: 0 })
    expect(snapshot.tiers.quick[0]?.health).toBe("degraded")
  })

  it("prefers the last record for a duplicated key (snapshot has unique keys)", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: { ...defaultSettings().tiers, standard: [ref("p", "m")] },
    }
    const health = [
      record({ providerID: "p", modelID: "m" }, { health: "degraded" }),
      record({ providerID: "p", modelID: "m" }, { health: "unavailable" }),
    ]
    const snapshot = buildStatus({ settings, health, capacity: {}, parked: 0, receipts: 0 })
    expect(snapshot.tiers.standard[0]?.health).toBe("unavailable")
  })

  it("is total over arbitrary record lists", () => {
    const healthArb = fc.array(
      fc.record({
        providerID: fc.string({ minLength: 1, maxLength: 5 }),
        modelID: fc.string({ minLength: 1, maxLength: 5 }),
        variantID: fc.option(fc.string({ minLength: 1, maxLength: 5 }), { nil: undefined }),
        health: fc.constantFrom(
          "healthy",
          "degraded",
          "rate_limited",
          "quota_exhausted",
          "unavailable",
          "draining",
        ),
        breaker: fc.constantFrom("closed", "open", "half_open"),
      }) as fc.Arbitrary<{
        providerID: string
        modelID: string
        variantID?: string
        health: ResourceRecord["health"]
        breaker: ResourceRecord["breaker"]["state"]
      }>,
      { maxLength: 5 },
    )
    const refArb = fc.record({
      providerID: fc.string({ minLength: 1, maxLength: 5 }),
      id: fc.string({ minLength: 1, maxLength: 5 }),
      variant: fc.option(fc.string({ minLength: 1, maxLength: 5 }), { nil: undefined }),
    }) as fc.Arbitrary<ModelRef>
    fc.assert(
      fc.property(fc.array(refArb, { maxLength: 5 }), healthArb, (refs, records) => {
        const settings: SettingsV1 = {
          ...defaultSettings(),
          tiers: { ...defaultSettings().tiers, standard: refs },
        }
        const health = records.map((r) =>
          record(
            {
              providerID: r.providerID,
              modelID: r.modelID,
              ...(r.variantID === undefined ? {} : { variantID: r.variantID }),
            },
            {
              health: r.health,
              breaker: { state: r.breaker, failures: 0, openCount: 0 },
            },
          ),
        )
        const snapshot = buildStatus({ settings, health, capacity: {}, parked: 1, receipts: 2 })
        expect(snapshot.tiers.standard).toHaveLength(refs.length)
        for (const entry of snapshot.tiers.standard) {
          expect(typeof entry.health).toBe("string")
          expect(typeof entry.windowed).toBe("boolean")
          expect(
            resourceKeyID({
              providerID: entry.ref.providerID,
              modelID: entry.ref.id,
              variantID: entry.ref.variant,
            }),
          ).toBe(schedulerHealthKey(entry.ref))
        }
      }),
      { numRuns: 100 },
    )
  })

  it("maps capacity readings into usedPercent and resetAt", () => {
    const settings: SettingsV1 = {
      ...defaultSettings(),
      tiers: {
        ...defaultSettings().tiers,
        standard: [ref("prov", "a"), ref("prov", "b"), ref("prov", "c"), ref("prov", "d")],
      },
    }
    const snapshot = buildStatus({
      settings,
      health: [],
      capacity: {
        [schedulerHealthKey(ref("prov", "a"))]: reading({ usedRatio: 0.724, resetAt: 1234 }),
        [schedulerHealthKey(ref("prov", "b"))]: reading({ remainingRatio: 0.25 }),
        [schedulerHealthKey(ref("prov", "c"))]: reading({}),
        [schedulerHealthKey(ref("prov", "d"))]: null,
      },
      parked: 0,
      receipts: 0,
    })
    const [a, b, c, d] = snapshot.tiers.standard
    expect(a).toEqual({
      ref: ref("prov", "a"),
      health: "healthy",
      breaker: "closed",
      windowed: false,
      windowUntil: null,
      usedPercent: 72,
      resetAt: 1234,
    })
    expect(b?.usedPercent).toBe(75)
    expect(b?.resetAt).toBeNull()
    expect(c?.usedPercent).toBeNull()
    expect(c?.resetAt).toBeNull()
    expect(d?.usedPercent).toBeNull()
    expect(d?.resetAt).toBeNull()
  })
})
