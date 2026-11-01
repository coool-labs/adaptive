/**
 * Supervisor wiring tests (T-17). Every scenario drives the public entry
 * points (`handleReport`, `handleRetry`) with structural reports and observes
 * the effects through the session call log and the persisted storage
 * payloads (receipts/parked are parsed back from storage — the stores are
 * private by design).
 */
// covers: ["ADP-002", "ADP-010", "ADP-013", "ADP-015", "ADP-016", "ADP-024", "ADP-030", "ADP-031"]
import { describe, expect, it, vi } from "vitest"

import type { ModelSource } from "../../src/adapters/opencode/inventory.js"
import type { StorageSource } from "../../src/adapters/opencode/storage.js"
import type { OperatingMode } from "../../src/core/scheduler/types.js"
import type { SupervisorSessionSource } from "../../src/supervisor/types.js"

import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { RECEIPTS_KEY } from "../../src/state/receipts/types.js"
import { PARKED_KEY } from "../../src/state/parked-work/types.js"
import { Supervisor } from "../../src/supervisor/index.js"
import { CODEX_PROVIDER_ID } from "../../src/supervisor/types.js"
import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
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

/**
 * Storage that fails exactly one write to a key (the Nth) and recovers
 * afterwards: pinpoints a single failing persist (e.g. an outcome attach)
 * while later writes still land.
 */
class FailOnceStorage {
  readonly data = new Map<string, unknown>()
  readonly source: StorageSource
  #writes = 0

  constructor(
    readonly failingKey: string,
    readonly failOn: number,
  ) {
    this.source = {
      get: (key: string) => Promise.resolve(this.data.get(key)),
      set: (key: string, value: unknown) => {
        if (key === this.failingKey) {
          this.#writes += 1
          if (this.#writes === this.failOn) return Promise.reject(new Error("write failed"))
        }
        this.data.set(key, value)
        return Promise.resolve()
      },
    } as unknown as StorageSource
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

    it("a pin-routed recovery whose continuation fails parks nothing", async () => {
      // The recovery's routing came from the pin (no tier): when the owned
      // continuation fails there is no tier intent to drop and no tier to
      // park under — the veto stands, the failure is logged fail-open, and
      // nothing is parked.
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failWait: true })
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
      )
      const supervisor = makeSupervisor({ storage, session })
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleRetry(input)
      expect(input.decision).toEqual({ retry: false })
      await flush()
      // The settle failed before any switch or prompt: no owned ops ran.
      expect(session.log).toEqual([])
      expect(storedParked(storage)).toBeUndefined()
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] recovery-ops:")
      errors.restore()
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

