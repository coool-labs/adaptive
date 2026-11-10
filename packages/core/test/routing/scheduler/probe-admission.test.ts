/**
 * Admission through the real health registry (ADP-018, ADP-019, ADP-022): the
 * scheduler and the breaker agree end to end — one probe under a burst of
 * admissions, the herd stays on the next rung of the SAME tier, and a recovered
 * preferred resource returns only through the next admission.
 */
// covers: ["ADP-018", "ADP-019", "ADP-022", "ADP-038"]
import { describe, expect, it } from "vitest"

import { ResourceHealthRegistry } from "../../../src/health/resource-health/registry.js"
import type { Assessment, ProbeTicket } from "../../../src/health/resource-health/types.js"
import { admit, schedulerHealthKey } from "../../../src/routing/scheduler/index.js"
import type { AdmissionDecision, SchedulerInput } from "../../../src/routing/scheduler/index.js"
import { candidateOf, inputOf, keyOf, ref } from "./helpers.js"

const A = ref("sub", "preferred")
const B = ref("paid", "fallback")
const THRESHOLD = 5

function setup(tier = [A, B]) {
  const clock = { now: 1_000_000 }
  const registry = new ResourceHealthRegistry(() => clock.now)
  const admitUnit = (): { decision: AdmissionDecision; tickets: ProbeTicket[] } => {
    const health: Record<string, Assessment> = {}
    const tickets: ProbeTicket[] = []
    for (const model of tier) {
      const assessment = registry.assess(keyOf(model))
      health[schedulerHealthKey(model)] = assessment
      if (assessment.kind === "probe") tickets.push(assessment.ticket)
    }
    const input: SchedulerInput = inputOf({
      inventory: tier.map((model) => candidateOf(model)),
      tierCandidates: tier,
      health,
    })
    return { decision: admit(input), tickets }
  }
  const trip = (model = A): void => {
    for (let index = 0; index < THRESHOLD; index += 1) {
      registry.observe({ kind: "failure", key: keyOf(model), category: "outage", definitive: true })
    }
  }
  return { clock, registry, admitUnit, trip }
}

describe("a burst of admissions over one recovering resource", () => {
  it("sends exactly one probe to the preferred resource and keeps the herd on the next rung", async () => {
    const { clock, admitUnit, trip } = setup()
    trip()
    clock.now += 31_000
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, async () => {
        await Promise.resolve()
        return admitUnit().decision
      }),
    )
    const probes = outcomes.filter((d) => d.kind === "apply" && d.reason === "probe")
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({ kind: "apply", model: A })
    const rest = outcomes.filter((d) => !(d.kind === "apply" && d.reason === "probe"))
    expect(rest).toHaveLength(24)
    for (const decision of rest) {
      expect(decision).toMatchObject({
        kind: "apply",
        model: B,
        tier: "standard",
        reason: "fallback",
      })
    }
  })

  it("parks the rest of the burst when the probed resource is the tier's only rung (no borrowing)", async () => {
    const { clock, admitUnit, trip } = setup([A])
    trip()
    clock.now += 31_000
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await Promise.resolve()
        return admitUnit().decision
      }),
    )
    expect(outcomes.filter((d) => d.kind === "apply")).toHaveLength(1)
    for (const decision of outcomes.filter((d) => d.kind === "park")) {
      expect(decision).toMatchObject({
        kind: "park",
        reason: "all-blocked",
        detail: "probe-in-flight",
      })
    }
    expect(outcomes.filter((d) => d.kind === "park")).toHaveLength(9)
  })
})

describe("the preferred resource returns only through the next admission (ADP-018)", () => {
  it("falls back while a limit holds, then prefers the original at the first admission after the window", () => {
    const { clock, registry, admitUnit } = setup()
    registry.observe({
      kind: "failure",
      key: keyOf(A),
      category: "quota_exhausted",
      definitive: true,
      retryAfterMs: 60_000,
    })
    expect(admitUnit().decision).toMatchObject({ model: B, reason: "fallback" })
    clock.now += 59_999
    expect(admitUnit().decision).toMatchObject({ model: B, reason: "fallback" })
    clock.now += 1
    expect(admitUnit().decision).toMatchObject({ model: A, reason: "preferred" })
  })

  it("a failed probe doubles the backoff and keeps work on the fallback until the next window", () => {
    const { clock, registry, admitUnit, trip } = setup()
    trip()
    clock.now += 30_000
    const first = admitUnit()
    expect(first.decision).toMatchObject({ model: A, reason: "probe" })
    const ticket = first.tickets[0]
    expect(ticket).toBeDefined()
    if (ticket === undefined) return
    expect(registry.reportProbe(ticket, { success: false, category: "outage" })).toBe(true)
    expect(admitUnit().decision).toMatchObject({ model: B, reason: "fallback" })
    clock.now += 59_999
    expect(admitUnit().decision).toMatchObject({ model: B, reason: "fallback" })
    clock.now += 1
    expect(admitUnit().decision).toMatchObject({ model: A, reason: "probe" })
  })

  it("a successful probe makes the preferred resource ordinary again", () => {
    const { clock, registry, admitUnit, trip } = setup()
    trip()
    clock.now += 30_000
    const ticket = admitUnit().tickets[0]
    if (ticket === undefined) throw new Error("expected a probe ticket")
    registry.reportProbe(ticket, { success: true })
    expect(admitUnit().decision).toMatchObject({ model: A, reason: "preferred" })
  })

  it("an unused probe ticket released after another rung won does not wedge the resource", () => {
    const { clock, registry, admitUnit, trip } = setup([A, B])
    trip(B)
    trip(A)
    clock.now += 30_000
    const first = admitUnit()
    expect(first.decision).toMatchObject({ model: A, reason: "probe" })
    // Both breakers were due, so both issued tickets; only A's was dispatched.
    const unused = first.tickets.find((ticket) => ticket.key.modelID === B.id)
    expect(unused).toBeDefined()
    if (unused === undefined) return
    expect(registry.releaseProbe(unused)).toBe(true)
    registry.reportProbe(first.tickets[0] ?? unused, { success: false, category: "outage" })
    expect(admitUnit().decision).toMatchObject({ model: B, reason: "probe" })
  })
})
