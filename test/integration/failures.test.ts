/**
 * Fault-injection matrix (T-22, TEST_STRATEGY): every error evidence drives
 * the right horizontal-vs-escalation fork through the real supervisor seams.
 */
import { describe, expect, it } from "vitest"

import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { storedParked, storedReceipts } from "../supervisor/helpers.js"
import {
  StorageClock,
  controlStorage,
  FakeSupervisorSession,
  flush,
  intervalAttempt,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  startTracking,
  wireRef,
} from "./helpers.js"

describe("fault-injection matrix", () => {
  it("recovers horizontally from a definitive rate limit (429)", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
    // Same tier, different resource — horizontal recovery, no escalation.
    expect(receipts[1]?.decision).toMatchObject({
      kind: "apply",
      reason: "fallback",
      model: ref("prov", "b"),
    })
    expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/b"])
  })

  it("waits out a rate-limit window and returns to the preferred resource", async () => {
    const clock = new StorageClock()
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session, clock: clock.tick })
    await startTracking(supervisor, ref("prov", "a"))
    // 429 + Retry-After: a is windowed (rate_limited) for 60s.
    await supervisor.handleReport({
      kind: "http-response",
      sessionID: "s1",
      status: 429,
      retryAfterHeader: "60",
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "fallback",
      model: ref("prov", "b"),
    })
    // Once the window elapses the preferred resource recovers naturally —
    // no failback engine, just fresh routing at the next safe boundary.
    clock.advance(61_000)
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 40 })
    const recovered = parseReceiptsPayload(storedReceipts(storage)).at(-1)
    expect(recovered?.decision).toMatchObject({
      kind: "apply",
      reason: "preferred",
      model: ref("prov", "a"),
    })
  })

  it("opens the breaker after repeated outages and probes after backoff", async () => {
    const clock = new StorageClock()
    const storage = controlStorage()
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session, clock: clock.tick })
    await startTracking(supervisor, ref("prov", "a"))
    // Five decisive 503s trip the breaker on a (threshold 5).
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 200 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // Breaker open, no alternative in the tier: parked (no thundering herd —
    // no probe before the backoff elapses).
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })

    // After the open window elapses the next admission emits a probe.
    clock.advance(40_000)
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 300 })
    const probed = parseReceiptsPayload(storedReceipts(storage)).at(-1)
    const decision = probed?.decision
    expect(decision).toMatchObject({ kind: "apply", reason: "probe", model: ref("prov", "a") })
    if (decision?.kind !== "apply") throw new Error("unreachable")
    expect(decision.evidence.probeId).toEqual(expect.any(String))
  })

  it("recovers horizontally from a timeout (408) through the veto path", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    const input = intervalAttempt(1, 100)
    input.error = { type: "UnknownError", message: "", status: 408 }
    await supervisor.handleRetry(input)
    // Timeout is definitive infrastructure failure: veto native retry and
    // continue the work on the recovery candidate that fresh routing picks.
    // A single 408 only degrades a (no window, breaker closed), so fresh
    // admission legitimately re-selects a — the settle-first continuation
    // still avoids OpenCode's immediate native retry.
    expect(input.decision).toEqual({ retry: false })
    await flush()
    expect(session.log).toEqual([
      "switch:s1:prov/a",
      "wait:s1",
      "switch:s1:prov/a",
      "prompt:s1:Continue the interrupted work from the current session state. Do not repeat completed work; resume from what the session already produced.",
    ])
  })

  it("leaves ambiguous failures (no status) to native retry", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    const input = intervalAttempt(1, 100)
    input.error = { type: "UnknownError", message: "connection reset", status: 0 }
    await supervisor.handleRetry(input)
    // Non-definitive evidence: OpenCode's own retry decision stands.
    expect(input.decision).toEqual({ retry: true, delay: 100 })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("treats malformed 500 responses as unknown (no veto, no health damage)", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "unexpected <!doctype html>", status: 500 },
    })
    const input = intervalAttempt(1, 100)
    input.error = { type: "UnknownError", message: "unexpected <!doctype html>", status: 500 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: true, delay: 100 })
    // Unknown is not infrastructure evidence: the next admission still
    // prefers a (no quarantine, no escalation).
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "preferred",
      model: ref("prov", "a"),
    })
  })

  it("escalates capability failures to the next tier (context rejection)", async () => {
    const storage = controlStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "b")],
      }),
    )
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: {
        type: "UnknownError",
        message:
          "This model's maximum context length is 4096 tokens, but the prompt is 5000 tokens",
        status: 400,
      },
    })
    await flush()
    // Capability evidence — escalation to the next tier, never a horizontal
    // fallback within the same capability.
    expect(session.log).toEqual([
      "switch:s1:prov/a",
      "wait:s1",
      "switch:s1:prov/b",
      "prompt:s1:Continue the interrupted work from the current session state. Do not repeat completed work; resume from what the session already produced.",
    ])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[1]?.decision).toMatchObject({
      kind: "escalate",
      step: "tier",
      tier: "advanced",
      target: ref("prov", "b"),
    })
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
  })
})
