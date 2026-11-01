// covers: ["ADP-019"]
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  admitProbe,
  initialBreaker,
  recordBreakerFailure,
  recordBreakerSuccess,
  recordProbeFailure,
  recordProbeSuccess,
} from "../../../src/health/circuit-breaker/breaker.js"
import {
  BREAKER_EXEMPT_CATEGORIES,
  BREAKER_STATES,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerRecord,
} from "../../../src/health/circuit-breaker/types.js"

const CONFIG: BreakerConfig = {
  failureThreshold: 3,
  baseOpenMs: 1_000,
  maxBackoffMs: 8_000,
}

function tripBreaker(now: number, config: BreakerConfig = CONFIG): BreakerRecord {
  let record = initialBreaker()
  for (let index = 0; index < config.failureThreshold; index += 1) {
    record = recordBreakerFailure(record, "timeout", now, config).record
  }
  return record
}

describe("circuit breaker state machine", () => {
  it("starts closed with no failures", () => {
    expect(initialBreaker()).toEqual({ state: "closed", failures: 0, openCount: 0 })
  })

  it("counts failures without opening below the threshold", () => {
    const record = initialBreaker()
    const first = recordBreakerFailure(record, "outage", 0, CONFIG)
    expect(first).toEqual({ record: { state: "closed", failures: 1, openCount: 0 }, opened: false })
    const second = recordBreakerFailure(first.record, "overload", 0, CONFIG)
    expect(second).toEqual({
      record: { state: "closed", failures: 2, openCount: 0 },
      opened: false,
    })
  })

  it("opens exactly at the threshold with the base backoff window", () => {
    const record = tripBreaker(5_000)
    expect(record.state).toBe("open")
    expect(record.failures).toBe(3)
    expect(record.openCount).toBe(1)
    expect(record.reopenAt).toBe(6_000)
  })

  it("exempts rate limiting and quota exhaustion from counting", () => {
    const record = tripBreaker(0)
    for (const category of BREAKER_EXEMPT_CATEGORIES) {
      expect(recordBreakerFailure(record, category, 0, DEFAULT_BREAKER_CONFIG)).toEqual({
        record,
        opened: false,
      })
    }
  })

  it("ignores failures while open or half-open", () => {
    const open = tripBreaker(0)
    expect(recordBreakerFailure(open, "timeout", 0, CONFIG)).toEqual({
      record: open,
      opened: false,
    })
    const halfOpen = { ...admitProbe(open, 10_000).record, probeId: "p1" }
    expect(recordBreakerFailure(halfOpen, "timeout", 10_000, CONFIG)).toEqual({
      record: halfOpen,
      opened: false,
    })
  })

  describe("admission", () => {
    it("is a no-op while closed", () => {
      const record = initialBreaker()
      expect(admitProbe(record, 0)).toEqual({ kind: "closed", record })
    })

    it("blocks before the reopen time with the remaining delay", () => {
      const open = tripBreaker(5_000)
      expect(admitProbe(open, 5_500)).toEqual({
        kind: "waiting",
        record: open,
        retryAtMs: 500,
      })
    })

    it("admits at and after the reopen time", () => {
      const open = tripBreaker(5_000)
      expect(admitProbe(open, 6_000).kind).toBe("admitted")
      expect(admitProbe(open, 99_000).kind).toBe("admitted")
    })

    it("admits an open breaker whose reopen time is missing (defensive)", () => {
      const open: BreakerRecord = { state: "open", failures: 3, openCount: 1 }
      expect(admitProbe(open, 0).kind).toBe("admitted")
    })

    it("allows exactly one probe while half-open", () => {
      const open = tripBreaker(0)
      const admitted = admitProbe(open, 1_000)
      expect(admitted).toEqual({
        kind: "admitted",
        record: { state: "half_open", failures: 3, openCount: 1 },
      })
      expect(admitProbe(admitted.record, 1_000)).toEqual({
        kind: "in-flight",
        record: admitted.record,
      })
    })
  })

  describe("probe resolution", () => {
    it("closes and resets on a successful probe", () => {
      const open = tripBreaker(0)
      const halfOpen = admitProbe(open, 1_000).record
      expect(recordProbeSuccess(halfOpen)).toEqual({ state: "closed", failures: 0, openCount: 0 })
    })

    it("ignores a success report when no probe is in flight", () => {
      const open = tripBreaker(0)
      expect(recordProbeSuccess(open)).toBe(open)
    })

    it("reopens with a doubled backoff on a failed non-exempt probe", () => {
      const open = tripBreaker(0)
      const halfOpen = admitProbe(open, 1_000).record
      const reopened = recordProbeFailure(halfOpen, "overload", 1_000, CONFIG)
      expect(reopened).toEqual({ state: "open", failures: 3, openCount: 2, reopenAt: 3_000 })
    })

    it("re-arms the same backoff window on an exempt probe failure", () => {
      const open = tripBreaker(0)
      const halfOpen = admitProbe(open, 1_000).record
      const reArmed = recordProbeFailure(halfOpen, "rate_limited", 1_000, CONFIG)
      expect(reArmed).toEqual({ state: "open", failures: 3, openCount: 1, reopenAt: 2_000 })
    })

    it("ignores a failure report when no probe is in flight", () => {
      const open = tripBreaker(0)
      expect(recordProbeFailure(open, "timeout", 0, CONFIG)).toBe(open)
    })
  })

  it("doubles backoff across reopenings and caps it at maxBackoffMs", () => {
    let record = tripBreaker(0)
    const reopenTimes: number[] = [record.reopenAt ?? -1]
    for (let opening = 2; opening <= 10; opening += 1) {
      const previousReopenAt = reopenTimes.at(-1) ?? 0
      const halfOpen = admitProbe(record, previousReopenAt).record
      record = recordProbeFailure(halfOpen, "timeout", previousReopenAt, CONFIG)
      reopenTimes.push(record.reopenAt ?? -1)
      expect(record.openCount).toBe(opening)
    }
    const backoffs = reopenTimes.map((at, index) =>
      index === 0 ? at : at - (reopenTimes.at(index - 1) ?? 0),
    )
    expect(backoffs[0]).toBe(1_000)
    expect(backoffs[1]).toBe(2_000)
    expect(backoffs[2]).toBe(4_000)
    for (const backoff of backoffs.slice(3)) {
      expect(backoff).toBe(8_000)
    }
  })

  it("resets fully when a success closes the breaker", () => {
    const open = tripBreaker(0)
    const halfOpen = admitProbe(open, 1_000).record
    const closed = recordProbeSuccess(halfOpen)
    const reopened = recordBreakerFailure(closed, "timeout", 2_000, CONFIG)
    expect(reopened.record.openCount).toBe(0)
    expect(reopened.opened).toBe(false)
  })

  describe("properties", () => {
    const configArb = fc.record({
      failureThreshold: fc.integer({ min: 1, max: 6 }),
      baseOpenMs: fc.integer({ min: 1, max: 5_000 }),
      maxBackoffMs: fc.integer({ min: 1, max: 60_000 }),
    })
    const categoryArb = fc.constantFrom(
      "rate_limited",
      "quota_exhausted",
      "outage",
      "overload",
      "timeout",
    )

    it("never leaves the breaker in an impossible state", () => {
      const opsArb = fc.array(
        fc.oneof(
          fc.record({ op: fc.constant("failure" as const), category: categoryArb }),
          fc.record({ op: fc.constant("success" as const) }),
          fc.record({ op: fc.constant("admit" as const) }),
          fc.record({ op: fc.constant("probe-failure" as const), category: categoryArb }),
          fc.record({ op: fc.constant("probe-success" as const) }),
        ),
        { maxLength: 40 },
      )
      fc.property(configArb, opsArb, (config, ops) => {
        let record = initialBreaker()
        let now = 0
        for (const op of ops) {
          now += 1
          if (op.op === "failure") {
            const result = recordBreakerFailure(record, op.category, now, config)
            expect(BREAKER_STATES).toContain(result.record.state)
            expect(result.record.failures).toBeGreaterThanOrEqual(0)
            if (BREAKER_EXEMPT_CATEGORIES.includes(op.category)) {
              expect(result.record).toEqual(record)
              expect(result.opened).toBe(false)
            } else if (record.state === "closed") {
              expect(result.record.failures).toBe(record.failures + 1)
              expect(result.opened).toBe(result.record.state === "open")
              if (result.opened) {
                expect(result.record.reopenAt).toBe(
                  now +
                    Math.min(
                      config.baseOpenMs * 2 ** (result.record.openCount - 1),
                      config.maxBackoffMs,
                    ),
                )
              }
            }
            record = result.record
          } else if (op.op === "success") {
            record = recordBreakerSuccess()
            expect(record).toEqual({ state: "closed", failures: 0, openCount: 0 })
          } else if (op.op === "admit") {
            const admission = admitProbe(record, now)
            if (admission.kind === "admitted") {
              expect(record.state).toBe("open")
              expect(admission.record.state).toBe("half_open")
            }
            record = admission.record
          } else if (op.op === "probe-failure") {
            const next = recordProbeFailure(record, op.category, now, config)
            expect(BREAKER_STATES).toContain(next.state)
            if (record.state === "half_open") {
              expect(next.state).toBe("open")
              expect(next.reopenAt).toBe(
                now + Math.min(config.baseOpenMs * 2 ** (next.openCount - 1), config.maxBackoffMs),
              )
            } else {
              expect(next).toBe(record)
            }
            record = next
          } else {
            const next = recordProbeSuccess(record)
            if (record.state === "half_open") {
              expect(next.state).toBe("closed")
            } else {
              expect(next).toBe(record)
            }
            record = next
          }
          expect(BREAKER_STATES).toContain(record.state)
        }
      })
    })
  })
})