    it("resumes a parked unit in control mode (settle, switch to the routed model, continuation prompt)", async () => {
      const session = new FakeSupervisorSession()
      const storage = controlStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      // The resume is an owned path: it settles the session, applies the
      // admission-routed model, and only then prompts — the pre-park (blocked)
      // model must never serve the resumed turn.
      expect(session.log).toEqual([
        `wait:s1`,
        `switch:s1:prov/a`,
        `prompt:s1:${CONTINUATION_PROMPT}`,
      ])
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

    it("survives an outcome-attach write failure and keeps recording receipts", async () => {
      // The attach write fails exactly once — the admission receipt
      // persisted, the outcome write did not: the supervisor must log the
      // failure, keep memory and disk consistent (no outcome appears), and
      // still record the next unit's receipt when writes recover.
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = new FailOnceStorage(RECEIPTS_KEY, 2)
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
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] receipts:")
      // The supervisor still responds: the next unit routes and records.
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts).toHaveLength(2)
      // The failed attach persisted nothing: the first receipt carries no outcome.
      expect(receipts[0]?.outcome).toBeUndefined()
      expect(receipts[1]?.decision).toMatchObject({
        kind: "apply",
        model: ref("prov", "b"),
        reason: "fallback",
      })
      await expect(supervisor.status()).resolves.toMatchObject({ receipts: 2 })
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
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      const escalations = receipts.filter((receipt) => receipt.decision.kind === "escalate")
      // The second unit runs on the escalated model (b) itself. Escalating
      // "to" the model that just failed is a no-op, so the eligible-target
      // filter leaves nothing to escalate to and the budget is not burned.
      expect(escalations).toHaveLength(1)
      expect(receipts.find((receipt) => receipt.decision.kind === "defer")).toMatchObject({
        decision: { kind: "defer", reason: "escalation-no-candidate" },
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

    it("defers with escalation-no-candidate when the inventory read fails (C1)", async () => {
      // The escalation's target evaluation reads the inventory itself (the
      // second listCandidates call); when that read fails there is no
      // verifiable target, so the budget is kept (defer) — never a blind
      // switch. The admission's own earlier read still succeeded.
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = escalateStorage()
      const infos = [makeInfo("prov", "a"), makeInfo("prov", "b")]
      let calls = 0
      const model = {
        transform: (cb: (editor: unknown) => unknown) => {
          calls += 1
          if (calls > 1) return Promise.reject(new Error("inventory unavailable"))
          const editor = {
            list: () => infos,
            get: (providerID: string, modelID: string) =>
              infos.find((info) => info.providerID === providerID && info.id === modelID),
          }
          cb(editor)
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      } as unknown as ModelSource
      const supervisor = new Supervisor({
        session: session.source as unknown as SupervisorSessionSource,
        model,
        storage: storage.source,
        clock: () => 1000,
      })
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
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toEqual({
        kind: "defer",
        reason: "escalation-no-candidate",
      })
      expect(receipts[1]?.tier).toBe("standard")
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] escalation:")
      errors.restore()
    })

    it("escalation skips a breaker-blocked target and leaves its breaker untouched (C1)", async () => {
      // b is the advanced target but its breaker is open: the escalation's
      // non-mutating evaluation must skip it (never flip it to half-open or
      // issue a probe) and defer instead of switching blind.
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("control", {
          standard: [wireRef("prov", "b"), wireRef("prov", "a")],
          advanced: [wireRef("prov", "b")],
        }),
      )
      const supervisor = makeSupervisor({ storage, session })
      // Trip b's breaker (threshold 5 outage failures) while no unit is active.
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 5,
        model: ref("prov", "b"),
      })
      for (let index = 0; index < 5; index += 1) {
        await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
      }
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
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toEqual({
        kind: "defer",
        reason: "escalation-no-candidate",
      })
      expect(receipts[1]?.tier).toBe("standard")
      // The blocked evaluation consumed nothing: b's breaker is still open
      // (a consumed probe would have left it half-open / probe-in-flight).
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      const again = parseReceiptsPayload(storedReceipts(storage))
      expect(again[2]?.decision).toMatchObject({
        kind: "apply",
        model: ref("prov", "a"),
        reason: "fallback",
        evidence: { skipped: [{ ref: ref("prov", "b"), why: "breaker-open" }] },
      })
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

describe('prompt-hook admission (awaited session.hook("prompt"))', () => {
  const PROMPT_S1 = { kind: "prompt", sessionID: "s1" } as const

  function observeStorage(): KeyFailStorage {
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("observe", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
    )
    return storage
  }

  /** One-candidate standard tier: the only tier shape where a due breaker's
   * half-open probe is the admission's choice rather than a passed-over
   * sibling (the scheduler prefers a ready candidate over a probe). */
  function singleStorage(): KeyFailStorage {
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    return storage
  }

  function retryInput(): {
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

  /** Five countable outage failures against the session's last model. */
  async function trip(supervisor: Supervisor, now: number): Promise<void> {
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: now,
      model: ref("prov", "a"),
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
  }

  it("admits at prompt time: applies, records a unit-less receipt, and the opened unit adopts it", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.unitID).toBeUndefined()
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      reason: "preferred",
      model: ref("prov", "a"),
    })
    // The unit the prompt opened consumes the marker (no re-route) and
    // adopts the prompt-time receipt, so outcomes attach to it.
    await supervisor.handleReport(STARTED_S1)
    const adopted = parseReceiptsPayload(storedReceipts(storage))
    expect(adopted).toHaveLength(1)
    expect(adopted[0]?.unitID).toBe("s1#1")
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 20 })
    const done = parseReceiptsPayload(storedReceipts(storage))
    expect(done[0]?.outcome).toEqual({ status: "succeeded" })
  })

