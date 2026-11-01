/**
 * Receipt module tests (ADP-030): bounded ring retention, monotonic ids
 * across restart, structural bounding (the no-secrets invariant), outcome
 * attachment, and total read-side parsing (ADP-031 discipline for state).
 */
// covers: ["ADP-030", "ADP-051"]
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  APPLY_REASONS,
  ESCALATION_EVIDENCE_KINDS,
  ESCALATION_STEPS,
  MAX_EVIDENCE_SKIPPED,
  PARK_REASONS,
  SKIP_REASONS,
  SCHEDULER_DEFER_REASONS,
} from "../../../src/core/scheduler/types.js"
import type {
  ApplyDecision,
  Decision,
  SkippedCandidate,
} from "../../../src/core/scheduler/types.js"
import { TIERS } from "../../../src/core/tier-policy/types.js"
import {
  MAX_RECEIPTS,
  MAX_RECEIPT_TEXT,
  RECEIPTS_KEY,
  RECEIPTS_VERSION,
  ReceiptStore,
  boundDecision,
  boundText,
  parseReceiptsPayload,
} from "../../../src/state/receipts/index.js"
import type {
  Receipt,
  ReceiptInput,
  ReceiptsPayload,
  ReceiptsStorage,
} from "../../../src/state/receipts/index.js"

class FakeReceiptsStorage implements ReceiptsStorage {
  #raw: unknown = undefined
  #failRead = false
  #failWrite = false
  writes = 0
  lastPayload: ReceiptsPayload | undefined

  constructor(raw?: unknown) {
    this.#raw = raw
  }

  failRead(): void {
    this.#failRead = true
  }

  failWrite(): void {
    this.#failWrite = true
  }

  read(): Promise<unknown> {
    if (this.#failRead) return Promise.reject(new Error("storage read failed"))
    return Promise.resolve(this.#raw)
  }

  write(payload: ReceiptsPayload): Promise<void> {
    this.writes += 1
    this.lastPayload = payload
    if (this.#failWrite) return Promise.reject(new Error("storage write failed"))
    this.#raw = payload
    return Promise.resolve()
  }
}

function ref(providerID: string, id: string, variant?: string) {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

function applyDecision(overrides: Partial<ApplyDecision> = {}): Decision {
  return {
    kind: "apply",
    model: ref("p", "m"),
    tier: "standard",
    reason: "preferred",
    evidence: { skipped: [{ ref: ref("p", "m2"), why: "rate-limited" }] },
    ...overrides,
  }
}

function input(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    at: 1_000,
    sessionID: "s",
    unitID: "s#1",
    tier: "standard",
    decision: applyDecision(),
    ...overrides,
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}

const longText = "x".repeat(MAX_RECEIPT_TEXT + 50)

describe("receipt constants", () => {
  test("pinned product constants", () => {
    expect(RECEIPTS_KEY).toBe("coool.adaptive/receipts")
    expect(RECEIPTS_VERSION).toBe(1)
    expect(MAX_RECEIPTS).toBe(200)
    expect(MAX_RECEIPT_TEXT).toBe(128)
  })
})

describe("boundText / boundDecision", () => {
  test("truncates over-long free text", () => {
    expect(boundText(longText)).toBe("x".repeat(MAX_RECEIPT_TEXT))
    expect(boundText("short")).toBe("short")
  })

  test("bounds defer/park detail without touching vocab", () => {
    const defer = boundDecision({ kind: "defer", reason: "routing-defer", detail: longText })
    expect(defer).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "x".repeat(MAX_RECEIPT_TEXT),
    })
    const park = boundDecision({ kind: "park", reason: "all-blocked", detail: longText })
    expect(park).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "x".repeat(MAX_RECEIPT_TEXT),
    })
  })

  test("bounds apply refs, probe id, and skipped refs", () => {
    const decision = applyDecision({
      model: ref(longText, "m", longText),
      evidence: {
        skipped: [{ ref: ref(longText, "m2"), why: "rate-limited" }],
        probeId: longText,
      },
    })
    const bounded = boundDecision(decision)
    if (bounded.kind !== "apply") throw new Error("expected apply")
    expect(bounded.model.providerID).toHaveLength(MAX_RECEIPT_TEXT)
    expect(bounded.model.variant).toHaveLength(MAX_RECEIPT_TEXT)
    expect(bounded.evidence.skipped[0]?.ref.providerID).toHaveLength(MAX_RECEIPT_TEXT)
    expect(bounded.evidence.probeId).toHaveLength(MAX_RECEIPT_TEXT)
    expect(decision).toEqual(
      applyDecision({
        model: ref(longText, "m", longText),
        evidence: {
          skipped: [{ ref: ref(longText, "m2"), why: "rate-limited" }],
          probeId: longText,
        },
      }),
    )
  })

  test("bounds escalate evidence detail and nested observe-only", () => {
    const escalate: Decision = {
      kind: "escalate",
      target: ref("p", "m", "high"),
      step: "variant",
      tier: "standard",
      evidence: [{ kind: "agent-request", detail: longText }],
      budgetRemaining: 2,
    }
    const bounded = boundDecision({ kind: "observe-only", would: escalate })
    if (bounded.kind !== "observe-only") throw new Error("expected observe-only")
    if (bounded.would.kind !== "escalate") throw new Error("expected escalate")
    expect(bounded.would.evidence[0]?.detail).toHaveLength(MAX_RECEIPT_TEXT)
  })

  test("returns deeply nested observe-only decisions unchanged at the depth cap", () => {
    const nested: Decision = {
      kind: "observe-only",
      would: { kind: "observe-only", would: applyDecision({ model: ref(longText, "m") }) },
    }
    const atCap = boundDecision(nested, 2)
    expect(atCap).toBe(nested)
  })
})

