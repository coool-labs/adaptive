/**
 * Decision-review integration scenarios (T-22): receipts tell a truthful
 * narrative; Observe ≡ Control; manual intent wins; mode switches take
 * effect at the next admission.
 */
// covers: ["ADP-002", "ADP-010", "ADP-015", "ADP-021", "ADP-028", "ADP-029", "ADP-030"]
import { describe, expect, it } from "vitest"

import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { storedReceipts } from "../supervisor/helpers.js"
import {
  INTERRUPTED_USER,
  activeStorage,
  FakeSupervisorSession,
  flush,
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
import { makeInfo } from "../adapters/opencode/helpers.js"

describe("decision review", () => {
  it("records the full receipt narrative with outcomes", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport(succeeded())
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
      reason: "preferred",
    })
    expect(receipts[0]?.tier).toBe("standard")
    expect(receipts[0]?.outcome).toEqual({ status: "succeeded" })
  })

  it("decides identically in observe and control modes", async () => {
    const events = (): {
      start: { kind: "execution-started"; sessionID: string; at: number }
      select: {
        kind: "model-selected"
        sessionID: string
        at: number
        model: { providerID: string; id: string }
      }
      fail: {
        kind: "execution-failed"
        sessionID: string
        at: number
        error: { type: string; message: string; status: number }
      }
      next: { kind: "execution-started"; sessionID: string; at: number }
    } => ({
      start: { kind: "execution-started", sessionID: "s1", at: 10 },
      select: { kind: "model-selected", sessionID: "s1", at: 15, model: ref("prov", "a") },
      fail: {
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      },
      next: { kind: "execution-started", sessionID: "s1", at: 30 },
    })

    const observeStorage = activeStorage()
    seed(
      observeStorage,
      SETTINGS_KEY,
      settingsJSON("observe", {
        standard: [wireRef("prov", "a"), wireRef("prov", "b")],
      }),
    )
    const observe = makeSupervisor({
      storage: observeStorage,
      session: new FakeSupervisorSession(),
    })
    const e = events()
    for (const report of [e.start, e.select, e.fail, e.next]) {
      await observe.handleReport(report)
    }

    const activeStorage2 = activeStorage()
    const control = makeSupervisor({
      storage: activeStorage2,
      session: new FakeSupervisorSession(),
    })
    for (const report of [e.start, e.select, e.fail, e.next]) {
      await control.handleReport(report)
    }

    const observeReceipts = parseReceiptsPayload(storedReceipts(observeStorage))
    const controlReceipts = parseReceiptsPayload(storedReceipts(activeStorage2))
    expect(observeReceipts).toHaveLength(2)
    expect(controlReceipts).toHaveLength(2)
    // Same inputs, same decisions — observe only wraps them.
    expect(observeReceipts[0]?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", model: ref("prov", "a") },
    })
    expect(controlReceipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
    })
    expect(observeReceipts[1]?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "fallback", model: ref("prov", "b") },
    })
    expect(controlReceipts[1]?.decision).toMatchObject({
      kind: "apply",
      reason: "fallback",
      model: ref("prov", "b"),
    })
  })

  it("applies a user pin ahead of tier candidates", async () => {
    const storage = activeStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
    )
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    // The pin outranks the tier list: b runs even though a is preferred.
    expect(session.log).toEqual(["switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "b"),
      reason: "pin",
    })
    expect("tier" in (receipts[0] ?? {})).toBe(false)
  })

  it("never fails over a user cancellation", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    await supervisor.handleReport(INTERRUPTED_USER)
    // No continuation, no switch, no veto — the host's decision stands.
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.outcome).toEqual({ status: "interrupted", reason: "user" })
  })

  it("respects a manual switch and falls back only after its failure", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    // The user picks b before the unit starts (no pending self-switch note).
    await supervisor.handleReport(selected(ref("prov", "b"), 5))
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    // Unit 1 tracks b (not reverted); its 429 blocks b, so unit 2 falls
    // back to a within the same tier.
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
    expect(receipts[1]?.decision).toMatchObject({
      kind: "apply",
      reason: "preferred",
      model: ref("prov", "a"),
    })
  })

  it("applies a draining candidate when no ready equivalent exists", async () => {
    const storage = activeStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", {
        standard: [wireRef("openai", "a"), wireRef("prov", "b")],
      }),
    )
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({
      storage,
      session,
      infos: [makeInfo("openai", "a"), makeInfo("prov", "b")],
    })
    // High-confidence near-exhaustion capacity evidence on a (draining).
    // The codex sensor covers providerID "openai" (CODEX_PROVIDER_ID).
    await supervisor.handleReport({
      kind: "http-response",
      sessionID: "s1",
      status: 200,
      capturedHeaders: {
        "x-codex-primary-used-percent": "95",
        "x-codex-primary-reset-after-seconds": "60",
      },
    })
    await startTracking(supervisor, ref("openai", "a"))
    // a is draining, b (different provider, no capacity evidence) is ready:
    // the ready candidate wins.
    expect(session.log).toEqual(["switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      reason: "fallback",
      model: ref("prov", "b"),
    })
  })

  it("carries escalation evidence into the receipt decision", async () => {
    const storage = activeStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "b")],
      }),
    )
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await startTracking(supervisor, ref("prov", "a"))
    expect(supervisor.noteEscalationRequest("s1", "needs larger context", "413 on 200k")).toBe(true)
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    expect(session.log).toEqual([
      "switch:s1:prov/a",
      "wait:s1",
      "switch:s1:prov/b",
      `prompt:s1:${CONTINUATION_PROMPT}`,
    ])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    const decision = receipts[1]?.decision
    expect(decision).toMatchObject({
      kind: "escalate",
      step: "tier",
      tier: "advanced",
      budgetRemaining: 1,
    })
    if (decision?.kind !== "escalate") throw new Error("unreachable")
    expect(decision.evidence).toEqual([
      { kind: "agent-request", detail: "needs larger context: 413 on 200k" },
      { kind: "repeated-failure", detail: "context_overflow" },
    ])
  })

  it("applies a mode switch at the next admission (no lying receipts)", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    // Start in observe: nothing switches.
    await supervisor.updateSettings({ mode: "observe" })
    await startTracking(supervisor, ref("prov", "a"))
    expect(session.log).toEqual([])
    const observeReceipts = parseReceiptsPayload(storedReceipts(storage))
    expect(observeReceipts[0]?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", model: ref("prov", "a") },
    })
    expect(readState(storage).mode).toBe("observe")

    // Flip to control: the NEXT admission applies the model.
    const flipped = await supervisor.updateSettings({ mode: "active" })
    expect(flipped).toMatchObject({ ok: true })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
  })
})