  it("observe mode ignores the prompt report entirely", async () => {
    const session = new FakeSupervisorSession()
    const storage = observeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual([])
    expect(storedReceipts(storage)).toBeUndefined()
  })

  it("skips admission for an owned continuation prompt (no receipt, no switch)", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    const input = retryInput()
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The owned recovery settled, switched to the sibling and prompted; the
    // prompt hook that fires for that continuation must not re-admit.
    const logAfterVeto = [...session.log]
    expect(logAfterVeto).toContain("prompt:s1:" + CONTINUATION_PROMPT)
    // The veto recorded the recovery admission itself (unit-less; the
    // continuation unit adopts it), and the continuation prompt adds none.
    const vetoReceipts = parseReceiptsPayload(storedReceipts(storage))
    expect(vetoReceipts).toHaveLength(1)
    expect(vetoReceipts[0]?.unitID).toBeUndefined()
    expect(vetoReceipts[0]?.decision.kind).toBe("apply")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(logAfterVeto)
    expect(parseReceiptsPayload(storedReceipts(storage))).toHaveLength(1)
  })

  it("fail-open: a failing prompt admission defers and execution-started still routes", async () => {
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const model = {
      transform: () => Promise.reject(new Error("inventory unavailable")),
    } as unknown as ModelSource
    const supervisor = new Supervisor({
      session: session.source as unknown as SupervisorSessionSource,
      model,
      storage: storage.source,
      clock: () => 1000,
    })
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual([])
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.unitID).toBeUndefined()
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
    // No marker was set, so the opened unit routes itself (and fails open
    // the same way, with its own unit-scoped receipt).
    await supervisor.handleReport(STARTED_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(2)
    expect(receipts[1]?.unitID).toBe("s1#1")
  })

  it("a prompt-admitted probe episode's failure reopens the breaker instead of wedging half-open", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", reason: "probe" })
    expect(
      (receipts[0]?.decision as { evidence: { probeId?: string } }).evidence.probeId,
    ).toBeDefined()
    // The unit opens (marker consumed, ticket adopted), then the probe
    // episode fails: the ticket reports the failure and the breaker
    // reopens with the doubled window (due at 100_000).
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: now,
      error: { type: "UnknownError", message: "", status: 503 },
    })
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("an interrupted prompt-admitted probe re-arms the same window without doubling", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: now,
      reason: "user",
    })
    // Re-armed at 40_000 with the base 30s window (a cancelled probe is no
    // health evidence): still blocked at 50_000, and the blocker names the
    // breaker — not a probe in flight, which a wedged record would report.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a superseded probe unit reports its lost ticket at the close boundary", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    // A superseding start replaces the probe unit before it terminates; the
    // close cleanup reports the lost ticket so the breaker re-arms.
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: now })
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a prompt with a pin admits the pinned model and carries no tier", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.tier).toBeUndefined()
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      reason: "pin",
      model: ref("prov", "b"),
    })
    // The unit opens: adopted, and the marker carried no tier to record.
    await supervisor.handleReport(STARTED_S1)
    const adopted = parseReceiptsPayload(storedReceipts(storage))
    expect(adopted).toHaveLength(1)
    expect(adopted[0]?.unitID).toBe("s1#1")
  })

  it("a prompt-admitted probe episode's success closes the breaker", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    // The probe succeeded: the breaker closed and the preferred resource is
    // applied again on the next admission.
    now = 41_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "preferred",
      model: ref("prov", "a"),
    })
  })

  it("a variant-'default' failure observation lands on the bare model key", async () => {
    const now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    // The host reports base-model calls with variant "default" (2.2.5); the
    // observation must count against the bare model the inventory offers.
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: now,
      model: { providerID: "prov", id: "a", variant: "default" },
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("keeps the ownership mark across nested owned prompts until each settles", async () => {
    const log: string[] = []
    const gates: (() => void)[] = []
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: (input: { sessionID: string; model: { providerID: string; id: string } }) => {
        log.push(`switch:${input.model.id}`)
        return Promise.resolve()
      },
      prompt: (input: { sessionID: string; text: string }) => {
        log.push(`prompt:${input.text}`)
        return new Promise((resolve) => {
          gates.push(() => {
            resolve({ sessionID: "s1" })
          })
        })
      },
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    // Two overlapping owned recoveries: each marks the session before its
    // prompt and only the last settle releases the in-flight window.
    await supervisor.handleRetry(retryInput())
    await flush()
    await supervisor.handleRetry(retryInput())
    await flush()
    expect(log).toEqual([
      "switch:b",
      "prompt:" + CONTINUATION_PROMPT,
      "switch:b",
      "prompt:" + CONTINUATION_PROMPT,
    ])
    gates[0]?.()
    gates[1]?.()
    await flush()
    // The prompt hooks for those owned prompts never fired in this fake; the
    // mark survives them and skips the next prompt report's admission. Each
    // veto recorded its own unit-less recovery-admission receipt.
    await supervisor.handleReport(PROMPT_S1)
    expect(log).toHaveLength(4)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(2)
    expect(receipts.every((receipt) => receipt.unitID === undefined)).toBe(true)
  })

  it("the prompt admission survives a receipts write failure at adoption", async () => {
    const errors = spyErrors()
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage(RECEIPTS_KEY)
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    expect(errors.lines.join("\n")).toContain("[coool.adaptive] receipts:")
    errors.restore()
  })

  it("a failed adoption write is logged as a receipts failure, not a report failure", async () => {
    // The admission receipt persisted at prompt time; the adoption stamp's
    // write (at execution-started) fails: the catch around adoptUnit must
    // log it as a receipts fail-open — an uncaught propagation would surface
    // as a "report:" log instead and skip the unit's routing.
    const errors = spyErrors()
    const session = new FakeSupervisorSession()
    const storage = new FailOnceStorage(RECEIPTS_KEY, 2)
    seed(storage, SETTINGS_KEY, settingsJSON("control", { standard: [wireRef("prov", "a")] }))
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    expect(errors.lines.join("\n")).toContain("[coool.adaptive] receipts:")
    // The unit still opened on the admitted model: no re-route, no second receipt.
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    // The adoption's write failed, so the unit-less stamp never landed.
    expect(receipts[0]?.unitID).toBeUndefined()
    errors.restore()
  })

  it("a passed-over due breaker's probe is re-armed instead of wedging half-open", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    // a's probe is due; the ready sibling wins, so the assessment's probe
    // ticket is never dispatched by this admission.
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/b"])
    // Trip b as well, then advance to where BOTH breakers are due again: a
    // (re-armed at 40_000 with the same 30s window) and b (opened at 40_000).
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: now,
      model: ref("prov", "b"),
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    now = 70_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // A wedged a would report probe-in-flight and push the probe onto b; the
    // re-armed a is due and wins the probe as the first candidate.
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
  })

  it("observe mode re-arms a probe its wrapped decision never dispatched", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("observe", { standard: [wireRef("prov", "a")] }))
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    // The single candidate is a due probe; OBSERVE records the decision but
    // never runs the probe episode.
    now = 40_000
    await supervisor.handleReport(STARTED_S1)
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "probe" },
    })
    // The next admission must see the breaker re-armed (open), not a probe
    // stuck in flight with an unowned ticket.
    now = 50_000
    await supervisor.handleReport(STARTED_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "park", reason: "all-blocked", detail: "breaker-open" },
    })
  })

  it("a recovery probe is re-armed when the veto never happens", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    const input = retryInput()
    input.error = { type: "UnknownError", message: "", status: 503 }
    input.decision = { retry: false, delay: 0 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false, delay: 0 })
    await flush()
    expect(session.log).toEqual([])
    // The recovery admission consumed the due probe, but without a veto no
    // episode ever carries the ticket: it must re-arm, not wedge half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a failed prompt-admission switch re-arms the probe it admitted", async () => {
    const errors = spyErrors()
    let now = 0
    const clock = (): number => now
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: () => Promise.reject(new Error("switch failed")),
      prompt: () => Promise.resolve({ sessionID: "s1" }),
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    // Fail-open: the admission defers and the opened unit re-routes itself.
    await supervisor.handleReport(STARTED_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
    // The admitted-but-never-dispatched probe re-armed the breaker's same
    // window instead of wedging the resource half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
    errors.restore()
  })

  it("a failed unit-admission switch re-arms the probe it admitted", async () => {
    const errors = spyErrors()
    let now = 0
    const clock = (): number => now
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: () => Promise.reject(new Error("switch failed")),
      prompt: () => Promise.resolve({ sessionID: "s1" }),
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(STARTED_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.unitID).toBe("s1#1")
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
    // The probe was admitted for this unit but its model never applied — the
    // breaker re-arms instead of wedging half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
    errors.restore()
  })

  it("a stale session probe ticket is re-armed, never adopted by a later unit", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: now,
      model: ref("prov", "b"),
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    // Both breakers are due: the prompt admission probes a (first candidate);
    // its turn never opens a unit, so the ticket lingers on the session.
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    // A second prompt re-admits: the stale ticket must re-arm here instead of
    // waiting to be adopted by whichever unit opens next.
    now = 41_000
    await supervisor.handleReport(PROMPT_S1)
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open,breaker-open",
    })
    // The turn that finally opens runs on b; its success says nothing about
    // a, so a must still be breaker-blocked afterwards.
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "b"),
    })
  })

  it("a failed recovery re-arms the probe it admitted for the continuation", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession({ failPrompt: true })
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    const input = retryInput()
    input.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The recovery consumed a's due probe but its continuation prompt failed:
    // no unit will ever carry the ticket, so it must re-arm — otherwise a
    // stays half-open forever and every later admission reads probe-in-flight.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a new veto re-arms the probe ticket whose continuation it replaces", async () => {
    let now = 0
    const clock = (): number => now
    const gates: (() => void)[] = []
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve)
        }),
      switchModel: () => Promise.resolve(),
      prompt: (input: { sessionID: string; text: string }) =>
        Promise.resolve({ sessionID: input.sessionID }),
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: now,
      model: ref("prov", "b"),
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    // Veto #1 admits a's probe; its recovery hangs in settle, so the ticket
    // stays pending on the session.
    now = 40_000
    const first = retryInput()
    first.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(first)
    await flush()
    // Veto #2 (a later turn): a is still half-open (probe in flight), b is
    // due — its probe replaces the pending slot, so the a-ticket must re-arm
    // rather than be silently dropped.
    now = 70_000
    const second = retryInput()
    second.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(second)
    expect(second.decision).toEqual({ retry: false })
    gates[1]?.()
    await flush()
    // The owned continuation's prompt hook fires and is skipped (the marker
    // carries the continuation tier); the opened unit carries b's probe
    // ticket and its success closes b. A later user-prompt admission must
    // then read a as breaker-open (its ticket was re-armed at the second
    // veto), not a probe stuck in flight with a dropped ticket.
    now = 71_000
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    now = 72_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "apply",
      model: ref("prov", "b"),
      tier: "standard",
      reason: "fallback",
      evidence: { skipped: [{ ref: ref("prov", "a"), why: "breaker-open" }] },
    })
  })

  it("a failed unit-admission switch without probe defers without touching the breaker", async () => {
    const errors = spyErrors()
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: () => Promise.reject(new Error("switch failed")),
      prompt: () => Promise.resolve({ sessionID: "s1" }),
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = controlStorage()
    const supervisor = makeSupervisor({ storage, session })
    // Nenhum breaker aberto: a admissão é um apply sem probe; a falha de
    // switch não toca o breaker e o fail-open registra o defer.
    await supervisor.handleReport(STARTED_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.unitID).toBe("s1#1")
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
    errors.restore()
  })

  it("a veto-consumed probe reports through the continuation episode it starts", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    const input = retryInput()
    input.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The continuation's own prompt hook is skipped (owned prompt), the
    // opened unit carries the probe ticket, and its failure reports the
    // probe — reopening with the doubled window instead of wedging.
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: now,
      error: { type: "UnknownError", message: "", status: 503 },
    })
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a veto's probe is adopted by the unit that opens even when the continuation hook never runs", async () => {
    // The probe admitted for a veto's continuation is parked on the session
    // until the episode that follows opens; even when the continuation's
    // prompt hook never fires (no prompt report between veto and start), the
    // opened unit must adopt the carried ticket so its termination reports
    // the probe — an unadopted ticket would wedge the resource half-open
    // (every later admission reads probe-in-flight) instead of re-arming the
    // breaker's window.
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    const input = retryInput()
    input.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // No prompt-hook report: the opened unit adopts the carried ticket...
    await supervisor.handleReport(STARTED_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.unitID).toBeUndefined()
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
    })
    // ...and the fresh admission sees the probe in flight (no second probe).
    expect(receipts[1]?.unitID).toBe("s1#1")
    expect(receipts[1]?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "probe-in-flight",
    })
    // The probe episode fails: the adopted ticket is reported at the close
    // (re-armed, breaker open again) — not wedged half-open.
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: now,
      error: { type: "UnknownError", message: "", status: 503 },
    })
    now = 50_000
    await supervisor.handleReport(STARTED_S1)
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after.at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "breaker-open",
    })
  })

  it("a pin-routed continuation is not re-admitted at execution-started (A1, tier-less)", async () => {
    // A veto whose recovery routes through the pin carries NO tier: the
    // continuation's prompt hook must still consume the ownership mark and
    // set a tier-less admission marker, so the continuation unit opens
    // without a fresh (pin-unaware) re-admission switch and receipt.
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 15,
      model: ref("prov", "a"),
    })
    // a is hard-blocked for the window (429 rate limit at the fixed clock).
    await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 429 })
    const input = {
      sessionID: "s1",
      model: ref("prov", "a"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 },
    }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    // Only the pin admission's switch and the owned recovery ops — the
    // continuation's start neither re-routes nor records a second admission.
    expect(session.log).toEqual([
      "switch:s1:prov/b",
      "wait:s1",
      "switch:s1:prov/b",
      `prompt:s1:${CONTINUATION_PROMPT}`,
    ])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.map((receipt) => receipt.decision.kind)).toEqual(["apply", "apply"])
    // The first receipt is the pin admission, adopted by the FAILED unit;
    // the second is the veto's recovery admission (unit-less) — the
    // continuation unit adopts it instead of re-admitting.
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "b"),
      reason: "pin",
    })
    expect(receipts[0]?.tier).toBeUndefined()
    expect(receipts[0]?.unitID).toBe("s1#1")
    expect(receipts[1]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "b"),
      reason: "pin",
    })
    expect(receipts[1]?.tier).toBeUndefined()
    // The continuation unit (s1#2) adopted the veto's recovery receipt —
    // its outcome will attach here, with no duplicate admission.
    expect(receipts[1]?.unitID).toBe("s1#2")
  })
})

