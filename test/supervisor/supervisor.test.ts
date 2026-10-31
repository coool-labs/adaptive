/**
 * Supervisor wiring tests (T-17). Every scenario drives the public entry
 * points (`handleReport`, `handleRetry`) with structural reports and observes
 * the effects through the session call log and the persisted storage
 * payloads (receipts/parked are parsed back from storage — the stores are
 * private by design).
 */
import { describe, expect, it, vi } from "vitest"

import type { ModelSource } from "../../src/adapters/opencode/inventory.js"
import type { OperatingMode } from "../../src/core/scheduler/types.js"
import type { SupervisorSessionSource } from "../../src/supervisor/types.js"

import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { RECEIPTS_KEY } from "../../src/state/receipts/types.js"
import { PARKED_KEY } from "../../src/state/parked-work/types.js"
import { Supervisor } from "../../src/supervisor/index.js"
import { CODEX_PROVIDER_ID } from "../../src/supervisor/types.js"
import { CONTINUATION_PROMPT } from "../../src/supervisor/log.js"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import {
  controlStorage,
  FailAfterStorage,
  FakeSupervisorSession,
  flush,
  KeyFailStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  storedParked,
  storedReceipts,
  storedSettings,
} from "./helpers.js"

/** Capture fail-open logging without polluting test output. */
function spyErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, "error").mockImplementation((first: unknown) => {
    lines.push(String(first))
  })
  return {
    lines,
    restore: (): void => {
      spy.mockRestore()
    },
  }
}

const STARTED_S1 = { kind: "execution-started", sessionID: "s1", at: 10 } as const