describe("parseReceiptsPayload", () => {
  const validReceipt: Receipt = {
    id: 3,
    at: 1_000,
    sessionID: "s",
    unitID: "s#1",
    tier: "standard",
    decision: applyDecision(),
    outcome: { status: "failed", category: "rate_limited" },
  }

  test("round-trips a versioned payload", () => {
    const payload = { version: 1, receipts: [validReceipt] }
    expect(parseReceiptsPayload(payload)).toEqual([validReceipt])
  })

  test("accepts a versionless draft array", () => {
    expect(parseReceiptsPayload([validReceipt])).toEqual([validReceipt])
  })

  test("rejects other versions, non-payloads, and non-array receipts", () => {
    expect(parseReceiptsPayload({ version: 2, receipts: [validReceipt] })).toEqual([])
    expect(parseReceiptsPayload({ version: "1", receipts: [validReceipt] })).toEqual([])
    expect(parseReceiptsPayload({ version: 1, receipts: "nope" })).toEqual([])
    expect(parseReceiptsPayload("junk")).toEqual([])
    expect(parseReceiptsPayload(null)).toEqual([])
    expect(parseReceiptsPayload(42)).toEqual([])
  })

  test("drops invalid receipts", () => {
    const broken: unknown[] = [
      { ...validReceipt, id: -1 },
      { ...validReceipt, id: 1.5 },
      { ...validReceipt, at: -5 },
      { ...validReceipt, at: Number.POSITIVE_INFINITY },
      { ...validReceipt, sessionID: "" },
      { ...validReceipt, sessionID: undefined },
      { ...validReceipt, decision: { kind: "unknown" } },
      { ...validReceipt, decision: undefined },
      null,
      "receipt",
    ]
    expect(parseReceiptsPayload({ version: 1, receipts: broken })).toEqual([])
  })

  test("keeps receipts with invalid optional fields, minus the field", () => {
    const parsedTier = parseReceiptsPayload([{ ...validReceipt, tier: "massive" }])
    expect(parsedTier).toEqual([{ ...validReceipt, tier: undefined }])
    const outcomeInvalid: unknown[] = [
      { ...validReceipt, outcome: { status: "failed", category: "made-up" } },
      { ...validReceipt, outcome: { status: "interrupted", reason: "sneaky" } },
      { ...validReceipt, outcome: { status: "exploded" } },
    ]
    const parsed = parseReceiptsPayload({ version: 1, receipts: outcomeInvalid })
    expect(parsed).toHaveLength(3)
    for (const receipt of parsed) {
      expect(receipt.outcome).toBeUndefined()
    }
  })

  test("validates decision vocabularies on read", () => {
    const badReason = { ...validReceipt, decision: { ...applyDecision(), reason: "because" } }
    const badSkip: unknown = {
      ...validReceipt,
      decision: {
        kind: "apply",
        model: ref("p", "m"),
        tier: "standard",
        reason: "preferred",
        evidence: { skipped: [{ ref: ref("p", "m2"), why: "vibes" }] },
      },
    }
    const badDefer: unknown = {
      ...validReceipt,
      decision: { kind: "defer", reason: "made-up" },
    }
    const badPark: unknown = {
      ...validReceipt,
      decision: { kind: "park", reason: "made-up" },
    }
    const badEscalate: unknown = {
      ...validReceipt,
      decision: {
        kind: "escalate",
        target: ref("p", "m"),
        step: "leap",
        tier: "standard",
        evidence: [],
        budgetRemaining: -1,
      },
    }
    const parsed = parseReceiptsPayload({
      version: 1,
      receipts: [badReason, badSkip, badDefer, badPark, badEscalate],
    })
    // An invalid skip entry is dropped, but the apply record survives with
    // the remaining evidence; a bad decision-level vocabulary drops it.
    expect(parsed).toHaveLength(1)
    const decision = parsed[0]?.decision
    expect(decision).toEqual(applyDecision({ evidence: { skipped: [] } }))
  })

  test("drops receipts with malformed decision sub-structures, keeps the rest", () => {
    const base = { at: 1, sessionID: "s", unitID: "s#1", tier: "standard" }
    const malformed: unknown[] = [
      // evidence is not a record
      {
        ...base,
        id: 1,
        decision: { kind: "apply", model: ref("p", "m"), reason: "preferred", evidence: "junk" },
      },
      // skipped is not an array
      {
        ...base,
        id: 2,
        decision: {
          kind: "apply",
          model: ref("p", "m"),
          reason: "preferred",
          evidence: { skipped: "junk" },
        },
      },
      // skipped entry is not a record
      {
        ...base,
        id: 3,
        decision: {
          kind: "apply",
          model: ref("p", "m"),
          reason: "preferred",
          evidence: { skipped: ["junk"] },
        },
      },
      // skip reason is not a string (parseVocab non-string path)
      {
        ...base,
        id: 4,
        decision: {
          kind: "apply",
          model: ref("p", "m"),
          reason: "preferred",
          evidence: { skipped: [{ ref: ref("p", "m"), why: 5 }] },
        },
      },
      // escalate evidence is not an array
      {
        ...base,
        id: 5,
        decision: {
          kind: "escalate",
          target: ref("p", "m"),
          step: "variant",
          tier: "standard",
          evidence: "junk",
          budgetRemaining: 1,
        },
      },
      // escalate evidence entry is not a record → dropped, record survives
      {
        ...base,
        id: 6,
        decision: {
          kind: "escalate",
          target: ref("p", "m"),
          step: "variant",
          tier: "standard",
          evidence: ["junk"],
          budgetRemaining: 1,
        },
      },
      // escalate evidence kind is unknown → dropped, record survives
      {
        ...base,
        id: 7,
        decision: {
          kind: "escalate",
          target: ref("p", "m"),
          step: "variant",
          tier: "standard",
          evidence: [{ kind: "made-up" }],
          budgetRemaining: 1,
        },
      },
      // outcome is not a record
      { ...base, id: 8, decision: applyDecision(), outcome: "junk" },
      // outcome category is not a string
      { ...base, id: 9, decision: applyDecision(), outcome: { status: "failed", category: 42 } },
      // valid outcomes survive a read
      { ...base, id: 10, decision: applyDecision(), outcome: { status: "succeeded" } },
      {
        ...base,
        id: 11,
        decision: applyDecision(),
        outcome: { status: "interrupted", reason: "user" },
      },
    ]
    const parsed = parseReceiptsPayload(malformed)
    // id 1 (evidence non-record), id 2 (skipped non-array), id 5 (escalate
    // evidence non-array) drop; everything else degrades gracefully.
    expect(parsed.map((receipt) => receipt.id)).toEqual([3, 4, 6, 7, 8, 9, 10, 11])
    const firstApply = parsed[0]?.decision
    if (firstApply?.kind !== "apply") throw new Error("expected apply")
    expect(firstApply.evidence.skipped).toEqual([])
    const escalateEvidence = parsed[2]?.decision
    const escalateKind = parsed[3]?.decision
    if (escalateEvidence?.kind !== "escalate" || escalateKind?.kind !== "escalate") {
      throw new Error("expected escalate decisions")
    }
    expect(escalateEvidence.evidence).toEqual([])
    expect(escalateKind.evidence).toEqual([])
    expect(parsed[4]?.outcome).toBeUndefined()
    expect(parsed[5]?.outcome).toBeUndefined()
    expect(parsed[6]?.outcome).toEqual({ status: "succeeded" })
    expect(parsed[7]?.outcome).toEqual({ status: "interrupted", reason: "user" })
  })

  test("re-bounds free text on read and drops empty identifiers", () => {
    const receipt = {
      ...validReceipt,
      decision: { kind: "defer", reason: "routing-defer", detail: longText },
      unitID: "",
    }
    const parsed = parseReceiptsPayload({ version: 1, receipts: [receipt] })
    expect(parsed).toHaveLength(1)
    const decision = parsed[0]?.decision
    expect(decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "x".repeat(MAX_RECEIPT_TEXT),
    })
    expect(parsed[0]?.unitID).toBeUndefined()
  })

  test("applies skipped-evidence and escalate-evidence caps", () => {
    const manySkips: SkippedCandidate[] = Array.from({ length: 12 }, (_, index) => ({
      ref: ref("p", `m${String(index)}`),
      why: "rate-limited",
    }))
    const withSkips = applyDecision({ evidence: { skipped: manySkips } })
    const manyEvidence = Array.from({ length: 9 }, () => ({
      kind: "agent-request" as const,
    }))
    const escalate: Decision = {
      kind: "escalate",
      target: ref("p", "m"),
      step: "tier",
      tier: "advanced",
      evidence: manyEvidence,
      budgetRemaining: 1,
    }
    const parsed = parseReceiptsPayload([
      { ...validReceipt, id: 1, decision: withSkips },
      { ...validReceipt, id: 2, decision: escalate },
    ])
    const first = parsed[0]?.decision
    const second = parsed[1]?.decision
    if (first?.kind !== "apply" || second?.kind !== "escalate") {
      throw new Error("expected apply and escalate")
    }
    expect(first.evidence.skipped).toHaveLength(MAX_EVIDENCE_SKIPPED)
    expect(second.evidence).toHaveLength(4)
  })

  test("drops observe-only nesting beyond the read depth", () => {
    const oneLevel: Decision = { kind: "observe-only", would: applyDecision() }
    const twoLevels: Decision = { kind: "observe-only", would: oneLevel }
    const threeLevels: Decision = { kind: "observe-only", would: twoLevels }
    const parsed = parseReceiptsPayload([
      { ...validReceipt, id: 1, decision: oneLevel },
      { ...validReceipt, id: 2, decision: twoLevels },
      { ...validReceipt, id: 3, decision: threeLevels },
    ])
    expect(parsed.map((receipt) => receipt.id)).toEqual([1, 2])
    expect(parsed[0]?.decision.kind).toBe("observe-only")
    expect(parsed[1]?.decision.kind).toBe("observe-only")
  })

  test("keeps the newest receipts at the cap", () => {
    const many = Array.from({ length: MAX_RECEIPTS + 10 }, (_, index) => ({
      ...validReceipt,
      id: index,
    }))
    const parsed = parseReceiptsPayload({ version: 1, receipts: many })
    expect(parsed).toHaveLength(MAX_RECEIPTS)
    expect(parsed[0]?.id).toBe(10)
    expect(parsed[MAX_RECEIPTS - 1]?.id).toBe(MAX_RECEIPTS + 9)
  })
})

