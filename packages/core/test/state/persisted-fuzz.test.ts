/**
 * Persisted-state hardening (ADP-031, ADP-051): every read-side parser survives
 * arbitrarily corrupted copies of a valid payload, stays within its product
 * bound, and reaches a fixed point — what it accepts re-serializes to exactly
 * what it accepts, so a load/save cycle can never grow, drift, or reorder data.
 */
// covers: ["ADP-029", "ADP-030", "ADP-031", "ADP-036", "ADP-051"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { migrateSettings } from "../../src/state/settings/parse.js"
import { MAX_AGENT_TIERS, MAX_TIER_RESOURCES } from "../../src/state/settings/types.js"
import { parseCapacityPayload } from "../../src/state/capacity/parse.js"
import { CAPACITY_VERSION, MAX_CAPACITY_READINGS } from "../../src/state/capacity/types.js"
import { parseHealthPayload } from "../../src/state/health/parse.js"
import { HEALTH_VERSION } from "../../src/state/health/types.js"
import { parseParkedPayload } from "../../src/state/parked-work/parse.js"
import { MAX_PARKED, PARKED_VERSION } from "../../src/state/parked-work/types.js"
import { parseReceiptsPayload } from "../../src/state/receipts/parse.js"
import { MAX_RECEIPTS, RECEIPTS_VERSION } from "../../src/state/receipts/types.js"
import { parseSessionModesPayload } from "../../src/state/session-modes/parse.js"
import {
  MAX_SESSION_MODE_RECORDS,
  SESSION_MODES_VERSION,
} from "../../src/state/session-modes/types.js"
import { parseTierRequestsPayload } from "../../src/state/tier-requests/parse.js"
import {
  MAX_TIER_REQUEST_RECORDS,
  TIER_REQUESTS_VERSION,
} from "../../src/state/tier-requests/types.js"

const JUNK: readonly unknown[] = [
  null,
  undefined,
  true,
  false,
  0,
  -0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  1e308,
  "",
  " ",
  "x".repeat(129),
  "x".repeat(5_000),
  "__proto__",
  "constructor",
  [],
  [null],
  {},
  { __proto__: null },
  JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'),
]

/** Overwrites one value, at a random depth, of a deep copy of `root` with junk. */
function corrupt(root: unknown, picks: readonly number[], junk: readonly number[]): unknown {
  const clone: unknown = structuredClone(root)
  let cursor: unknown = clone
  for (const [index, pick] of picks.entries()) {
    if (typeof cursor !== "object" || cursor === null) break
    const container = cursor as Record<string, unknown>
    const keys = Object.keys(container)
    if (keys.length === 0) break
    const key = keys[pick % keys.length] ?? ""
    const child = container[key]
    const isLast = index === picks.length - 1 || typeof child !== "object" || child === null
    if (isLast) {
      const replacement = JUNK[(junk[index % junk.length] ?? 0) % JUNK.length]
      if (replacement === undefined) Reflect.deleteProperty(container, key)
      else container[key] = replacement
      break
    }
    cursor = child
  }
  return clone
}

const picksArb = fc.array(fc.nat(50), { minLength: 1, maxLength: 7 })
const junkArb = fc.array(fc.nat(100), { minLength: 1, maxLength: 7 })
const corruptionsArb = fc.array(fc.tuple(picksArb, junkArb), { minLength: 0, maxLength: 3 })

function corruptAll(
  seed: unknown,
  corruptions: readonly (readonly [readonly number[], readonly number[]])[],
): unknown {
  return corruptions.reduce((value, [picks, junk]) => corrupt(value, picks, junk), seed)
}

function expectNoPollution(): void {
  expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined()
}

const model = { providerID: "p", id: "m", variant: "high" }
const key = { providerID: "p", accountID: "a", modelID: "m", variantID: "v" }

const HEALTH_SEED = {
  version: HEALTH_VERSION,
  records: [
    {
      key,
      health: "rate_limited",
      breaker: { state: "open", failures: 3, openCount: 2, reopenAt: 99 },
      window: { kind: "rate-limit", until: 500 },
      updatedAt: 100,
    },
    {
      key: { providerID: "q" },
      health: "healthy",
      breaker: { state: "half_open", failures: 5, openCount: 1, probeId: "7", probeAt: 50 },
      updatedAt: 90,
    },
  ],
}

const CAPACITY_SEED = {
  version: CAPACITY_VERSION,
  readings: [
    {
      key,
      reading: {
        usedRatio: 0.9,
        remainingRatio: 0.1,
        retryAfterMs: 1_000,
        resetAt: 5_000,
        confidence: "high",
        observedAt: 1_000,
        evidence: "x-codex headers",
      },
    },
    { key: { providerID: "q" }, reading: { remainingRatio: 0, confidence: "low", observedAt: 2 } },
  ],
}

const SESSION_MODES_SEED = {
  version: SESSION_MODES_VERSION,
  records: [
    { sessionID: "s1", mode: "active", updatedAt: 10 },
    { sessionID: "s2", mode: "off", updatedAt: 20 },
  ],
}

const TIER_REQUESTS_SEED = {
  version: TIER_REQUESTS_VERSION,
  records: [
    { sessionID: "s1", tier: "advanced", updatedAt: 10 },
    { sessionID: "s2", tier: "quick", updatedAt: 20 },
  ],
}

const PARKED_SEED = {
  version: PARKED_VERSION,
  parked: [
    {
      id: "s1#1",
      sessionID: "s1",
      tier: "standard",
      reason: "all-blocked",
      detail: "rate-limited",
      parkedAt: 5,
      attempts: 2,
    },
    { id: "s2#1", sessionID: "s2", tier: "quick", reason: "no-candidates", parkedAt: 6 },
  ],
}

