// covers: ["ADP-009", "ADP-010", "ADP-011", "ADP-019", "ADP-059"]
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { afterEach, beforeEach, expect, it } from "vitest"
import { assessCandidates, observeOutcome, releaseUnselected, withHealth } from "../src/health.js"
import { jsonFile } from "../src/store.js"

const A: ModelRef = { providerID: "local", id: "a" }
const B: ModelRef = { providerID: "local", id: "b" }
const OUTAGE = { stopReason: "error", errorMessage: "503 status code (no body)" }
const BREAKER_TRIPS = 5
const BREAKER_OPEN_MS = 30_000

let dir = ""
let now = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "adaptive-health-"))
  now = 1_000
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// One Pi process: its own registry instance per transaction, its own probe ids.
function peer(name: string) {
  let next = 0
  return {
    file: jsonFile(join(dir, "health.json"), () => now),
    clock: () => now,
    newId: () => {
      next += 1
      return `${name}-${String(next)}`
    },
  }
}

async function tripBreaker(shared: ReturnType<typeof peer>, ref: ModelRef): Promise<void> {
  await withHealth(shared, (registry) => {
    for (let failure = 0; failure < BREAKER_TRIPS; failure += 1)
      observeOutcome(registry, ref, OUTAGE)
  })
}

it("persists observations so another process's admission sees them", async () => {
  await withHealth(peer("one"), (registry) => {
    observeOutcome(registry, A, {
      stopReason: "error",
      errorMessage: "429 Rate limit reached for requests per min",
    })
  })
  const assessed = await withHealth(peer("two"), (registry) => assessCandidates(registry, [A, B]))
  expect(assessed.health[schedulerHealthKey(A)]).toMatchObject({
    kind: "blocked",
    reason: "rate-limited",
  })
  expect(assessed.health[schedulerHealthKey(B)]).toEqual({ kind: "available" })
  expect(assessed.tickets).toEqual([])
})

it("admits exactly one probe across processes sharing the file", async () => {
  const one = peer("one")
  const two = peer("two")
  await tripBreaker(one, A)
  now += BREAKER_OPEN_MS
  const [first, second] = await Promise.all([
    withHealth(one, (registry) => assessCandidates(registry, [A])),
    withHealth(two, (registry) => assessCandidates(registry, [A])),
  ])
  const outcomes = [first, second]
    .map((assessed) => assessed.health[schedulerHealthKey(A)]?.kind)
    .sort()
  expect(outcomes).toEqual(["blocked", "probe"])
  expect([...first.tickets, ...second.tickets]).toHaveLength(1)
})

it("hands unselected probe tickets back and keeps the dispatched one", async () => {
  const shared = peer("one")
  await tripBreaker(shared, A)
  await tripBreaker(shared, B)
  now += BREAKER_OPEN_MS
  await withHealth(shared, (registry) => {
    const { tickets } = assessCandidates(registry, [A, B])
    // Widest-first breaker scan issues tickets per candidate.
    expect(tickets.map((ticket) => ticket.key.modelID)).toEqual(["a", "b"])
    releaseUnselected(registry, tickets, B)
    expect(registry.recordFor({ providerID: "local", modelID: "a" })?.breaker.state).toBe("open")
    expect(registry.recordFor({ providerID: "local", modelID: "b" })?.breaker.state).toBe(
      "half_open",
    )
  })
  await withHealth(shared, (registry) => {
    const { tickets } = assessCandidates(registry, [A])
    releaseUnselected(registry, tickets, undefined)
    expect(registry.recordFor({ providerID: "local", modelID: "a" })?.breaker.state).toBe("open")
  })
})

it("reports a failed probe and closes the breaker on any success", async () => {
  const shared = peer("one")
  await tripBreaker(shared, A)
  now += BREAKER_OPEN_MS
  await withHealth(shared, (registry) => {
    assessCandidates(registry, [A])
    observeOutcome(registry, A, OUTAGE)
    expect(registry.recordFor({ providerID: "local", modelID: "a" })?.breaker.state).toBe("open")
  })
  now += 10 * BREAKER_OPEN_MS
  await withHealth(shared, (registry) => {
    expect(assessCandidates(registry, [A]).tickets).toHaveLength(1)
    observeOutcome(registry, A, { stopReason: "stop" })
    expect(registry.recordFor({ providerID: "local", modelID: "a" })).toMatchObject({
      health: "healthy",
      breaker: { state: "closed" },
    })
  })
})

it("never treats a user cancellation as provider evidence", async () => {
  await withHealth(peer("one"), (registry) => {
    observeOutcome(registry, A, { stopReason: "aborted", errorMessage: "503 Service Unavailable" })
    expect(registry.snapshot()).toEqual([])
  })
})

it("starts from an empty registry when the payload is foreign", async () => {
  await writeFile(join(dir, "health.json"), JSON.stringify({ version: 99, records: "nope" }))
  const assessed = await withHealth(peer("one"), (registry) => assessCandidates(registry, [A]))
  expect(assessed.health[schedulerHealthKey(A)]).toEqual({ kind: "available" })
})
