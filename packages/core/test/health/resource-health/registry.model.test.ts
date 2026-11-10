// covers: ["ADP-007", "ADP-013", "ADP-019", "ADP-024", "ADP-038"]
/**
 * Stateful (model-based) properties of the resource-health registry: arbitrary
 * interleavings of evidence, assessments, probe reports, releases and clock
 * movement must never break the circuit-breaker contract, and the wake planner
 * must agree with what admission will actually do at the planned moment.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { resourceUsableAt } from "../../../src/execution/parking/wake.js"
import { FAILURE_CATEGORIES, type FailureCategory } from "../../../src/health/classifier/types.js"
import { resourceChain, resourceKeyID } from "../../../src/health/resource-health/key.js"
import { ResourceHealthRegistry } from "../../../src/health/resource-health/registry.js"
import type {
  Assessment,
  ProbeTicket,
  ResourceHealthConfig,
  ResourceKey,
  ResourceRecord,
} from "../../../src/health/resource-health/types.js"

const CONFIG: ResourceHealthConfig = {
  breaker: { failureThreshold: 2, baseOpenMs: 1_000, maxBackoffMs: 8_000, probeTimeoutMs: 5_000 },
  defaultRateLimitWindowMs: 500,
  defaultQuotaWindowMs: 3_000,
}

const KEYS: readonly ResourceKey[] = [
  { providerID: "p1" },
  { providerID: "p1", modelID: "a" },
  { providerID: "p1", modelID: "b" },
  { providerID: "p2", modelID: "a" },
  { providerID: "p1", modelID: "a", variantID: "high" },
]
const LEAVES: readonly ResourceKey[] = KEYS.filter((key) => key.modelID !== undefined)

/** Failures that never feed the breaker (ADP-013/019: 429s and requests-level evidence). */
const BREAKER_NEUTRAL: readonly FailureCategory[] = [
  "rate_limited",
  "quota_exhausted",
  "user_cancelled",
  "context_overflow",
  "content_policy",
  "unknown",
]

type Op =
  | {
      readonly op: "fail"
      readonly key: number
      readonly category: FailureCategory
      readonly definitive: boolean
      readonly retryAfterMs: number | undefined
    }
  | { readonly op: "success" | "drain" | "reset"; readonly key: number }
  | { readonly op: "capacity"; readonly key: number; readonly exhausted: boolean }
  | { readonly op: "trip"; readonly key: number }
  | { readonly op: "assess" | "evaluate"; readonly leaf: number }
  | {
      readonly op: "report"
      readonly ticket: number
      readonly ok: boolean
      readonly category: FailureCategory
    }
  | { readonly op: "release"; readonly ticket: number }
  | { readonly op: "advance"; readonly ms: number }

/** Infra failures drive the breaker, so they dominate; the rest still appear. */
const failureCategoryArb: fc.Arbitrary<FailureCategory> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<FailureCategory>("outage", "overload", "timeout") },
  { weight: 3, arbitrary: fc.constantFrom(...FAILURE_CATEGORIES) },
)

const keyIndex = fc.nat(KEYS.length - 1)
const leafIndex = fc.nat(LEAVES.length - 1)

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("fail" as const),
      key: keyIndex,
      category: failureCategoryArb,
      definitive: fc.boolean(),
      retryAfterMs: fc.option(fc.constantFrom(0, 1, 499, 500, 1_000, 4_000), { nil: undefined }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constantFrom("success" as const, "drain" as const, "reset" as const),
      key: keyIndex,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("capacity" as const),
      key: keyIndex,
      exhausted: fc.boolean(),
    }),
  },
  // A full breaker trip (threshold-many infra failures) so probes are reachable.
  { weight: 3, arbitrary: fc.record({ op: fc.constant("trip" as const), key: keyIndex }) },
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constantFrom("assess" as const, "evaluate" as const),
      leaf: leafIndex,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("report" as const),
      ticket: fc.nat(40),
      ok: fc.boolean(),
      category: fc.constantFrom(...FAILURE_CATEGORIES),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("release" as const), ticket: fc.nat(40) }) },
  // Boundary-heavy clock movement: exact window/backoff/probe-timeout edges.
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("advance" as const),
      ms: fc.constantFrom(
        0,
        1,
        499,
        500,
        501,
        999,
        1_000,
        1_001,
        2_000,
        3_000,
        4_999,
        5_000,
        8_000,
        20_000,
      ),
    }),
  },
)

function keyOf(index: number): ResourceKey {
  return KEYS[index % KEYS.length] ?? { providerID: "p1" }
}

