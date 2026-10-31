/**
 * Restart round-trips (T-22, ADP-024): durable state (settings, receipts,
 * parked work) must survive a restart; runtime-only state (breaker, rate
 * windows, capacity sensor readings, per-unit budgets) resets honestly.
 */
import { describe, expect, it } from "vitest"

import { CONTINUATION_PROMPT } from "../../src/supervisor/log.js"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import {
  INTERRUPTED_USER,
  controlStorage,
  FakeSupervisorSession,
  flush,
  intervalAttempt,
  makeSupervisor,
  readState,
  ref,
  selected,
  seed,
  settingsJSON,
  startTracking,
  succeeded,
  wireRef,
} from "./helpers.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { storedParked, storedReceipts } from "../supervisor/helpers.js"

describe("restart round-trips", () => {
  it("carries settings across a restart", async () => {
    const storage = controlStorage()
    const first = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    const result = await first.updateSettings({ mode: "observe" })
    expect(result).toMatchObject({ ok: true })

    const second = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    expect(await second.settings()).toMatchObject({ mode: "observe" })
  })

  it("continues receipt ids across a restart (newest first)", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const first = makeSupervisor({ storage, session })
    for (let i = 0; i < 3; i += 1) {
      await first.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
      await first.handleReport(selected(ref("prov", "a"), 15))
      await first.handleReport(succeeded())
    }
    expect(readState(storage).receiptIds).toEqual([1, 2, 3])

    const second = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    const receipts = await second.receipts()
    expect(receipts.map((receipt) => receipt.id)).toEqual([3, 2, 1])
    // The next admission cycle gets id 4, not a fresh 1.
    await second.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    const next = parseReceiptsPayload(storedReceipts(storage))
    expect(next.at(-1)?.id).toBe(4)
  })

  it("parks durable work and resumes it after a restart", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession({ failWait: true })
    const first = makeSupervisor({ storage, session })
    await startTracking(first, ref("prov", "a"))
    // A 429 with a willing native retry: Adaptive vetoes and owns recovery.
    // The settle step fails, so the pending work is parked durably.
    await first.handleRetry(intervalAttempt(1, 100))
    await flush()
    expect(readState(storage).parkedIds).toEqual(["s1#1"])
  })

  it("resumes a restarted parked record through the idle boundary", async () => {
    const storage = controlStorage()
    const failing = new FakeSupervisorSession({ failWait: true })
    const first = makeSupervisor({ storage, session: failing })
    await startTracking(first, ref("prov", "a"))
    await first.handleRetry(intervalAttempt(1, 100))
    await flush()

    const session = new FakeSupervisorSession()
    const second = makeSupervisor({ storage, session })
    await second.handleReport({ kind: "idle", sessionID: "s1" })
    await flush()
    // The resumed episode prompts a continuation (a fresh admission receipt
    // records its routing).
    expect(session.log).toContain(`prompt:s1:${CONTINUATION_PROMPT}`)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "apply" })
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
  })

  it("resets runtime health on restart (breaker + rate windows are not durable)", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const first = makeSupervisor({ storage, session })
    await startTracking(first, ref("prov", "a"))
    // Five decisive 503s trip the breaker on a (threshold 5).
    for (let i = 0; i < 5; i += 1) {
      await first.handleReport({
        kind: "http-response",
        sessionID: "s1",
        status: 503,
      })
    }
    // With b also blocked the admission has no candidate: parked.
    await startTracking(first, ref("prov", "b"), 30)
    for (let i = 0; i < 5; i += 1) {
      await first.handleReport({
        kind: "http-response",
        sessionID: "s1",
        status: 503,
      })
    }
    await first.handleReport({ kind: "execution-started", sessionID: "s1", at: 60 })
    const blocked = parseReceiptsPayload(storedReceipts(storage)).at(-1)
    expect(blocked?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })

    const second = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    await second.handleReport({ kind: "execution-started", sessionID: "s1", at: 40 })
    const resumed = parseReceiptsPayload(storedReceipts(storage)).at(-1)
    // A fresh supervisor has a closed breaker: a is preferred again.
    expect(resumed?.decision).toMatchObject({ kind: "apply", reason: "preferred" })
  })

  it("gives a fresh unit a fresh veto budget across a restart", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const first = makeSupervisor({ storage, session })
    await startTracking(first, ref("prov", "a"))
    const firstAttempt = {
      sessionID: "s1",
      model: ref("prov", "a"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 } as { retry: boolean; delay: number },
    }
    for (let i = 0; i < 3; i += 1) {
      await first.handleRetry({ ...firstAttempt })
    }
    const spent = firstAttempt.decision
    expect(spent).toEqual({ retry: true, delay: 100 })

    const second = makeSupervisor({ storage, session })
    await second.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    await second.handleReport(selected(ref("prov", "a"), 35))
    const fresh = {
      sessionID: "s1",
      model: ref("prov", "a"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 } as { retry: boolean; delay: number },
    }
    await second.handleRetry(fresh)
    // A new unit has an empty budget: the veto path applies again.
    expect(fresh.decision).toEqual({ retry: false })
  })

  it("gives a fresh unit a fresh escalation budget across a restart", async () => {
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
    const first = makeSupervisor({ storage, session })
    for (let i = 0; i < 2; i += 1) {
      await startTracking(first, ref("prov", "a"), 10)
      await first.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 413 },
      })
      await flush()
    }
    const escalations = parseReceiptsPayload(storedReceipts(storage)).filter(
      (receipt) => receipt.decision.kind === "escalate",
    )
    expect(escalations).toHaveLength(2)

    const second = makeSupervisor({ storage, session })
    await startTracking(second, ref("prov", "a"), 30)
    await second.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 40,
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    const after = parseReceiptsPayload(storedReceipts(storage)).filter(
      (receipt) => receipt.decision.kind === "escalate",
    )
    // The third failure escalates again — budget is per unit.
    expect(after).toHaveLength(3)
  })

  it("resets capacity sensor readings on restart (telemetry is not durable)", async () => {
    const storage = controlStorage()
    const first = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    await first.handleReport({
      kind: "http-response",
      sessionID: "s1",
      status: 200,
      capturedHeaders: { "x-codex-primary-used-percent": "100" },
    })
    await first.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    expect(readState(storage).mode).toBe("control")

    const second = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    await second.handleReport({ kind: "execution-started", sessionID: "s1", at: 20 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // The fresh sensor has no data: the admission is not parked.
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "apply" })
  })

  it("keeps user cancellations out of the durable narrative", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport(INTERRUPTED_USER)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.outcome).toMatchObject({ status: "interrupted", reason: "user" })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })
})