const RECEIPTS_SEED = {
  version: RECEIPTS_VERSION,
  receipts: [
    {
      id: 1,
      at: 10,
      sessionID: "s1",
      unitID: "s1#1",
      tier: "standard",
      decision: {
        kind: "apply",
        model,
        tier: "standard",
        reason: "fallback",
        evidence: { skipped: [{ ref: model, why: "rate-limited" }], probeId: "3" },
      },
      outcome: { status: "failed", category: "outage" },
    },
    {
      id: 2,
      at: 11,
      sessionID: "s1",
      decision: {
        kind: "observe-only",
        would: { kind: "park", reason: "all-blocked", detail: "d" },
      },
    },
    {
      id: 3,
      at: 12,
      sessionID: "s2",
      decision: {
        kind: "escalate",
        target: model,
        step: "tier",
        tier: "advanced",
        evidence: [{ kind: "agent-request", detail: "needs more" }],
        budgetRemaining: 1,
      },
      outcome: { status: "interrupted", reason: "user" },
    },
  ],
}

const SETTINGS_SEED = {
  version: 1,
  mode: "active",
  tiers: { quick: [model], standard: [model, { providerID: "p", id: "m2" }], advanced: [] },
  pin: model,
  agentTiers: { build: "advanced", plan: "quick" },
  inviteDismissed: true,
}

interface Case<T> {
  readonly name: string
  readonly seed: unknown
  readonly parse: (raw: unknown) => readonly T[]
  readonly wrap: (parsed: readonly T[]) => unknown
  readonly cap: number
}

const CASES: readonly Case<unknown>[] = [
  {
    name: "health records",
    seed: HEALTH_SEED,
    parse: parseHealthPayload,
    wrap: (records) => ({ version: HEALTH_VERSION, records }),
    cap: 512,
  },
  {
    name: "capacity readings",
    seed: CAPACITY_SEED,
    parse: parseCapacityPayload,
    wrap: (readings) => ({ version: CAPACITY_VERSION, readings }),
    cap: MAX_CAPACITY_READINGS,
  },
  {
    name: "session modes",
    seed: SESSION_MODES_SEED,
    parse: parseSessionModesPayload,
    wrap: (records) => ({ version: SESSION_MODES_VERSION, records }),
    cap: MAX_SESSION_MODE_RECORDS,
  },
  {
    name: "tier requests",
    seed: TIER_REQUESTS_SEED,
    parse: parseTierRequestsPayload,
    wrap: (records) => ({ version: TIER_REQUESTS_VERSION, records }),
    cap: MAX_TIER_REQUEST_RECORDS,
  },
  {
    name: "parked work",
    seed: PARKED_SEED,
    parse: parseParkedPayload,
    wrap: (parked) => ({ version: PARKED_VERSION, parked }),
    cap: MAX_PARKED,
  },
  {
    name: "receipts",
    seed: RECEIPTS_SEED,
    parse: parseReceiptsPayload,
    wrap: (receipts) => ({ version: RECEIPTS_VERSION, receipts }),
    cap: MAX_RECEIPTS,
  },
]

describe("persisted payload parsers survive corruption", () => {
  it.each(CASES)("$name: the valid seed parses to a non-empty fixed point", (testCase) => {
    const parsed = testCase.parse(testCase.seed)
    expect(parsed.length).toBeGreaterThan(0)
    expect(JSON.stringify(testCase.parse(testCase.wrap(parsed)))).toBe(JSON.stringify(parsed))
  })

  it.each(CASES)("$name: corrupted copies stay bounded and reach a fixed point", (testCase) => {
    const prop = fc.property(corruptionsArb, (corruptions) => {
      const raw = corruptAll(testCase.seed, corruptions)
      const parsed = testCase.parse(raw)
      expect(parsed.length).toBeLessThanOrEqual(testCase.cap)
      const again = testCase.parse(JSON.parse(JSON.stringify(testCase.wrap(parsed))))
      expect(JSON.stringify(again)).toBe(JSON.stringify(parsed))
      expectNoPollution()
    })
    fc.assert(prop, { numRuns: 600 })
  })

  it.each(CASES)("$name: a payload inflated past the cap is cut back to it", (testCase) => {
    const inflated = testCase.wrap(
      Array.from({ length: testCase.cap + 20 }, () => testCase.parse(testCase.seed)[0]),
    )
    expect(testCase.parse(inflated).length).toBeLessThanOrEqual(testCase.cap)
  })
})

describe("settings migration survives corruption", () => {
  it("corrupted copies migrate to bounded, duplicate-free settings that are a fixed point", () => {
    const prop = fc.property(corruptionsArb, (corruptions) => {
      const migrated = migrateSettings(corruptAll(SETTINGS_SEED, corruptions))
      for (const list of Object.values(migrated.tiers)) {
        expect(list.length).toBeLessThanOrEqual(MAX_TIER_RESOURCES)
        const ids = list.map((ref) => JSON.stringify([ref.providerID, ref.id, ref.variant ?? null]))
        expect(new Set(ids).size).toBe(ids.length)
      }
      expect(Object.keys(migrated.agentTiers).length).toBeLessThanOrEqual(MAX_AGENT_TIERS)
      expect(["off", "observe", "active"]).toContain(migrated.mode)
      expect(JSON.stringify(migrateSettings(JSON.parse(JSON.stringify(migrated))))).toBe(
        JSON.stringify(migrated),
      )
      expectNoPollution()
    })
    fc.assert(prop, { numRuns: 600 })
  })
})