describe("supervisor", () => {
  it("pins CODEX_PROVIDER_ID to the ChatGPT/Codex provider", () => {
    expect(CODEX_PROVIDER_ID).toBe("openai")
  })

  it("is inert in OFF mode (no switch, no receipts, retry untouched)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("off", { standard: [wireRef("prov", "a")] }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    const retryInput = {
      sessionID: "s1",
      model: ref("prov", "a"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 },
    }
    await supervisor.handleRetry(retryInput)
    expect(session.log).toEqual([])
    expect(storedReceipts(storage)).toBeUndefined()
    expect(retryInput.decision).toEqual({ retry: true, delay: 100 })
  })

  it("records an observe-only defer receipt on a fresh install (empty tiers)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, "coool.adaptive/settings", settingsJSON("observe"))
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.decision).toEqual({
      kind: "observe-only",
      would: { kind: "defer", reason: "routing-defer", detail: "tier-not-configured" },
    })
  })

  it("applies the preferred tier model in control mode with a receipt", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "apply",
      model: ref("prov", "a"),
      tier: "standard",
      reason: "preferred",
      evidence: { skipped: [] },
    })
    expect(receipts[0]?.tier).toBe("standard")
  })

  it("applies an explicit pin even with empty tiers", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, "coool.adaptive/settings", settingsJSON("control", {}, wireRef("prov", "b")))
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual(["switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "apply",
      model: ref("prov", "b"),
      reason: "pin",
      evidence: { skipped: [] },
    })
    expect(receipts[0]?.tier).toBeUndefined()
  })

  it("falls back to the next healthy candidate after a rate-limit failure", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 15,
      model: ref("prov", "a"),
    })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "slow down", status: 429 },
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[1]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "b"),
      reason: "fallback",
    })
  })

  it("attaches a failed outcome to the admission receipt", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.outcome).toEqual({ status: "failed", category: "rate_limited" })
  })

  it("attaches an interrupted outcome for user cancellation without health damage", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: 20,
      reason: "user",
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.outcome).toEqual({ status: "interrupted", reason: "user" })
    // No health observation: model a stays healthy and is preferred again.
    expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/a"])
  })

  it("records a receipt for unknown interruption reasons but leaves the unit open", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: 20,
      reason: "mystery",
    })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.outcome).toBeUndefined()
    // The unit is still open: a later success closes it and attaches the outcome.
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 30 })
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after[0]?.outcome).toEqual({ status: "succeeded" })
  })

  it("observes a success so a previously open circuit-breaker closes", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("control", { standard: [wireRef("prov", "b")] }),
    )
    const supervisor = makeSupervisor({ storage, session, infos: [makeInfo("prov", "b")] })
    // Trip the breaker (threshold 5 outage failures) while no unit is active.
    for (let index = 0; index < 5; index += 1) {
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 5,
        model: ref("prov", "b"),
      })
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    expect(session.log).toEqual([])
    const parked = parseReceiptsPayload(storedReceipts(storage))
    expect(parked[0]?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })
    // A success on the still-active unit clears the breaker.
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 20 })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    expect(session.log).toContain("switch:s1:prov/b")
  })

  it("parks the admission decision when capacity is exhausted (codex headers)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("control", { standard: [wireRef("openai", "a")] }),
    )
    const supervisor = makeSupervisor({ storage, session, infos: [makeInfo("openai", "a")] })
    await supervisor.handleReport({
      kind: "http-response",
      sessionID: "s1",
      status: 200,
      capturedHeaders: { "x-codex-primary-used-percent": "100" },
    })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })
    // A later response without captured headers must NOT clear the sensor.
    await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 200 })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    const again = parseReceiptsPayload(storedReceipts(storage))
    expect(again[1]?.decision).toMatchObject({ kind: "park" })
  })

  it("defers with a receipt when the inventory itself fails (fail-open)", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const model = {
      transform: () => Promise.reject(new Error("inventory unavailable")),
    } as unknown as ModelSource
    const supervisor = new Supervisor({
      session: session.source as unknown as SupervisorSessionSource,
      model,
      storage: storage.source,
      clock: () => 1000,
    })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
  })

  it("still applies the model when the receipts store cannot write", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage(RECEIPTS_KEY)
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("control", { standard: [wireRef("prov", "a")] }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(storedReceipts(storage)).toBeUndefined()
  })

  describe("retry hook", () => {
    it("vetoes native retry and owns horizontal recovery (settle → switch → prompt)", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      await flush()
      expect(input.decision).toEqual({ retry: false })
      expect(session.log).toEqual([
        "switch:s1:prov/a",
        "wait:s1",
        "switch:s1:prov/b",
        `prompt:s1:${CONTINUATION_PROMPT}`,
      ])
    })

    it("stops vetoing after the per-unit budget is spent", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      const retryInput = (): {
        sessionID: string
        model: { providerID: string; id: string }
        error: { type: string; message: string; status: number; retryAfterMs?: number }
        attempt: number
        decision: { retry: true; delay: number }
      } => ({
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      })
      const fourth = retryInput()
      for (let index = 0; index < 3; index += 1) {
        await supervisor.handleRetry(retryInput())
        await flush()
      }
      await supervisor.handleRetry(fourth)
      await flush()
      expect(fourth.decision).toEqual({ retry: false })
      // Four vetoes spent the budget: the fifth invocation leaves native retry.
      const fifth = retryInput()
      await supervisor.handleRetry(fifth)
      await flush()
      expect(fifth.decision).toEqual({ retry: true, delay: 100 })
      // Admission switch + four owned-recovery switches.
      expect(session.log.filter((entry) => entry.startsWith("switch:"))).toHaveLength(5)
    })

    it("leaves native retry untouched for non-definitive evidence", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "mystery" },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      await flush()
      expect(input.decision).toEqual({ retry: true, delay: 100 })
      // The admission switch happened at episode start; nothing else runs.
      expect(session.log).toEqual(["switch:s1:prov/a"])
    })

    it("leaves native retry untouched when no same-tier candidate exists", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        "coool.adaptive/settings",
        settingsJSON("control", { standard: [wireRef("prov", "a")] }),
      )
      const supervisor = makeSupervisor({ storage, session, infos: [makeInfo("prov", "a")] })
      await supervisor.handleReport(STARTED_S1)
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      await flush()
      expect(input.decision).toEqual({ retry: true, delay: 100 })
      // The admission switch happened at episode start; nothing else runs.
      expect(session.log).toEqual(["switch:s1:prov/a"])
    })

    it("leaves native retry untouched for capability failures (auth)", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 401 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      await flush()
      expect(input.decision).toEqual({ retry: true, delay: 100 })
      // The admission switch happened at episode start; nothing else runs.
      expect(session.log).toEqual(["switch:s1:prov/a"])
    })

    it("parks the unit durably when owned recovery ops fail", async () => {
      const session = new FakeSupervisorSession({ failWait: true })
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      await flush()
      expect(input.decision).toEqual({ retry: false })
      const parked = parseParkedPayload(storedParked(storage))
      expect(parked).toHaveLength(1)
      expect(parked[0]).toMatchObject({
        id: "s1#1",
        sessionID: "s1",
        tier: "standard",
        reason: "all-blocked",
        detail: "continuation failed",
      })
    })
  })

  describe("parked-work resume at the idle boundary", () => {
    function seedParked(storage: KeyFailStorage, parkedAt = 5): void {
      seed(storage, PARKED_KEY, {
        version: 1,
        parked: [
          { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt },
        ],
      })
    }

    it("resumes a parked unit in control mode (pop + continuation prompt)", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([`prompt:s1:${CONTINUATION_PROMPT}`])
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
    })

    it("records an observe-only decision and stays parked in observe mode", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        "coool.adaptive/settings",
        settingsJSON("observe", { standard: [wireRef("prov", "a")] }),
      )
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toEqual({
        kind: "observe-only",
        would: {
          kind: "apply",
          model: ref("prov", "a"),
          tier: "standard",
          reason: "preferred",
          evidence: { skipped: [] },
        },
      })
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    })

    it("stays parked with a receipt when admission still has no usable resource", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      // Block both candidates before the idle boundary.
      for (const id of ["a", "b"]) {
        await supervisor.handleReport({
          kind: "model-selected",
          sessionID: "s1",
          at: 5,
          model: ref("prov", id),
        })
        await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 429 })
      }
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts.at(-1)?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    })

    it("drops the parked record when the session is gone", async () => {
      const session = new FakeSupervisorSession({ failGet: true })
      const storage = controlStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
    })

    it("re-parks with a fresh timestamp when the resume prompt fails", async () => {
      const session = new FakeSupervisorSession({ failPrompt: true })
      const storage = controlStorage()
      seedParked(storage, 5)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      const parked = parseParkedPayload(storedParked(storage))
      expect(parked).toHaveLength(1)
      expect(parked[0]?.parkedAt).toBe(1000)
    })
  })

  describe("work-unit model tracking", () => {
    it("seeds a new unit from the last external model selection", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 5,
        model: ref("prov", "b"),
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
      // Admission still applies a (tier policy), but the unit runs seeded with b.
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      // The 429 was attributed to b (the unit's model), so a stays preferred.
      expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/a"])
    })
  })

  describe("fail-open boundaries and evidence branches", () => {
    const STARTED = { kind: "execution-started", sessionID: "s1", at: 10 } as const

    /** A versioned parked-work payload with explicit records. */
    function parkedPayload(records: Record<string, unknown>[]): unknown {
      return { version: 1, parked: records }
    }

    function retryInput429(): {
      sessionID: string
      model: { providerID: string; id: string }
      error: { type: string; message: string; status: number; retryAfterMs?: number }
      attempt: number
      decision: { retry: boolean; delay: number }
    } {
      return {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
    }

    it("logs and continues when a report handler throws (fail-open)", async () => {
      const errors = spyErrors()
      const supervisor = makeSupervisor({
        storage: controlStorage(),
        session: new FakeSupervisorSession(),
      })
      const hostile = {} as { kind: string }
      Object.defineProperty(hostile, "kind", {
        get() {
          throw new Error("malformed report")
        },
      })
      await supervisor.handleReport(hostile as Parameters<Supervisor["handleReport"]>[0])
      expect(errors.lines[0]).toContain("[coool.adaptive] report:")
      errors.restore()
    })

    it("logs and leaves the decision when the veto path throws (fail-open)", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const supervisor = makeSupervisor({ storage: controlStorage(), session })
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleRetry(Object.freeze(input))
      expect(errors.lines[0]).toContain("[coool.adaptive] retry:")
      errors.restore()
    })

    it("tracks a model-request report for later attribution", async () => {
      const session = new FakeSupervisorSession()
      const supervisor = makeSupervisor({ storage: controlStorage(), session })
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "b"),
        requestKind: "primary",
      })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      // The 429 was attributed to b (reported via model-request), so a stays healthy.
      expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/a"])
    })

    it("leaves the retry decision when recovery admission fails", async () => {
      const errors = spyErrors()
      const storage = controlStorage()
      const model = {
        transform: () => Promise.reject(new Error("inventory unavailable")),
      } as unknown as ModelSource
      const supervisor = new Supervisor({
        session: new FakeSupervisorSession().source as unknown as SupervisorSessionSource,
        model,
        storage: storage.source,
        clock: () => 1000,
      })
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      expect(input.decision).toEqual({ retry: true, delay: 100 })
      expect(errors.lines[0]).toContain("[coool.adaptive] recovery:")
      errors.restore()
    })

    it("logs the park failure when a failed continuation cannot be parked", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failWait: true })
      const storage = new KeyFailStorage(PARKED_KEY)
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleRetry({
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      })
      await flush()
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] parked:")
      errors.restore()
    })

    it("logs when dropping a dead session's parked record fails", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failGet: true })
      const storage = new KeyFailStorage(PARKED_KEY)
      seed(
        storage,
        PARKED_KEY,
        parkedPayload([
          { id: "s9#1", sessionID: "s9", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        ]),
      )
      seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] parked:")
      errors.restore()
    })

    it("gives up on a parked record when its resume admission fails", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      seed(
        storage,
        PARKED_KEY,
        parkedPayload([
          { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        ]),
      )
      const model = {
        transform: () => Promise.reject(new Error("inventory unavailable")),
      } as unknown as ModelSource
      const supervisor = new Supervisor({
        session: session.source as unknown as SupervisorSessionSource,
        model,
        storage: storage.source,
        clock: () => 1000,
      })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] resume:")
      errors.restore()
    })

    it("keeps working when popping a parked record fails to persist", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage(PARKED_KEY)
      seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
      seed(
        storage,
        PARKED_KEY,
        parkedPayload([
          { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        ]),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] parked:")
      errors.restore()
    })

    it("logs when re-parking after a failed resume prompt fails", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failPrompt: true })
      const storage = new FailAfterStorage(PARKED_KEY, 1)
      seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
      seed(
        storage,
        PARKED_KEY,
        parkedPayload([
          { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        ]),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      // First PARKED_KEY write (the resume pop) succeeded; the re-park failed,
      // so the last persisted payload no longer contains the record.
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] parked:")
      const parked = parseParkedPayload(storedParked(storage))
      expect(parked).toHaveLength(0)
      errors.restore()
    })

    it("logs when attaching an outcome fails to persist", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage(RECEIPTS_KEY)
      seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] receipts:")
      errors.restore()
    })

    it("records a pin-unverifiable receipt without a tier", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { standard: [wireRef("prov", "a")] }, wireRef("prov", "zzz")),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toMatchObject({ kind: "defer", reason: "pin-unverifiable" })
      expect("tier" in (receipts[0] as object)).toBe(false)
    })

    it("attaches nothing when a terminal event has no active unit", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 10 })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 11,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      await supervisor.handleReport({
        kind: "execution-interrupted",
        sessionID: "s1",
        at: 12,
        reason: "user",
      })
      expect(storedReceipts(storage)).toBeUndefined()
    })

    it("honors retryAfterMs from a failed execution as the rate-limit window", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429, retryAfterMs: 5000 },
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      // a is rate-limited (window from retryAfterMs); admission falls back to b.
      expect(receipts[1]?.decision).toMatchObject({ kind: "apply", reason: "fallback" })
      expect(receipts[1]?.decision).toMatchObject({ model: ref("prov", "b") })
    })

    it("resets the veto budget when a unit is superseded", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      for (let i = 0; i < 4; i += 1) {
        await supervisor.handleRetry(retryInput429())
      }
      // Supersede closes unit 1; the new unit starts with a fresh budget.
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 20 })
      const input = retryInput429()
      await supervisor.handleRetry(input)
      expect(input.decision).toEqual({ retry: false })
    })

    it("ignores http failures with no attributable model", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
      expect(storedReceipts(storage)).toBeUndefined()
      expect(session.log).toEqual([])
    })

    it("honors a Retry-After header from a rate-limit failure", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "http-response",
        sessionID: "s1",
        status: 429,
        retryAfterHeader: "7",
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      // a is rate-limited (Retry-After window); admission falls back to b.
      expect(receipts[1]?.decision).toMatchObject({ kind: "apply", reason: "fallback" })
      expect(receipts[1]?.decision).toMatchObject({ model: ref("prov", "b") })
    })

    it("treats a 503 as an outage even with a Retry-After header (degraded, not windowed)", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "http-response",
        sessionID: "s1",
        status: 503,
        retryAfterHeader: "7",
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      // 503 is a decisive outage: degraded + breaker failure, no rate-limit
      // window — a single 503 does not quarantine the resource, so a stays
      // preferred.
      expect(receipts[1]?.decision).toMatchObject({ kind: "apply", reason: "preferred" })
      expect(receipts[1]?.decision).toMatchObject({ model: ref("prov", "a") })
    })

    it("carries the hook error's retryAfterMs into classification", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      const input = retryInput429()
      input.error.retryAfterMs = 5_000
      await supervisor.handleRetry(input)
      // The hook model is not a tier candidate, so the recovery candidate is
      // unaffected and the veto still happens.
      expect(input.decision).toEqual({ retry: false })
      errors.restore()
    })

    it("vetoes with a pin routing as the recovery source", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { standard: [wireRef("prov", "b")] }, wireRef("prov", "a")),
      )
      const supervisor = makeSupervisor({ storage, session })
      const input = {
        sessionID: "s1",
        model: { providerID: "other", id: "x" },
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      // Pin routing names a concrete model; admission applies it and the veto
      // owns the recovery switch to the pinned resource.
      expect(input.decision).toEqual({ retry: false })
      await flush()
      expect(session.log).toContain("switch:s1:prov/a")
    })

    it("vetoes with a probe admission as the recovery candidate", async () => {
      let now = 0
      const clock = (): number => now
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session, clock })
      await supervisor.handleReport(STARTED)
      // Trip both breakers.
      for (const id of ["a", "b"]) {
        await supervisor.handleReport({
          kind: "model-selected",
          sessionID: "s1",
          at: now,
          model: ref("prov", id),
        })
        for (let i = 0; i < 5; i += 1) {
          await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
        }
      }
      // Advance past the open window: the next admission may probe a.
      now = 40_000
      const input = retryInput429()
      await supervisor.handleRetry(input)
      expect(input.decision).toEqual({ retry: false })
      await flush()
      expect(session.log).toContain("prompt:s1:" + CONTINUATION_PROMPT)
    })

    it("vetoes even without an active unit and parks nothing", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failWait: true })
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      const input = retryInput429()
      await supervisor.handleRetry(input)
      expect(input.decision).toEqual({ retry: false })
      await flush()
      expect(storedParked(storage)).toBeUndefined()
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] recovery-ops:")
      errors.restore()
    })

    it("returns immediately when idle finds no parked work", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
    })

    it("routes tier resources that carry a variant", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { standard: [wireRef("prov", "a", "high")] }),
      )
      const supervisor = makeSupervisor({
        storage,
        session,
        infos: [makeInfo("prov", "a", { variants: ["high"] }), makeInfo("prov", "b")],
      })
      await supervisor.handleReport(STARTED)
      expect(session.log).toEqual(["switch:s1:prov/a@high"])
    })
  })

  describe("escalation on capability failure (T-18, ADP-015..017)", () => {
    const STARTED = { kind: "execution-started", sessionID: "s1", at: 10 } as const

    /** Control-mode settings with a standard and an advanced tier. */
    function escalateStorage(mode: OperatingMode = "control"): KeyFailStorage {
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON(mode, {
          standard: [wireRef("prov", "a")],
          advanced: [wireRef("prov", "b")],
        }),
      )
      return storage
    }

    const CONTEXT_OVERFLOW = { type: "UnknownError", message: "", status: 413 } as const

    /** Run one admitted, failing episode and return the observed state. */
    async function failingEpisode(
      storage: KeyFailStorage,
      session: FakeSupervisorSession,
      error: { type: string; message: string; status?: number },
    ): Promise<void> {
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error,
      })
      await flush()
    }

    it("escalates to the next tier on a context-overflow failure", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      await failingEpisode(storage, session, CONTEXT_OVERFLOW)
      expect(session.log).toEqual([
        "switch:s1:prov/a",
        "wait:s1",
        "switch:s1:prov/b",
        `prompt:s1:${CONTINUATION_PROMPT}`,
      ])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toEqual({
        kind: "escalate",
        target: ref("prov", "b"),
        step: "tier",
        tier: "advanced",
        evidence: [{ kind: "repeated-failure", detail: "context_overflow" }],
        budgetRemaining: 1,
      })
      expect(receipts[1]?.tier).toBe("advanced")
    })

    it("records an observe-only escalation decision without switching", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage("observe")
      await failingEpisode(storage, session, CONTEXT_OVERFLOW)
      expect(session.log).toEqual([])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toMatchObject({
        kind: "observe-only",
        would: { kind: "apply", model: ref("prov", "a") },
      })
      expect(receipts[1]?.decision).toEqual({
        kind: "observe-only",
        would: {
          kind: "escalate",
          target: ref("prov", "b"),
          step: "tier",
          tier: "advanced",
          evidence: [{ kind: "repeated-failure", detail: "context_overflow" }],
          budgetRemaining: 1,
        },
      })
      expect(receipts[1]?.tier).toBe("advanced")
    })

    it("never escalates on an infrastructure failure (ADP-019)", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      await failingEpisode(storage, session, {
        type: "UnknownError",
        message: "",
        status: 429,
      })
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts).toHaveLength(1)
    })

    it("never escalates on an auth failure", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      await failingEpisode(storage, session, {
        type: "UnauthorizedError",
        message: "",
        status: 401,
      })
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts).toHaveLength(1)
    })

    it("defers with escalation-no-candidate when the next tier is empty", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
      await failingEpisode(storage, session, CONTEXT_OVERFLOW)
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toEqual({
        kind: "defer",
        reason: "escalation-no-candidate",
      })
      expect(receipts[1]?.tier).toBe("standard")
    })

    it("defers with escalation-ceiling at the top tier", async () => {
      // Agent-role routing (ADP-002 level 3) is the admission path that can
      // land on the top tier; from there the escalation ladder tops out.
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { advanced: [wireRef("prov", "b")] }, null, {
          reviewer: "advanced",
        }),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "b"),
        requestKind: "primary",
        agent: "reviewer",
      })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "b"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      expect(session.log).toEqual(["switch:s1:prov/b"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "b") })
      expect(receipts[1]?.decision).toEqual({
        kind: "defer",
        reason: "escalation-ceiling",
      })
      expect(receipts[1]?.tier).toBe("advanced")
    })

    it("escalates on a content-policy rejection via the textual last resort", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      await failingEpisode(storage, session, {
        type: "ProviderRequestError",
        message: "the request was rejected by the content policy",
        status: 400,
      })
      expect(session.log).toEqual([
        "switch:s1:prov/a",
        "wait:s1",
        "switch:s1:prov/b",
        `prompt:s1:${CONTINUATION_PROMPT}`,
      ])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.outcome).toEqual({ status: "failed", category: "content_policy" })
    })

    it("escalates again for a fresh unit (budget cleared on close)", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 35,
        model: ref("prov", "b"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 40,
        error: { type: "UnknownError", message: "", status: 413 },
      })
      await flush()
      const escalations = parseReceiptsPayload(storedReceipts(storage)).filter(
        (receipt) => receipt.decision.kind === "escalate",
      )
      expect(escalations).toHaveLength(2)
      expect(escalations[1]?.decision).toMatchObject({
        kind: "escalate",
        target: ref("prov", "b"),
        budgetRemaining: 1,
      })
    })

    it("escalates a variantless unit even without an attributable tier source", async () => {
      // A failure without an admitted tier (e.g. pin routing) never escalates:
      // there is no tier context to escalate within.
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(storage, SETTINGS_KEY, settingsJSON("control", {}, wireRef("prov", "b")))
      await failingEpisode(storage, session, CONTEXT_OVERFLOW)
      expect(session.log).toEqual(["switch:s1:prov/b"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts).toHaveLength(1)
    })

    it("carries escalation-tool requests as evidence (ADP-015)", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      expect(supervisor.noteEscalationRequest("s1", "needs larger context", "413 on 200k")).toBe(
        true,
      )
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toEqual({
        kind: "escalate",
        target: ref("prov", "b"),
        step: "tier",
        tier: "advanced",
        evidence: [
          { kind: "agent-request", detail: "needs larger context: 413 on 200k" },
          { kind: "repeated-failure", detail: "context_overflow" },
        ],
        budgetRemaining: 1,
      })
    })

    it("discards tool evidence when the unit completes without failure", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      expect(supervisor.noteEscalationRequest("s1", "r", "e")).toBe(true)
      await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 15 })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 20 })
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 25,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 30,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts.at(-1)?.decision).toMatchObject({
        kind: "escalate",
        evidence: [{ kind: "repeated-failure", detail: "context_overflow" }],
      })
    })

    it("discards an escalation request without an active unit", () => {
      const supervisor = makeSupervisor({
        storage: escalateStorage(),
        session: new FakeSupervisorSession(),
      })
      expect(supervisor.noteEscalationRequest("s1", "r", "e")).toBe(false)
    })

    it("bounds recorded tool evidence per unit", async () => {
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      for (let index = 0; index < 6; index++) {
        expect(supervisor.noteEscalationRequest("s1", "r", String(index))).toBe(true)
      }
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("prov", "a"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      const decision = receipts[1]?.decision
      if (decision?.kind !== "escalate") {
        expect(decision?.kind).toBe("escalate")
        return
      }
      expect(decision.evidence.map((entry) => entry.kind)).toEqual([
        "agent-request",
        "agent-request",
        "agent-request",
        "repeated-failure",
      ])
    })

    it("logs a failed escalation continuation without parking", async () => {
      const errors = spyErrors()
      try {
        const session = new FakeSupervisorSession({ failWait: true })
        const storage = escalateStorage()
        await failingEpisode(storage, session, CONTEXT_OVERFLOW)
        expect(errors.lines.some((line) => line.includes("escalation-ops"))).toBe(true)
        // The decision receipt stands even though the continuation failed.
        const receipts = parseReceiptsPayload(storedReceipts(storage))
        expect(receipts[1]?.decision).toMatchObject({ kind: "escalate", target: ref("prov", "b") })
        expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
      } finally {
        errors.restore()
      }
    })
  })
})

describe("supervisor: state API for surfaces", () => {
  it("exposes the loaded settings", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    expect(await supervisor.settings()).toMatchObject({ mode: "control" })
  })

  it("persists a settings update", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const result = await supervisor.updateSettings({ mode: "observe" })
    expect(result).toMatchObject({ ok: true })
    expect(storedSettings(storage).mode).toBe("observe")
    expect((await supervisor.settings()).mode).toBe("observe")
  })

  it("rejects an invalid patch without persisting", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const result = await supervisor.updateSettings({ mode: "sideways" as "control" })
    expect(result.ok).toBe(false)
    expect(storedSettings(storage).mode).toBe("control")
  })

  it("reports status counts", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const snapshot = await supervisor.status()
    expect(snapshot.mode).toBe("control")
    expect(snapshot.parked).toBe(0)
    expect(snapshot.receipts).toBe(0)
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1 })
    const after = await supervisor.status()
    expect(after.receipts).toBe(1)
  })

  it("lists receipts newest first", async () => {
    const storage = controlStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1 })
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 2 })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s2", at: 3 })
    const list = await supervisor.receipts()
    expect(list.map((receipt) => receipt.id)).toEqual([2, 1])
  })
})
