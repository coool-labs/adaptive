// covers: ["ADP-034"]
import { describe, expect, it } from "vitest"
import fc from "fast-check"

import type { Receipt } from "../../../src/state/receipts/index.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc.js"
import {
  DISCONNECTED_ROW_ID,
  modeChoices,
  parseModeValue,
  receiptLines,
  statusRows,
} from "../../../src/ui/gui/view.js"
import type { ModelRef } from "../../../src/core/work-unit/types.js"

function ref(providerID: string, id: string): ModelRef {
  return { providerID, id }
}

function tierResource(
  providerID: string,
  id: string,
  overrides: Partial<TierResourceStatus> = {},
): TierResourceStatus {
  return {
    ref: ref(providerID, id),
    health: "healthy",
    breaker: "closed",
    windowed: false,
    windowUntil: null,
    usedPercent: null,
    resetAt: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    mode: "observe",
    pin: null,
    tiers: { quick: [], standard: [], advanced: [] },
    parked: 0,
    waiting: [],
    receipts: 0,
    ...overrides,
  }
}

function receipt(id: number, overrides: Partial<Receipt> = {}): Receipt {
  return {
    id,
    at: 10,
    sessionID: "s1",
    decision: {
      kind: "apply",
      model: ref("prov", "a"),
      reason: "preferred",
      evidence: { skipped: [] },
    },
    ...overrides,
  }
}

describe("statusRows", () => {
  it("shows a single disconnected row for an undefined snapshot", () => {
    expect(statusRows(undefined)).toEqual([
      { id: DISCONNECTED_ROW_ID, label: "Server", value: "disconnected", tone: "warning" },
    ])
  })

  it("renders mode, pin, tiers, parked and receipts", () => {
    const rows = statusRows(
      snapshot({
        mode: "active",
        pin: ref("prov", "p"),
        tiers: { ...snapshot().tiers, standard: [tierResource("prov", "a")] },
        parked: 2,
        waiting: [],
        receipts: 7,
      }),
    )
    expect(rows.map((row) => row.id)).toEqual([
      "mode",
      "pin",
      "tier-quick",
      "tier-standard",
      "tier-advanced",
      "parked",
      "receipts",
    ])
    expect(rows.find((row) => row.id === "mode")?.value).toBe("active")
    expect(rows.find((row) => row.id === "pin")?.value).toBe("prov/p")
    expect(rows.find((row) => row.id === "tier-quick")?.value).toBe("empty")
    expect(rows.find((row) => row.id === "tier-standard")?.value).toBe("prov/a")
    expect(rows.find((row) => row.id === "parked")?.value).toBe("2")
    expect(rows.find((row) => row.id === "receipts")?.value).toBe("7")
  })

  it("keeps the health tag on tier resources", () => {
    const rows = statusRows(
      snapshot({
        tiers: {
          ...snapshot().tiers,
          quick: [tierResource("prov", "a", { health: "rate_limited", windowed: true })],
        },
      }),
    )
    expect(rows.find((row) => row.id === "tier-quick")?.value).toBe(
      "prov/a [rate_limited, windowed]",
    )
  })

  it("shows pin none when unset", () => {
    const rows = statusRows(snapshot({ pin: null }))
    expect(rows.find((row) => row.id === "pin")?.value).toBe("none")
  })
})

describe("modeChoices", () => {
  it("lists every mode and marks the current one", () => {
    expect(modeChoices("observe")).toEqual([
      { value: "off", title: "off" },
      { value: "observe", title: "observe (current)" },
      { value: "active", title: "active" },
    ])
  })
})

describe("parseModeValue", () => {
  it("accepts known modes and rejects unknown values", () => {
    expect(parseModeValue("active")).toBe("active")
    expect(parseModeValue("bogus")).toBeUndefined()
  })
})

describe("receiptLines", () => {
  it("renders each receipt through the shared decision vocabulary", () => {
    const lines = receiptLines([
      receipt(1),
      receipt(2, { decision: { kind: "defer", reason: "routing-defer" } }),
    ])
    expect(lines).toEqual([
      "#1 apply prov/a (preferred) — pending",
      "#2 defer: routing-defer — pending",
    ])
  })
})

describe("properties", () => {
  it("statusRows is total and deterministic over arbitrary snapshots", () => {
    const modeArb = fc.constantFrom(...(["off", "observe", "active"] as const))
    const refArb = fc.record({
      providerID: fc.string({ minLength: 1 }),
      id: fc.string({ minLength: 1 }),
    })
    const resourceArb = fc.record({
      ref: refArb,
      health: fc.constantFrom("healthy", "degraded", "unavailable"),
      breaker: fc.constantFrom("closed", "open", "half_open"),
      windowed: fc.boolean(),
      windowUntil: fc.option(fc.nat(1_000_000), { nil: null }),
      usedPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      resetAt: fc.option(fc.nat(1_000_000), { nil: null }),
    })
    const snapArb = fc.record({
      mode: modeArb,
      pin: fc.option(refArb, { nil: null }),
      tiers: fc.record({
        quick: fc.array(resourceArb, { maxLength: 3 }),
        standard: fc.array(resourceArb, { maxLength: 3 }),
        advanced: fc.array(resourceArb, { maxLength: 3 }),
      }),
      parked: fc.nat(),
      waiting: fc.constant([]),
      receipts: fc.nat(),
    })
    fc.assert(
      fc.property(fc.option(snapArb, { nil: undefined }), (value) => {
        const first = statusRows(value)
        const second = statusRows(value)
        expect(first).toEqual(second)
        if (value === undefined) {
          expect(first).toHaveLength(1)
        } else {
          expect(first.length).toBeGreaterThanOrEqual(7)
          expect(first.every((row) => row.label.length > 0 && row.value.length > 0)).toBe(true)
        }
      }),
      { numRuns: 200 },
    )
  })

  it("modeChoices always marks exactly one current entry", () => {
    fc.assert(
      fc.property(fc.constantFrom(...(["off", "observe", "active"] as const)), (current) => {
        const marked = modeChoices(current).filter((choice) => choice.title.includes("(current)"))
        expect(marked).toHaveLength(1)
        expect(marked[0]?.value).toBe(current)
      }),
      { numRuns: 20 },
    )
  })
})