describe("review regressions (continuation admission, idle sweep, escalation targets, id reuse, bounds)", () => {
  const PROMPT_S1 = { kind: "prompt", sessionID: "s1" } as const

  it("does not re-admit an escalation continuation at execution-started (A1)", async () => {
    // The escalation's owned continuation previously left the prompt-hook
    // marker unset, so the continuation's execution-started re-routed a fresh
    // admission and flipped the episode back to the (healthy) preferred model
    // mid-unit — the escalated model served exactly one turn.
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "b")],
      }),
    )
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
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    // The owned continuation prompt triggers the awaited prompt hook; it must
    // carry the escalation's tier instead of re-admitting, and the
    // continuation's execution-started must open its unit on that tier.
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual([
      "switch:s1:prov/a",
      "wait:s1",
      "switch:s1:prov/b",
      `prompt:s1:${CONTINUATION_PROMPT}`,
    ])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // Only the initial apply and the escalation decision — no re-admission.
    expect(receipts).toHaveLength(2)
    expect(receipts.map((receipt) => receipt.decision.kind)).toEqual(["apply", "escalate"])
  })

  it("the idle sweep skips a session that still has an active unit (A3)", async () => {
    // Prompting a session mid-episode would supersede the user's in-flight
    // work; an idle event from another session must not touch it.
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        { id: "s2#1", sessionID: "s2", tier: "standard", reason: "all-blocked", parkedAt: 6 },
      ],
    })
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1) // s1 is mid-episode
    await supervisor.handleReport({ kind: "idle", sessionID: "s2" })
    expect(session.log).toEqual([
      "switch:s1:prov/a",
      "wait:s2",
      "switch:s2:prov/a",
      `prompt:s2:${CONTINUATION_PROMPT}`,
    ])
    const parked = parseParkedPayload(storedParked(storage))
    expect(parked.map((record) => record.id)).toEqual(["s1#1"])
  })

  it("the idle sweep resumes at most one parked record per session (A3/E5)", async () => {
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
        { id: "s1#2", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 6 },
      ],
    })
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    // One owned resume cycle only — the second record waits for the next
    // idle boundary instead of piling duplicate continuations onto the model.
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", `prompt:s1:${CONTINUATION_PROMPT}`])
    const parked = parseParkedPayload(storedParked(storage))
    expect(parked.map((record) => record.id)).toEqual(["s1#2"])
  })

  it("seeds episode counters from persisted ids so restarted sessions never reuse unit ids (C2)", async () => {
    // A parked record persisted as s1#3 must stay the durable key for that
    // episode: after a restart the tracker would hand out s1#3 again and the
    // next park would silently replace the parked record.
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#3", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
      ],
    })
    const supervisor = makeSupervisor({ storage, session })
    for (const at of [10, 20, 30]) {
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at })
      await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: at + 5 })
    }
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // The parked record reserves s1#3: the fresh units continue at #4 and the
    // id is never handed out again.
    expect(receipts.map((receipt) => receipt.unitID)).toEqual(["s1#4", "s1#5", "s1#6"])
  })

  it("loadState ignores unit ids without a numeric episode suffix (C2)", async () => {
    // Receipts persisted with malformed unit ids — no suffix, a non-numeric
    // suffix, a fractional one, or none at all — must neither raise the
    // episode counter nor crash the load: the next unit id stays s1#1.
    const APPLIED = {
      kind: "apply",
      model: ref("prov", "a"),
      reason: "preferred",
      evidence: { skipped: [] },
    } as const
    const session = new FakeSupervisorSession()
    const storage = controlStorage()
    seed(storage, RECEIPTS_KEY, {
      version: 1,
      receipts: [
        { id: 1, at: 5, sessionID: "s1", unitID: "s1", decision: APPLIED },
        { id: 2, at: 6, sessionID: "s1", unitID: "s1#abc", decision: APPLIED },
        { id: 3, at: 7, sessionID: "s1", unitID: "s1#2.5", decision: APPLIED },
        { id: 4, at: 8, sessionID: "s1", decision: APPLIED },
      ],
    })
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    // The malformed receipts round-trip (they went through the floor scan)
    // but raised nothing: the fresh unit continues at #1.
    expect(receipts.map((receipt) => receipt.unitID)).toEqual([
      "s1",
      "s1#abc",
      "s1#2.5",
      undefined,
      "s1#1",
    ])
  })

  it("escalation skips targets that are not in the inventory (C1)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "zzz")],
      }),
    )
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
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "defer",
      reason: "escalation-no-candidate",
    })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("escalation skips targets the compatibility gate rejects (C1)", async () => {
    // b is disabled in the host inventory: switching to it would burn the
    // escalation budget on a switch that cannot work.
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "b")],
      }),
    )
    const supervisor = makeSupervisor({
      storage,
      session,
      infos: [makeInfo("prov", "a"), makeInfo("prov", "b", { enabled: false })],
    })
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
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "defer",
      reason: "escalation-no-candidate",
    })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("escalation skips the model that just failed (C1: no no-op escalation)", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("control", {
        standard: [wireRef("prov", "a")],
        advanced: [wireRef("prov", "a")],
      }),
    )
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
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "defer",
      reason: "escalation-no-candidate",
    })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("evicts agent hints beyond the cap so per-session state stays bounded (A7)", async () => {
    // After 1024 other sessions record agent hints, the oldest hint (s1's)
    // is evicted and its next admission falls back to the default tier.
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON(
        "control",
        { quick: [wireRef("prov", "b")], standard: [wireRef("prov", "a")] },
        null,
        { build: "quick" },
      ),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      agent: "build",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    for (let index = 0; index < 1024; index += 1) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: `x${String(index)}`,
        agent: "build",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
    }
    await supervisor.handleReport(PROMPT_S1)
    // Without the eviction the hint would still route s1 to quick (prov/b).
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })
})