describe("ReceiptStore", () => {
  test("records with monotonic ids in insertion order", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    const first = await store.record(input({ unitID: "s#1" }))
    const second = await store.record(
      input({ unitID: "s#2", decision: { kind: "defer", reason: "routing-defer" } }),
    )
    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
    expect(store.snapshot().map((receipt) => receipt.id)).toEqual([1, 2])
    expect(storage.writes).toBe(2)
  })

  test("bounds the stored decision", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(
      input({ decision: { kind: "park", reason: "all-blocked", detail: longText } }),
    )
    const decision = storage.lastPayload?.receipts[0]?.decision
    expect(decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "x".repeat(MAX_RECEIPT_TEXT),
    })
  })

  test("evicts the oldest beyond the cap and keeps id monotonicity", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    for (let index = 0; index < MAX_RECEIPTS + 5; index += 1) {
      await store.record(input({ unitID: `s#${String(index)}` }))
    }
    const snapshot = store.snapshot()
    expect(snapshot).toHaveLength(MAX_RECEIPTS)
    expect(snapshot[0]?.id).toBe(6)
    expect(snapshot[MAX_RECEIPTS - 1]?.id).toBe(MAX_RECEIPTS + 5)
    const next = await store.record(input())
    expect(next.id).toBe(MAX_RECEIPTS + 6)
  })

  test("attachOutcome updates matching receipts once (first outcome wins)", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input({ unitID: "s#1", decision: applyDecision() }))
    await store.record(
      input({
        unitID: "s#1",
        decision: {
          kind: "escalate",
          target: ref("p", "m"),
          step: "variant",
          tier: "standard",
          evidence: [],
          budgetRemaining: 1,
        },
      }),
    )
    await store.record(input({ unitID: "s#2" }))
    const updated = await store.attachOutcome(
      { sessionID: "s", unitID: "s#1" },
      { status: "succeeded" },
    )
    expect(updated).toBe(2)
    const outcomes = store.snapshot().map((receipt) => receipt.outcome)
    expect(outcomes).toEqual([{ status: "succeeded" }, { status: "succeeded" }, undefined])
    const again = await store.attachOutcome(
      { sessionID: "s", unitID: "s#1" },
      { status: "failed", category: "outage" },
    )
    expect(again).toBe(0)
    expect(store.snapshot()[0]?.outcome).toEqual({ status: "succeeded" })
  })

  test("attachOutcome without unitID matches only unitless receipts", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input({ unitID: undefined }))
    await store.record(input({ unitID: "s#1" }))
    const updated = await store.attachOutcome(
      { sessionID: "s" },
      { status: "interrupted", reason: "shutdown" },
    )
    expect(updated).toBe(1)
    expect(store.snapshot()[0]?.outcome).toEqual({ status: "interrupted", reason: "shutdown" })
    expect(store.snapshot()[1]?.outcome).toBeUndefined()
  })

  test("attachOutcome with no match does not write", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input())
    const writesBefore = storage.writes
    const updated = await store.attachOutcome({ sessionID: "other" }, { status: "succeeded" })
    expect(updated).toBe(0)
    expect(storage.writes).toBe(writesBefore)
  })

  test("load round-trips receipts and continues ids across restart", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    const kept = await store.record(input())
    await store.record(input({ unitID: "s#2" }))
    const restarted = new ReceiptStore(storage)
    await restarted.load()
    expect(restarted.snapshot()).toEqual(store.snapshot())
    const next = await restarted.record(input({ unitID: "s#3" }))
    expect(next.id).toBe(3)
    expect(kept.id).toBe(1)
  })

  test("load degrades to empty on read failure or garbage", async () => {
    const failing = new FakeReceiptsStorage()
    failing.failRead()
    const store = new ReceiptStore(failing)
    await store.load()
    expect(store.snapshot()).toEqual([])
    const garbage = new ReceiptStore(new FakeReceiptsStorage("junk"))
    await garbage.load()
    expect(garbage.snapshot()).toEqual([])
  })

  test("record write failure propagates but keeps the receipt in memory", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    storage.failWrite()
    const pending = store.record(input())
    await expect(pending).rejects.toThrow("storage write failed")
    expect(store.snapshot()).toHaveLength(1)
  })

  test("attachOutcome write failure propagates", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input())
    storage.failWrite()
    const pending = store.attachOutcome({ sessionID: "s", unitID: "s#1" }, { status: "succeeded" })
    await expect(pending).rejects.toThrow("storage write failed")
  })
})