function leafOf(index: number): ResourceKey {
  return LEAVES[index % LEAVES.length] ?? { providerID: "p1", modelID: "a" }
}

function assertWellFormed(record: ResourceRecord): void {
  const { breaker } = record
  expect(breaker.failures).toBeGreaterThanOrEqual(0)
  expect(breaker.openCount).toBeGreaterThanOrEqual(0)
  if (breaker.state === "half_open") {
    expect(breaker.probeId).toBeDefined()
    expect(breaker.probeAt).toBeDefined()
  }
  if (breaker.state === "open") {
    expect(breaker.reopenAt).toBeDefined()
    expect(breaker.openCount).toBeGreaterThanOrEqual(1)
  }
  if (breaker.state === "closed") {
    expect(breaker.probeId).toBeUndefined()
  }
  if (record.health === "rate_limited" || record.health === "quota_exhausted") {
    expect(record.window).toBeDefined()
  }
}

function byId(records: readonly ResourceRecord[]): Map<string, ResourceRecord> {
  return new Map(records.map((record) => [resourceKeyID(record.key), record]))
}

describe("ResourceHealthRegistry — model-based sequences", () => {
  it("never admits a second concurrent probe and keeps 429s out of the breaker", () => {
    const prop = fc.property(fc.array(opArb, { minLength: 10, maxLength: 60 }), (ops) => {
      const clock = { now: 10_000 }
      const registry = new ResourceHealthRegistry(() => clock.now, CONFIG)
      const tickets: ProbeTicket[] = []

      for (const step of ops) {
        const before = byId(registry.snapshot())
        switch (step.op) {
          case "fail": {
            const key = keyOf(step.key)
            registry.observe({
              kind: "failure",
              key,
              category: step.category,
              definitive: step.definitive,
              ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
            })
            const prior = before.get(resourceKeyID(key))
            const after = registry.recordFor(key)
            if (BREAKER_NEUTRAL.includes(step.category)) {
              // 429/quota/cancel/request-level evidence leave the breaker alone.
              expect(after?.breaker).toEqual(
                prior?.breaker ?? { state: "closed", failures: 0, openCount: 0 },
              )
            }
            // Transient infra evidence never hard-quarantines a resource.
            if (
              (step.category === "outage" ||
                step.category === "overload" ||
                step.category === "timeout") &&
              prior?.health !== "unavailable"
            ) {
              expect(after?.health).not.toBe("unavailable")
            }
            break
          }
          case "trip":
            for (let index = 0; index < CONFIG.breaker.failureThreshold; index += 1) {
              registry.observe({
                kind: "failure",
                key: keyOf(step.key),
                category: "timeout",
                definitive: true,
              })
            }
            break
          case "success":
          case "drain":
          case "reset":
            registry.observe({ kind: step.op, key: keyOf(step.key) })
            break
          case "capacity":
            registry.observe({ kind: "capacity", key: keyOf(step.key), exhausted: step.exhausted })
            break
          case "evaluate": {
            const snapshotBefore = JSON.stringify(registry.snapshot())
            registry.evaluate(leafOf(step.leaf))
            // The observer view never admits a probe or mutates a breaker.
            expect(JSON.stringify(registry.snapshot())).toBe(snapshotBefore)
            break
          }
          case "assess": {
            const leaf = leafOf(step.leaf)
            const chain = resourceChain(leaf).map((key) => before.get(resourceKeyID(key)))
            const result: Assessment = registry.assess(leaf)
            const liveProbe = chain.some(
              (record) =>
                record?.breaker.state === "half_open" &&
                clock.now - (record.breaker.probeAt ?? 0) < CONFIG.breaker.probeTimeoutMs,
            )
            if (liveProbe) {
              // An unexpired probe anywhere in the chain blocks every descendant.
              expect(result.kind).toBe("blocked")
            }
            const dueOpen = chain.some(
              (record) =>
                record?.breaker.state === "open" && (record.breaker.reopenAt ?? 0) > clock.now,
            )
            if (dueOpen) {
              expect(result.kind).toBe("blocked")
            }
            if (result.kind === "probe") {
              const ticketRecord = registry.recordFor(result.ticket.key)
              expect(ticketRecord?.breaker.state).toBe("half_open")
              expect(ticketRecord?.breaker.probeId).toBe(result.ticket.id)
              expect(tickets.some((issued) => issued.id === result.ticket.id)).toBe(false)
              const prior = before.get(resourceKeyID(result.ticket.key))
              if (prior?.breaker.state === "half_open") {
                // Re-admitting over an old probe is legal only once it expired.
                expect(clock.now - (prior.breaker.probeAt ?? 0)).toBeGreaterThanOrEqual(
                  CONFIG.breaker.probeTimeoutMs,
                )
              }
              tickets.push(result.ticket)
            }
            break
          }
          case "report": {
            const ticket = tickets[step.ticket % Math.max(tickets.length, 1)]
            if (ticket === undefined) break
            const honored = registry.reportProbe(
              ticket,
              step.ok ? { success: true } : { success: false, category: step.category },
            )
            if (honored) {
              // A ticket resolves at most once: replaying it is rejected.
              expect(registry.reportProbe(ticket, { success: true })).toBe(false)
              expect(registry.recordFor(ticket.key)?.breaker.state).not.toBe("half_open")
            }
            break
          }
          case "release": {
            const ticket = tickets[step.ticket % Math.max(tickets.length, 1)]
            if (ticket === undefined) break
            if (registry.releaseProbe(ticket)) {
              expect(registry.releaseProbe(ticket)).toBe(false)
              expect(registry.reportProbe(ticket, { success: true })).toBe(false)
            }
            break
          }
          case "advance":
            clock.now += step.ms
            break
        }
        for (const record of registry.snapshot()) assertWellFormed(record)
        // At most one live probe per breaker: a record is half_open under only
        // the most recently issued ticket for its scope.
        const liveByScope = new Map<string, string>()
        for (const record of registry.snapshot()) {
          if (record.breaker.state === "half_open" && record.breaker.probeId !== undefined) {
            liveByScope.set(resourceKeyID(record.key), record.breaker.probeId)
          }
        }
        for (const [scope, probeId] of liveByScope) {
          const issuedForScope = tickets.filter((ticket) => resourceKeyID(ticket.key) === scope)
          expect(issuedForScope[issuedForScope.length - 1]?.id).toBe(probeId)
        }
      }
    })
    expect(fc.check(prop, { numRuns: 250 }).failed).toBe(false)
  })

  it("the wake planner agrees with admission: blocked until the planned moment, usable at it", () => {
    const prop = fc.property(
      fc.array(opArb, { minLength: 10, maxLength: 40 }),
      leafIndex,
      (ops, leafPick) => {
        const clock = { now: 10_000 }
        const registry = new ResourceHealthRegistry(() => clock.now, CONFIG)
        for (const step of ops) {
          switch (step.op) {
            case "fail":
              registry.observe({
                kind: "failure",
                key: keyOf(step.key),
                category: step.category,
                definitive: step.definitive,
                ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
              })
              break
            case "trip":
              for (let index = 0; index < CONFIG.breaker.failureThreshold; index += 1) {
                registry.observe({
                  kind: "failure",
                  key: keyOf(step.key),
                  category: "timeout",
                  definitive: true,
                })
              }
              break
            case "success":
            case "drain":
            case "reset":
              registry.observe({ kind: step.op, key: keyOf(step.key) })
              break
            case "capacity":
              registry.observe({
                kind: "capacity",
                key: keyOf(step.key),
                exhausted: step.exhausted,
              })
              break
            case "assess":
              registry.assess(leafOf(step.leaf))
              break
            case "advance":
              clock.now += step.ms
              break
            default:
              break
          }
        }
        const leaf = leafOf(leafPick)
        const chain = resourceChain(leaf).map((key) => registry.recordFor(key))
        const usableAt = resourceUsableAt(chain, null, clock.now)

        // Replay the state on a probe-free clone so the check cannot disturb the run.
        const probe = { now: clock.now }
        const clone = new ResourceHealthRegistry(() => probe.now, CONFIG)
        clone.restore(registry.snapshot())

        if (usableAt === undefined) return
        expect(usableAt).toBeGreaterThanOrEqual(clock.now)
        const hardOrBreaker = (assessment: Assessment): boolean =>
          assessment.kind === "blocked" &&
          (assessment.reason === "unavailable" ||
            assessment.reason === "quota-exhausted" ||
            assessment.reason === "rate-limited" ||
            assessment.reason === "breaker-open")
        if (usableAt > clock.now) {
          // Still blocked one millisecond before the planned moment…
          probe.now = usableAt - 1
          const early = new ResourceHealthRegistry(() => probe.now, CONFIG)
          early.restore(registry.snapshot())
          expect(hardOrBreaker(early.evaluate(leaf))).toBe(true)
        }
        // …and no longer hard-blocked at it (a due breaker admits its probe).
        probe.now = usableAt
        expect(hardOrBreaker(clone.assess(leaf))).toBe(false)
      },
    )
    expect(fc.check(prop, { numRuns: 250 }).failed).toBe(false)
  })
})