describe("receipt properties", () => {
  const freeText = fc.string({ minLength: 0, maxLength: 200 })
  // Identifiers are non-empty on the write path (host data); free text may be "".
  const identifier = fc.string({ minLength: 1, maxLength: 200 })
  const refArb = fc.record({
    providerID: identifier,
    id: identifier,
    variant: fc.option(identifier, { nil: undefined }),
  })
  const skipArb = fc.record({
    ref: refArb,
    why: fc.constantFrom(...SKIP_REASONS),
  })
  const applyArb = fc
    .record({
      kind: fc.constant("apply" as const),
      model: refArb,
      tier: fc.option(fc.constantFrom(...TIERS), { nil: undefined }),
      reason: fc.constantFrom(...APPLY_REASONS),
      skipped: fc.array(skipArb, { maxLength: 3 }),
      probeId: fc.option(freeText, { nil: undefined }),
    })
    .map((raw) => ({
      kind: raw.kind,
      model: raw.model,
      ...(raw.tier !== undefined ? { tier: raw.tier } : {}),
      reason: raw.reason,
      evidence: {
        skipped: raw.skipped,
        ...(raw.probeId !== undefined ? { probeId: raw.probeId } : {}),
      },
    }))
  const deferArb = fc
    .record({
      kind: fc.constant("defer" as const),
      reason: fc.constantFrom(...SCHEDULER_DEFER_REASONS),
      detail: fc.option(freeText, { nil: undefined }),
    })
    .map((raw) => ({
      kind: raw.kind,
      reason: raw.reason,
      ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
    }))
  const parkArb = fc
    .record({
      kind: fc.constant("park" as const),
      reason: fc.constantFrom(...PARK_REASONS),
      detail: fc.option(freeText, { nil: undefined }),
    })
    .map((raw) => ({
      kind: raw.kind,
      reason: raw.reason,
      ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
    }))
  const escalateArb: fc.Arbitrary<Decision> = fc
    .record({
      kind: fc.constant("escalate" as const),
      target: refArb,
      step: fc.constantFrom(...ESCALATION_STEPS),
      tier: fc.constantFrom(...TIERS),
      evidence: fc.array(
        fc.record({
          kind: fc.constantFrom(...ESCALATION_EVIDENCE_KINDS),
          detail: fc.option(freeText, { nil: undefined }),
        }),
        { maxLength: 4 },
      ),
      budgetRemaining: fc.nat({ max: 10 }),
    })
    .map((raw) => ({
      kind: raw.kind,
      target: raw.target,
      step: raw.step,
      tier: raw.tier,
      evidence: raw.evidence.map((item) => ({
        kind: item.kind,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
      })),
      budgetRemaining: raw.budgetRemaining,
    }))
  const coreArb = fc.oneof(applyArb, deferArb, parkArb, escalateArb)
  const decisionArb = fc.option(
    fc.record({ kind: fc.constant("observe-only" as const), would: coreArb }),
    { nil: undefined },
  )
  const inputArb = fc
    .record({
      at: fc.nat({ max: 2 ** 40 }),
      sessionID: identifier,
      unitID: fc.option(identifier, { nil: undefined }),
      tier: fc.option(fc.constantFrom(...TIERS), { nil: undefined }),
      core: coreArb,
      wrapped: decisionArb,
    })
    .map((raw) => {
      const decision: Decision = raw.wrapped ?? raw.core
      return {
        at: raw.at,
        sessionID: raw.sessionID,
        ...(raw.unitID !== undefined ? { unitID: raw.unitID } : {}),
        ...(raw.tier !== undefined ? { tier: raw.tier } : {}),
        decision,
      }
    })

  test("every stored string is bounded and round-trips through storage (no-secrets invariant)", async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (receiptInput) => {
        const storage = new FakeReceiptsStorage()
        const store = new ReceiptStore(storage)
        const receipt = await store.record(receiptInput)
        const round = JSON.parse(JSON.stringify(receipt)) as unknown
        for (const value of collectStrings(round)) {
          expect(value.length).toBeLessThanOrEqual(MAX_RECEIPT_TEXT)
        }
        const parsed = parseReceiptsPayload(storage.lastPayload)
        expect(parsed).toEqual([receipt])
      }),
      { numRuns: 300 },
    )
  })

  test("parse is total over arbitrary values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const parsed = parseReceiptsPayload(raw)
        expect(Array.isArray(parsed)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe("ReceiptStore.adoptUnit", () => {
  test("stamps the opened unit onto the session's pending unit-less receipts", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input({ unitID: undefined, decision: applyDecision() }))
    await store.record(input({ unitID: "s#9" }))
    const updated = await store.adoptUnit("s", "s#1")
    expect(updated).toBe(1)
    const snapshot = store.snapshot()
    expect(snapshot[0]?.unitID).toBe("s#1")
    expect(snapshot[1]?.unitID).toBe("s#9")
    expect(storage.writes).toBe(3)
  })

  test("leaves receipts that already carry a unit or an outcome alone", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    const withOutcome = await store.record(input({ unitID: undefined, decision: applyDecision() }))
    await store.attachOutcome({ sessionID: "s" }, { status: "succeeded" })
    await store.record(input({ unitID: "s#1" }))
    await store.record(input({ sessionID: "other" }))
    const pending = await store.record(input({ unitID: undefined, decision: applyDecision() }))
    const updated = await store.adoptUnit("s", "s#2")
    expect(updated).toBe(1)
    const snapshot = store.snapshot()
    expect(snapshot.find((r) => r.id === withOutcome.id)?.unitID).toBeUndefined()
    expect(snapshot.find((r) => r.id === withOutcome.id)?.outcome).toEqual({ status: "succeeded" })
    expect(snapshot.find((r) => r.id === pending.id)?.unitID).toBe("s#2")
    expect(storage.writes).toBe(6)
  })
})

describe("ReceiptStore.adoptUnit (no match)", () => {
  test("stamps nothing and writes nothing when the session has no pending receipts", async () => {
    const storage = new FakeReceiptsStorage()
    const store = new ReceiptStore(storage)
    await store.record(input({ unitID: undefined }))
    const updated = await store.adoptUnit("other", "other#1")
    expect(updated).toBe(0)
    expect(storage.writes).toBe(1)
  })
})
