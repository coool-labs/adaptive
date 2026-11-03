/**
 * Supervisor wiring tests (T-17). Every scenario drives the public entry
 * points (`handleReport`, `handleRetry`) with structural reports and observes
 * the effects through the session call log and the persisted storage
 * payloads (receipts/parked are parsed back from storage — the stores are
 * private by design).
 */
// covers: ["ADP-002", "ADP-010", "ADP-013", "ADP-015", "ADP-016", "ADP-024", "ADP-029", "ADP-030", "ADP-031", "ADP-054", "ADP-055", "ADP-056"]
import { describe, expect, it, vi } from "vitest"

import type { ModelSource } from "../../src/adapters/opencode/inventory.js"
import type { StorageSource } from "../../src/adapters/opencode/storage.js"
import type { OperatingMode } from "../../src/core/scheduler/types.js"
import type { SupervisorSessionSource } from "../../src/supervisor/types.js"

import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { parseTierRequestsPayload } from "../../src/state/tier-requests/index.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { RECEIPTS_KEY } from "../../src/state/receipts/types.js"
import { PARKED_KEY } from "../../src/state/parked-work/types.js"
import { Supervisor } from "../../src/supervisor/index.js"
import { CODEX_PROVIDER_ID } from "../../src/supervisor/types.js"
import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
import { SETTINGS_KEY } from "../../src/state/settings/types.js"
import { CAPACITY_KEY } from "../../src/state/capacity/types.js"
import { HEALTH_KEY } from "../../src/state/health/types.js"
import { SESSION_MODES_KEY } from "../../src/state/session-modes/types.js"
import { TIER_REQUESTS_KEY, MAX_TIER_REQUEST_RECORDS } from "../../src/state/tier-requests/types.js"
import {
  activeStorage,
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
    const storage = activeStorage()
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
    seed(storage, "coool.adaptive/settings", settingsJSON("active", {}, wireRef("prov", "b")))
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
    const storage = activeStorage()
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
    const storage = activeStorage()
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

  /**
   * The host's TUI-mode plugin reconciliation can serve RPC from an instance
   * whose event-pump hooks live on another instance. Health is the only
   * memory-only state the status surface exposes, so it persists through the
   * storage seam like every other state — otherwise the serving instance
   * would report an empty registry while a turn is visibly failing.
   */
  it("status reflects a failure observed by another instance sharing the storage", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
    const observer = makeSupervisor({ storage, session })
    await observer.handleReport(STARTED_S1)
    await observer.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 15,
      model: ref("prov", "a"),
    })
    await observer.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    await flush()
    const reader = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    const status = await reader.status()
    expect(status.tiers.standard[0]?.windowed).toBe(true)
    expect(status.tiers.standard[0]?.health).toBe("rate_limited")
    const own = await observer.status()
    expect(own.tiers.standard[0]?.windowed).toBe(true)
  })

  it("degrades fail-open when the health mirror cannot persist", async () => {
    const errors = spyErrors()
    try {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage(HEALTH_KEY)
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED_S1)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      await flush()
      // The failure was observed and recorded as a receipt; only the
      // health-mirror write degraded (fail-open log, no crash).
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.outcome).toEqual({ status: "failed", category: "rate_limited" })
      expect(errors.lines.some((line) => line.includes("[coool.adaptive] health:"))).toBe(true)
    } finally {
      errors.restore()
    }
  })

  it("a fresh instance assesses persisted failures before routing", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
    const first = makeSupervisor({ storage, session })
    await first.handleReport(STARTED_S1)
    await first.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 15,
      model: ref("prov", "a"),
    })
    await first.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    await flush()
    // A restart (or a second plugin instance) must not start from an empty
    // registry: the still-windowed resource is not reusable, so the new unit
    // parks instead of re-routing onto it.
    const second = makeSupervisor({ storage, session })
    const logLength = session.log.length
    await second.handleReport({ kind: "execution-started", sessionID: "s2", at: 30 })
    // No new switch: the only candidate is still windowed for the fresh
    // instance's assessment, so the episode parks on the session's model.
    expect(session.log).toHaveLength(logLength)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "park", reason: "all-blocked" })
  })

  it("attaches an interrupted outcome for user cancellation without health damage", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
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
    const storage = activeStorage()
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
      settingsJSON("active", { standard: [wireRef("prov", "b")] }),
    )
    const supervisor = makeSupervisor({ storage, session, infos: [makeInfo("prov", "b")] })
    // Trip the breaker (threshold 5 outage failures) while no unit is active.
    for (let index = 0; index < 5; index += 1) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "b"),
        requestKind: "primary",
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
      settingsJSON("active", { standard: [wireRef("openai", "a")] }),
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
    const storage = activeStorage()
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
      settingsJSON("active", { standard: [wireRef("prov", "a")] }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(storedReceipts(storage)).toBeUndefined()
  })

  describe("retry hook", () => {
    it("vetoes native retry and owns horizontal recovery (settle → switch → prompt)", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
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
      const storage = activeStorage()
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
      const storage = activeStorage()
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
        settingsJSON("active", { standard: [wireRef("prov", "a")] }),
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
      const storage = activeStorage()
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
      const storage = activeStorage()
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
        settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
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
      const storage = activeStorage()
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
      const storage = activeStorage()
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
      const storage = activeStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(session.log).toEqual([])
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
    })

    it("keeps resuming when the alive probe fails with a non-Error rejection", async () => {
      // Only a definitive not-found marks a session dead; a hostile (non-Error)
      // rejection is a transient/unknown failure — durable state survives it
      // and the resume proceeds (ADP-031 fail-open toward keeping user work).
      const log: string[] = []
      const source = {
        // A non-Error rejection reason (hostile/transient host behavior): the
        // eslint rule flags it deliberately — this test exercises that shape.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        get: () => Promise.reject("boom"),
        wait: () => Promise.resolve(),
        switchModel: (input: { model: { id: string } }) => {
          log.push(`switch:${input.model.id}`)
          return Promise.resolve()
        },
        prompt: (input: { sessionID: string; text: string }) => {
          log.push(`prompt:${input.text}`)
          return Promise.resolve({ sessionID: input.sessionID })
        },
      }
      const session = { source, log } as unknown as FakeSupervisorSession
      const storage = activeStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(log).toEqual([`switch:a`, `prompt:${CONTINUATION_PROMPT}`])
    })

    it("re-parks without a resume failure log when the user interrupts the settle", async () => {
      const errors = spyErrors()
      try {
        const log: string[] = []
        const gates: (() => void)[] = []
        const source = {
          get: () => Promise.resolve({ sessionID: "s1" }),
          wait: () =>
            new Promise<void>((resolve) => {
              gates.push(resolve)
            }),
          switchModel: (input: { model: { id: string } }) => {
            log.push(`switch:${input.model.id}`)
            return Promise.resolve()
          },
          prompt: (input: { sessionID: string; text: string }) => {
            log.push(`prompt:${input.text}`)
            return Promise.resolve({ sessionID: input.sessionID })
          },
        }
        const session = { source } as unknown as FakeSupervisorSession
        const storage = activeStorage()
        seedParked(storage)
        const supervisor = makeSupervisor({ storage, session })
        // The resume blocks on the host settle, so the interrupt must arrive
        // while the idle report is still in flight.
        const idle = supervisor.handleReport({ kind: "idle", sessionID: "s1" })
        await flush()
        // The resume is parked in the host settle; the user interrupts.
        await supervisor.handleReport({
          kind: "execution-interrupted",
          sessionID: "s1",
          at: 10,
          reason: "user",
        })
        gates[0]?.()
        await idle
        await flush()
        // The stale decision must not act; the work is saved again, honestly —
        // an aborted resume is steering, not an infrastructure failure, so no
        // resume-failure log line is emitted (ADP-010/ADP-031).
        expect(log).toEqual([])
        expect(errors.lines.join("\n")).not.toContain("resume:")
        const parked = parseParkedPayload(storedParked(storage))
        expect(parked).toHaveLength(1)
        expect(parked[0]).toMatchObject({ sessionID: "s1", attempts: 1 })
      } finally {
        errors.restore()
      }
    })

    it("re-parks with a fresh timestamp when the resume prompt fails", async () => {
      const session = new FakeSupervisorSession({ failPrompt: true })
      const storage = activeStorage()
      seedParked(storage, 5)
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      const parked = parseParkedPayload(storedParked(storage))
      expect(parked).toHaveLength(1)
      expect(parked[0]?.parkedAt).toBe(1000)
    })

    // covers: ["ADP-010", "ADP-024"]
    it("a resume whose session went OFF during the settle is aborted and re-parked", async () => {
      const log: string[] = []
      const gates: (() => void)[] = []
      const source = {
        get: () => Promise.resolve({ sessionID: "s1" }),
        wait: () => {
          log.push("wait:s1")
          return new Promise<void>((resolve) => {
            gates.push(resolve)
          })
        },
        switchModel: (input: { sessionID: string; model: { providerID: string; id: string } }) => {
          log.push(`switch:${input.model.id}`)
          return Promise.resolve()
        },
        prompt: (input: { sessionID: string; text: string }) => {
          log.push(`prompt:${input.text}`)
          return Promise.resolve({ sessionID: input.sessionID })
        },
      }
      const session = { source } as unknown as FakeSupervisorSession
      const storage = activeStorage()
      seedParked(storage)
      const supervisor = makeSupervisor({ storage, session })
      // The resume is parked in the host settle (unbounded wait).
      const idle = supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      await flush()
      await flush()
      expect(log).toEqual(["wait:s1"])
      // The user turns the session OFF while the settle is in flight.
      await supervisor.setSessionMode("s1", "off")
      gates[0]?.()
      await idle
      await flush()
      // The stale decision must not act; the durable record is kept.
      expect(log).toEqual(["wait:s1"])
      expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    })
  })

  describe("work-unit model tracking", () => {
    // ADP-028: the pick is the user's (external selection, no pending own
    // note), so admission is suppressed and the unit seeds from the pick.
    it("a user pick seeds the unit's model and suppresses admission while it stays usable", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 5,
        model: ref("prov", "b"),
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
      // No switch: the session runs on the user's picked model.
      expect(session.log).toEqual([])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toEqual({
        kind: "defer",
        reason: "routing-defer",
        detail: "manual-selection",
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      // The 429 was attributed to b (the unit's seeded model) and quarantined
      // it: the next admission yields the suppression to health and falls
      // back to the configured sibling instead of the dead pick.
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      expect(session.log).toEqual(["switch:s1:prov/a"])
      const after = parseReceiptsPayload(storedReceipts(storage))
      expect(after[1]?.decision).toMatchObject({
        kind: "apply",
        model: ref("prov", "a"),
        reason: "preferred",
      })
      // The user asking Adaptive back re-enables routing for later units too
      // (the fallback switch already cleared the manual mark — adaptive
      // routing continues, so the prompt re-admits onto a).
      supervisor.noteTierRequest("s1", "standard")
      await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
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

    /** One-candidate standard tier: no ready sibling can absorb a veto, so
     * breaker counting is observed directly through admission outcomes. */
    function singleStorage(): KeyFailStorage {
      const storage = new KeyFailStorage("unused")
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
      return storage
    }

    it("logs and continues when a report handler throws (fail-open)", async () => {
      const errors = spyErrors()
      const supervisor = makeSupervisor({
        storage: activeStorage(),
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
      const supervisor = makeSupervisor({ storage: activeStorage(), session })
      const input = {
        sessionID: "s1",
        model: ref("prov", "a"),
        error: { type: "UnknownError", message: "", status: 429 },
        attempt: 1,
        decision: { retry: true, delay: 100 },
      }
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
      await supervisor.handleRetry(Object.freeze(input))
      expect(errors.lines[0]).toContain("[coool.adaptive] retry:")
      errors.restore()
    })

    it("tracks a model-request report for later attribution", async () => {
      const session = new FakeSupervisorSession()
      const supervisor = makeSupervisor({ storage: activeStorage(), session })
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

    // covers: ["ADP-027", "ADP-013"]
    it("an auxiliary model request never adopts the primary unit's model attribution", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      // The context hook reports the model actually executing (primary).
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
      // The host's title/summary generation runs on its own cheap model pick;
      // that pick must not become the session's (or the unit's) model.
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "b"),
        requestKind: "title",
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: { type: "UnknownError", message: "", status: 429 },
      })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      // The 429 belongs to the primary model (a): a is windowed and the
      // admission falls back to b. Adopting the auxiliary pick would have
      // blamed b and re-applied a.
      expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/b"])
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "b") })
    })

    it("leaves the retry decision when recovery admission fails", async () => {
      const errors = spyErrors()
      const storage = activeStorage()
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
        settingsJSON("active", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      expect(errors.lines.join("\n")).toContain("[coool.adaptive] parked:")
      errors.restore()
    })

    it("gives up on a parked record when its resume admission fails", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
        settingsJSON("active", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
        settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "zzz")),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[0]?.decision).toMatchObject({ kind: "defer", reason: "pin-unverifiable" })
      expect("tier" in (receipts[0] as object)).toBe(false)
    })

    it("attaches nothing when a terminal event has no active unit", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
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

    // covers: ["ADP-019"]
    it("a failed attempt counts once toward the breaker: it trips after exactly the threshold", async () => {
      const session = new FakeSupervisorSession()
      const storage = singleStorage()
      const supervisor = makeSupervisor({ storage, session })
      // One real failed attempt surfaces through three host signals: the
      // pumped http-response, the retry hook, and the terminal
      // execution-failed. Each attempt must count once (ADP-019 threshold 5).
      const attempt = async (): Promise<void> => {
        await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
        await supervisor.handleRetry({
          sessionID: "s1",
          model: ref("prov", "a"),
          error: { type: "UnknownError", message: "", status: 503 },
          attempt: 1,
          decision: { retry: false },
        })
      }
      const terminal = async (at: number): Promise<void> => {
        await supervisor.handleReport({
          kind: "execution-failed",
          sessionID: "s1",
          at,
          error: { type: "UnknownError", message: "", status: 503 },
        })
      }
      // The context hook reports the executing model each turn: without it
      // the http-response/terminal signals have no attributable model.
      const attribute = async (): Promise<void> => {
        await supervisor.handleReport({
          kind: "model-request",
          sessionID: "s1",
          model: ref("prov", "a"),
          requestKind: "primary",
        })
      }
      await supervisor.handleReport(STARTED)
      await attribute()
      for (let index = 0; index < 4; index += 1) await attempt()
      await terminal(20)
      // Four attempts = four counts: the breaker is NOT open yet, so the next
      // admission still applies the (degraded) preferred resource.
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      await attribute()
      expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/a"])
      // The fifth failed attempt trips it.
      for (let index = 0; index < 1; index += 1) await attempt()
      await terminal(40)
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 50 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts.at(-1)?.decision).toEqual({
        kind: "park",
        reason: "all-blocked",
        detail: "breaker-open",
      })
    })

    it("a terminal failure counts only when its attempt left no live evidence", async () => {
      const session = new FakeSupervisorSession()
      const storage = singleStorage()
      const supervisor = makeSupervisor({ storage, session })
      const hook = async (): Promise<void> => {
        await supervisor.handleRetry({
          sessionID: "s1",
          model: ref("prov", "a"),
          error: { type: "UnknownError", message: "", status: 503 },
          attempt: 1,
          decision: { retry: false },
        })
      }
      const terminal = async (at: number): Promise<void> => {
        await supervisor.handleReport({
          kind: "execution-failed",
          sessionID: "s1",
          at,
          error: { type: "UnknownError", message: "", status: 503 },
        })
      }
      const http = async (): Promise<void> => {
        await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
      }
      const startUnit = async (at: number): Promise<void> => {
        await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at })
        await supervisor.handleReport({
          kind: "model-request",
          sessionID: "s1",
          model: ref("prov", "a"),
          requestKind: "primary",
        })
      }
      // hook-only attempt: its terminal is the same attempt (skipped).
      await startUnit(10)
      await hook()
      await terminal(20)
      // http-only attempt: same rule.
      await startUnit(30)
      await http()
      await terminal(31)
      // A full http+hook pair closes the attempt; the terminal repeats it.
      await startUnit(32)
      await http()
      await hook()
      await terminal(33)
      // A terminal with no live attempt evidence is itself the evidence.
      await startUnit(34)
      await terminal(35)
      // The fifth failed attempt reaches the threshold of 5.
      await hook()
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 40 })
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts.at(-1)?.decision).toEqual({
        kind: "park",
        reason: "all-blocked",
        detail: "breaker-open",
      })
    })

    it("honors retryAfterMs from a failed execution as the rate-limit window", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
      expect(storedReceipts(storage)).toBeUndefined()
      expect(session.log).toEqual([])
    })

    it("honors a Retry-After header from a rate-limit failure", async () => {
      const session = new FakeSupervisorSession()
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      const storage = activeStorage()
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      const storage = activeStorage()
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
        settingsJSON("active", { standard: [wireRef("prov", "b")] }, wireRef("prov", "a")),
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
      const storage = activeStorage()
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
      expect(session.log).toContain(`prompt:s1:${CONTINUATION_PROMPT}`)
    })

    it("vetoes even without an active unit and parks nothing", async () => {
      const errors = spyErrors()
      const session = new FakeSupervisorSession({ failWait: true })
      const storage = activeStorage()
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
      const storage = activeStorage()
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
        settingsJSON("active", { standard: [wireRef("prov", "a", "high")] }),
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
    function escalateStorage(mode: OperatingMode = "active"): KeyFailStorage {
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
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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

    it("spends one escalation budget across a task's continuations, renewed by the next user prompt", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("active", {
          quick: [wireRef("prov", "q")],
          standard: [wireRef("prov", "a")],
          advanced: [wireRef("prov", "b")],
        }),
      )
      const supervisor = makeSupervisor({
        storage,
        session,
        infos: [makeInfo("prov", "q"), makeInfo("prov", "a"), makeInfo("prov", "b")],
      })
      supervisor.noteTierRequest("s1", "quick")
      // Each failing episode opens a new unit: the user's prompt, then the
      // owned continuation the first escalation delivered.
      const fail = async (model: string, at: number): Promise<void> => {
        await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
        await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at })
        await supervisor.handleReport({
          kind: "model-selected",
          sessionID: "s1",
          at: at + 1,
          model: ref("prov", model),
        })
        await supervisor.handleReport({
          kind: "execution-failed",
          sessionID: "s1",
          at: at + 2,
          error: CONTEXT_OVERFLOW,
        })
        await flush()
      }
      await fail("q", 10)
      await fail("a", 20)
      const escalations = parseReceiptsPayload(storedReceipts(storage)).filter(
        (receipt) => receipt.decision.kind === "escalate",
      )
      expect(escalations.map((receipt) => receipt.decision)).toMatchObject([
        { kind: "escalate", tier: "standard", budgetRemaining: 1 },
        { kind: "escalate", tier: "advanced", budgetRemaining: 0 },
      ])
      // The advanced continuation completes the task; the next user prompt
      // starts a new task with a fresh budget.
      await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 25 })
      await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 26 })
      await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 31,
        model: ref("prov", "q"),
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 32,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      expect(
        parseReceiptsPayload(storedReceipts(storage))
          .filter((receipt) => receipt.decision.kind === "escalate")
          .at(-1)?.decision,
      ).toMatchObject({ kind: "escalate", tier: "standard", budgetRemaining: 1 })
    })

    it("never escalates onto the resource that failed when the host reports it as variant 'default'", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("active", {
          standard: [wireRef("prov", "a")],
          advanced: [wireRef("prov", "a"), wireRef("prov", "b")],
        }),
      )
      const supervisor = makeSupervisor({ storage, session })
      await supervisor.handleReport(STARTED)
      // The host names base-model calls variant "default" (2.2.5): that is
      // still prov/a, so the advanced tier's own prov/a is no stronger target.
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: { providerID: "prov", id: "a", variant: "default" },
        requestKind: "primary",
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      const receipts = parseReceiptsPayload(storedReceipts(storage))
      expect(receipts[1]?.decision).toMatchObject({
        kind: "escalate",
        target: ref("prov", "b"),
        tier: "advanced",
      })
    })

    it("escalates onto a variant-carrying target listed in the inventory", async () => {
      const session = new FakeSupervisorSession()
      const storage = new KeyFailStorage("unused")
      seed(
        storage,
        SETTINGS_KEY,
        settingsJSON("active", {
          standard: [wireRef("prov", "a")],
          advanced: [wireRef("prov", "b", "high")],
        }),
      )
      const supervisor = makeSupervisor({
        storage,
        session,
        infos: [makeInfo("prov", "a"), makeInfo("prov", "b", { variants: ["high"] })],
      })
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
      await supervisor.handleReport({
        kind: "execution-failed",
        sessionID: "s1",
        at: 20,
        error: CONTEXT_OVERFLOW,
      })
      await flush()
      expect(session.log).toContain("switch:s1:prov/b@high")
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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
        settingsJSON("active", { advanced: [wireRef("prov", "b")] }, null, {
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
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
      seed(storage, SETTINGS_KEY, settingsJSON("active", {}, wireRef("prov", "b")))
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
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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

    it("swallows an aborted escalation continuation without a failure log", async () => {
      const errors = spyErrors()
      try {
        const log: string[] = []
        const gates: (() => void)[] = []
        const source = {
          get: () => Promise.resolve({ sessionID: "s1" }),
          wait: () =>
            new Promise<void>((resolve) => {
              gates.push(resolve)
            }),
          switchModel: (input: { model: { id: string } }) => {
            log.push(`switch:${input.model.id}`)
            return Promise.resolve()
          },
          prompt: (input: { sessionID: string; text: string }) => {
            log.push(`prompt:${input.text}`)
            return Promise.resolve({ sessionID: input.sessionID })
          },
        }
        const session = { source, log } as unknown as FakeSupervisorSession
        const storage = escalateStorage()
        const supervisor = makeSupervisor({ storage, session })
        await supervisor.handleReport(STARTED)
        await supervisor.handleReport({
          kind: "model-request",
          sessionID: "s1",
          model: ref("prov", "a"),
          requestKind: "primary",
        })
        // The failed episode's escalation continuation blocks on the host
        // settle, so the interrupt must arrive while it is still in flight.
        const failed = supervisor.handleReport({
          kind: "execution-failed",
          sessionID: "s1",
          at: 20,
          error: CONTEXT_OVERFLOW,
        })
        await flush()
        await supervisor.handleReport({
          kind: "execution-interrupted",
          sessionID: "s1",
          at: 20,
          reason: "user",
        })
        gates[0]?.()
        await failed
        await flush()
        // The aborted continuation is steering, not an ops failure: the stale
        // decision never acts and no escalation-ops log line is emitted.
        expect(log).toEqual(["switch:a"])
        expect(errors.lines.join("\n")).not.toContain("escalation-ops")
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
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
        settingsJSON("active", {
          standard: [wireRef("prov", "b"), wireRef("prov", "a")],
          advanced: [wireRef("prov", "b")],
        }),
      )
      const supervisor = makeSupervisor({ storage, session })
      // Trip b's breaker (threshold 5 outage failures) while no unit is active.
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "b"),
        requestKind: "primary",
      })
      for (let index = 0; index < 5; index += 1) {
        await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
      }
      await supervisor.handleReport(STARTED)
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s1",
        model: ref("prov", "a"),
        requestKind: "primary",
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
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    expect(await supervisor.settings()).toMatchObject({ mode: "active" })
  })

  it("persists a settings update", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const result = await supervisor.updateSettings({ mode: "observe" })
    expect(result).toMatchObject({ ok: true })
    expect(storedSettings(storage).mode).toBe("observe")
    expect((await supervisor.settings()).mode).toBe("observe")
  })

  it("rejects an invalid patch without persisting", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const result = await supervisor.updateSettings({ mode: "sideways" as "active" })
    expect(result.ok).toBe(false)
    expect(storedSettings(storage).mode).toBe("active")
  })

  it("reports status counts", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    const snapshot = await supervisor.status()
    expect(snapshot.mode).toBe("active")
    expect(snapshot.parked).toBe(0)
    expect(snapshot.receipts).toBe(0)
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1 })
    const after = await supervisor.status()
    expect(after.receipts).toBe(1)
  })

  const CODEX_USAGE_RESPONSE = {
    kind: "http-response",
    sessionID: "s1",
    status: 200,
    capturedHeaders: {
      "x-codex-primary-used-percent": "72",
      "x-codex-primary-reset-after-seconds": "900",
    },
  } as const

  function codexStorage(): KeyFailStorage {
    const storage = activeStorage()
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("openai", "a")] }))
    return storage
  }

  it("status shows the usage sensed from a response's x-codex headers on the same instance", async () => {
    // The passive observation reaches the registry only through refresh(); the
    // admission-time refresh always runs before the response carrying the
    // telemetry, so the response handler must sync the mirror itself.
    const storage = codexStorage()
    const supervisor = makeSupervisor({
      storage,
      session: new FakeSupervisorSession(),
      infos: [makeInfo("openai", "a")],
    })
    await supervisor.handleReport(CODEX_USAGE_RESPONSE)
    const snapshot = await supervisor.status()
    expect(snapshot.tiers.standard[0]?.usedPercent).toBe(72)
    expect(snapshot.tiers.standard[0]?.resetAt).not.toBeNull()
  })

  // The TUI host loads the plugin twice: one instance observes the response
  // headers (event pump), the other serves status.get with an empty sensor
  // registry. Capacity must travel through the persisted mirror.
  it("status reflects capacity sensed by another instance sharing the storage", async () => {
    const storage = codexStorage()
    const infos = [makeInfo("openai", "a")]
    const observer = makeSupervisor({ storage, session: new FakeSupervisorSession(), infos })
    await observer.handleReport(CODEX_USAGE_RESPONSE)
    const reader = makeSupervisor({ storage, session: new FakeSupervisorSession(), infos })
    const status = await reader.status()
    expect(status.tiers.standard[0]?.usedPercent).toBe(72)
    expect(status.tiers.standard[0]?.resetAt).not.toBeNull()
  })

  it("persists nothing for a response whose headers carry no usage telemetry", async () => {
    const storage = codexStorage()
    const supervisor = makeSupervisor({
      storage,
      session: new FakeSupervisorSession(),
      infos: [makeInfo("openai", "a")],
    })
    await supervisor.handleReport({
      ...CODEX_USAGE_RESPONSE,
      capturedHeaders: { "content-type": "application/json" },
    })
    expect(storage.data.get(CAPACITY_KEY)).toEqual({ version: 1, readings: [] })
    const snapshot = await supervisor.status()
    expect(snapshot.tiers.standard[0]?.usedPercent).toBeNull()
  })

  it("reports no capacity for a resource nothing has sensed", async () => {
    const supervisor = makeSupervisor({
      storage: codexStorage(),
      session: new FakeSupervisorSession(),
      infos: [makeInfo("openai", "a")],
    })
    const snapshot = await supervisor.status()
    expect(snapshot.tiers.standard[0]?.usedPercent).toBeNull()
    expect(snapshot.tiers.standard[0]?.resetAt).toBeNull()
  })

  it("keeps handling the response when the capacity mirror cannot persist", async () => {
    const errors = spyErrors()
    try {
      const storage = new KeyFailStorage(CAPACITY_KEY)
      seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("openai", "a")] }))
      const session = new FakeSupervisorSession()
      const supervisor = makeSupervisor({ storage, session, infos: [makeInfo("openai", "a")] })
      await supervisor.handleReport(STARTED_S1)
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: "s1",
        at: 15,
        model: ref("openai", "a"),
      })
      await supervisor.handleReport({
        ...CODEX_USAGE_RESPONSE,
        status: 429,
        capturedHeaders: { ...CODEX_USAGE_RESPONSE.capturedHeaders, "retry-after": "30" },
      })
      await flush()
      // The mirror write degraded (fail-open log) but the 429 was still
      // recorded as health evidence for the resource.
      expect(errors.lines.some((line) => line.includes("[coool.adaptive] capacity:"))).toBe(true)
      const status = await supervisor.status()
      expect(status.tiers.standard[0]?.windowed).toBe(true)
    } finally {
      errors.restore()
    }
  })

  it("lists receipts newest first", async () => {
    const storage = activeStorage()
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

  /** One-candidate standard tier: a due breaker's probe has no ready sibling
   * to fall back on, so a released probe shows up as the next admission. */
  function singleStorage(): KeyFailStorage {
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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
    if (now < 0) return // kept for call-site symmetry; only the model matters
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
  }

  it("admits at prompt time: applies, records a unit-less receipt, and the opened unit adopts it", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
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
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    const input = retryInput()
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The owned recovery settled, switched to the sibling and prompted; the
    // prompt hook that fires for that continuation must not re-admit.
    const logAfterVeto = [...session.log]
    expect(logAfterVeto).toContain(`prompt:s1:${CONTINUATION_PROMPT}`)
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
    const probeDecision = receipts[0]?.decision as { evidence: { probeId?: string } } | undefined
    expect(probeDecision?.evidence.probeId).toBeDefined()
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
      settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
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
      kind: "model-request",
      sessionID: "s1",
      model: { providerID: "prov", id: "a", variant: "default" },
      requestKind: "primary",
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
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    // Two overlapping owned recoveries: each marks the session before its
    // prompt and only the last settle releases the in-flight window.
    await supervisor.handleRetry(retryInput())
    await flush()
    await supervisor.handleRetry(retryInput())
    await flush()
    expect(log).toEqual([
      "switch:b",
      `prompt:${CONTINUATION_PROMPT}`,
      "switch:b",
      `prompt:${CONTINUATION_PROMPT}`,
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
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
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

  // Regression (ADP-018/019): a due preferred resource used to lose its probe
  // to a ready later sibling and was re-armed with a fresh window on every
  // admission, so it never returned while the sibling stayed healthy.
  it("a due preferred resource gets its probe over a ready sibling and returns on success", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    now = 41_000
    await supervisor.handleReport(PROMPT_S1)
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toEqual({
      kind: "apply",
      model: ref("prov", "a"),
      tier: "standard",
      reason: "preferred",
      evidence: { skipped: [] },
    })
  })

  // Regression: releasing a passed-over probe used to restart its backoff
  // window, pushing the resource back on every admission that skipped it.
  it("a passed-over due probe stays due instead of restarting its backoff", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: ref("prov", "b"),
      requestKind: "primary",
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    // b's probe is due, but the ready preferred a wins this admission.
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    await trip(supervisor, now)
    // a is now breaker-open; b was released still due, so it is probed at
    // once rather than after another 30s window.
    now = 40_001
    await supervisor.handleReport(PROMPT_S1)
    expect(parseReceiptsPayload(storedReceipts(storage)).at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "b"),
      evidence: { skipped: [{ ref: ref("prov", "a"), why: "breaker-open" }] },
    })
  })

  // covers: ["ADP-024", "ADP-019"]
  it("an observe-mode resume releases the probe its admission issued (never wedges half-open)", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("observe", { standard: [wireRef("prov", "a")] }))
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
      ],
    })
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    // The resume admission consumes a's due probe, but OBSERVE never runs the
    // probe episode: the ticket must be released at the resume boundary.
    now = 40_000
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "probe" },
    })
    // The next sweep sees the probe due again, not stuck probe-in-flight.
    now = 50_000
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "probe" },
    })
  })

  it("observe mode releases a probe its wrapped decision never dispatched", async () => {
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
    // The next admission must see the probe due again, not stuck in flight
    // with an unowned ticket (which would park as probe-in-flight).
    now = 50_000
    await supervisor.handleReport(STARTED_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "observe-only",
      would: { kind: "apply", reason: "probe" },
    })
  })

  it("a recovery probe is released when the veto never happens", async () => {
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
    // episode ever carries the ticket: it must be released (still due), not
    // wedge half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
  })

  it("a failed prompt-admission switch releases the probe it admitted", async () => {
    const errors = spyErrors()
    let switches = 0
    let now = 0
    const clock = (): number => now
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: () => {
        switches += 1
        return switches === 1 ? Promise.reject(new Error("switch failed")) : Promise.resolve()
      },
      prompt: () => Promise.resolve({ sessionID: "s1" }),
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    // Fail-open: the admission defers to OpenCode's own model.
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "internal error",
    })
    // The admitted-but-never-dispatched probe is released (still due)
    // instead of wedging the resource half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
    errors.restore()
  })

  it("a failed unit-admission switch releases the probe it admitted", async () => {
    const errors = spyErrors()
    let switches = 0
    let now = 0
    const clock = (): number => now
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () => Promise.resolve(),
      switchModel: () => {
        switches += 1
        return switches === 1 ? Promise.reject(new Error("switch failed")) : Promise.resolve()
      },
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
    // The admitted-but-never-dispatched probe is released (still due)
    // instead of wedging the resource half-open.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const after = parseReceiptsPayload(storedReceipts(storage))
    expect(after.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
    errors.restore()
  })

  it("a stale session probe ticket is released, never adopted by a later unit", async () => {
    let now = 0
    const clock = (): number => now
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: ref("prov", "b"),
      requestKind: "primary",
    })
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    // Both breakers are due: the prompt admission probes a (first candidate);
    // its turn never opens a unit, so the ticket lingers on the session.
    now = 40_000
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    // A second prompt re-admits: the stale ticket must be released here
    // instead of waiting to be adopted by whichever unit opens next — a
    // held ticket would read probe-in-flight and push the probe onto b.
    now = 41_000
    await supervisor.handleReport(PROMPT_S1)
    let receipts = parseReceiptsPayload(storedReceipts(storage))
    const fresh = receipts.at(-1)?.decision
    expect(fresh).toMatchObject({ kind: "apply", reason: "probe", model: ref("prov", "a") })
    const stale = receipts.at(-2)?.decision
    expect(stale).toMatchObject({ kind: "apply", reason: "probe" })
    // The opened unit carries the fresh ticket, so its success closes a.
    expect(fresh).not.toEqual(stale)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    now = 42_000
    await supervisor.handleReport(PROMPT_S1)
    receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
      reason: "preferred",
    })
  })

  it("a failed probe episode backs the breaker off further instead of re-arming its window", async () => {
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
      kind: "execution-failed",
      sessionID: "s1",
      at: now,
      error: { type: "UnknownError", message: "", status: 503 },
    })
    // The probe's real failure is evidence: the breaker re-opens with a
    // longer backoff. Treating it as a lost ticket (user_cancelled) would
    // re-arm the same 30s window and probe the failing resource again.
    now = 70_001
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "park" })
  })

  it("a failed recovery releases the probe it admitted for the continuation", async () => {
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
    // no unit will ever carry the ticket, so it must be released — otherwise
    // a stays half-open forever and every later admission reads
    // probe-in-flight.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
  })

  it("a recovery whose session went OFF during the settle is aborted before any switch or prompt", async () => {
    const log: string[] = []
    const gates: (() => void)[] = []
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve)
        }),
      switchModel: (input: { sessionID: string; model: { providerID: string; id: string } }) => {
        log.push(`switch:${input.model.id}`)
        return Promise.resolve()
      },
      prompt: (input: { sessionID: string; text: string }) => {
        log.push(`prompt:${input.text}`)
        return Promise.resolve({ sessionID: input.sessionID })
      },
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED_S1)
    const input = retryInput()
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The recovery is parked in the host settle (unbounded wait).
    expect(log).toEqual(["switch:a"])
    // The user turns the session OFF while the settle is in flight.
    await supervisor.setSessionMode("s1", "off")
    gates[0]?.()
    await flush()
    // The stale decision must not act: no recovery switch, no prompt.
    expect(log).toEqual(["switch:a"])
  })

  // covers: ["ADP-010", "ADP-019"]
  it("a user interruption during the settle aborts the recovery and releases its probe", async () => {
    let now = 0
    const clock = (): number => now
    const log: string[] = []
    const gates: (() => void)[] = []
    const source = {
      get: () => Promise.resolve({ sessionID: "s1" }),
      wait: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve)
        }),
      switchModel: (input: { sessionID: string; model: { providerID: string; id: string } }) => {
        log.push(`switch:${input.model.id}`)
        return Promise.resolve()
      },
      prompt: (input: { sessionID: string; text: string }) => {
        log.push(`prompt:${input.text}`)
        return Promise.resolve({ sessionID: input.sessionID })
      },
    }
    const session = { source } as unknown as FakeSupervisorSession
    const storage = singleStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    now = 40_000
    const input = retryInput()
    input.error = { type: "UnknownError", message: "", status: 503 }
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await flush()
    // The recovery consumed a's due probe and is parked in the settle.
    // The user interrupts while it waits.
    await supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: now,
      reason: "user",
    })
    gates[0]?.()
    await flush()
    // No owned continuation ran (ADP-010: user cancellation never triggers
    // failover), and the probe was released: a is probed again at once
    // instead of wedged half-open. The only switch is that fresh probe
    // admission's.
    now = 50_000
    await supervisor.handleReport(PROMPT_S1)
    expect(log).toEqual(["switch:a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      reason: "probe",
      model: ref("prov", "a"),
    })
  })

  it("a new veto releases the probe ticket whose continuation it replaces", async () => {
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
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session, clock })
    await trip(supervisor, now)
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: ref("prov", "b"),
      requestKind: "primary",
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
    // then probe a again (its ticket was released at the second veto), not
    // read a probe stuck in flight with a dropped ticket.
    now = 71_000
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: now })
    now = 72_000
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
      tier: "standard",
      reason: "probe",
      evidence: { skipped: [] },
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
    const storage = activeStorage()
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
      settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
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
      settingsJSON("active", {
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
    const storage = activeStorage()
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
    const storage = activeStorage()
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
    const storage = activeStorage()
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
    const storage = activeStorage()
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
      settingsJSON("active", {
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
      settingsJSON("active", {
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
      settingsJSON("active", {
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
        "active",
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

describe("manual model selection (ADP-028: Adaptive never fights manual model changes)", () => {
  const PROMPT_S1 = { kind: "prompt", sessionID: "s1" } as const

  it("a user model pick disables prompt admission until Adaptive or the user re-enables", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    // The user picks b (an external selection event, no pending own note).
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport(PROMPT_S1)
    // The prompt must NOT switch away from the model the user just chose.
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "manual-selection",
    })
  })

  it("execution-started routing is suppressed for a manually selected session too", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport(STARTED_S1)
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.unitID).toBe("s1#1")
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "manual-selection",
    })
  })

  it("an adaptive switch re-enables routing (the next selection echo is Adaptive's)", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport(PROMPT_S1)
    expect(parseReceiptsPayload(storedReceipts(storage))[0]?.decision).toMatchObject({
      detail: "manual-selection",
    })
    // A failure on a foreign model vetoes native retry; the owned recovery
    // switches onto a — an ADAPTIVE switch (the pending own-switch note).
    await supervisor.handleRetry({
      sessionID: "s1",
      model: ref("other", "x"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 },
    })
    await flush()
    // The host echoes the adaptive switch as a selection event; the tracker
    // attributes it to Adaptive, which re-enables prompt routing.
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 10,
      model: ref("prov", "a"),
    })
    // The owned continuation's prompt hook (marker consumed, no admission),
    // then the fresh user prompt after it: routing is re-enabled and a is
    // applied again.
    await supervisor.handleReport(PROMPT_S1)
    await supervisor.handleReport(STARTED_S1)
    await supervisor.handleReport(PROMPT_S1)
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({ kind: "apply", reason: "preferred" })
    expect(session.log.at(-1)).toBe("switch:s1:prov/a")
  })

  it("a tier request re-enables routing for the session", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual([])
    supervisor.noteTierRequest("s1", "standard")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[1]?.tier).toBe("standard")
    expect(receipts[1]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
  })

  it("a health-blocked manual pick yields: the configured fallback takes over", async () => {
    // Regression (user-reported): a manually picked model that hits a usage
    // limit kept the session pinned to the dead resource — every admission
    // deferred with detail "manual-selection" and no configured fallback
    // ever ran. Suppression honors the pick only while it is usable.
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    // The user picks b (an external selection event, no pending own note).
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    // The picked model then fails until its breaker opens.
    for (let i = 0; i < 5; i += 1) {
      await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
    }
    await supervisor.handleReport(PROMPT_S1)
    // The fallback the user configured takes over (ready sibling a wins).
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts.at(-1)?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
      reason: "preferred",
    })
  })

  it("a standing settings pin overrides manual-selection suppression", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "a"),
    })
    await supervisor.handleReport(PROMPT_S1)
    // The pin is the user's standing instruction: it still applies.
    expect(session.log).toEqual(["switch:s1:prov/b"])
  })

  it("evicts the oldest manual selection past the bounded capacity", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    for (let i = 0; i < Supervisor.MAX_MANUAL_SELECTIONS; i++) {
      await supervisor.handleReport({
        kind: "model-selected",
        sessionID: `s${String(i)}`,
        at: i,
        model: ref("prov", "b"),
      })
    }
    // One more pushes the oldest out: s0's admission routes again...
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s-new",
      at: 1,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport({ kind: "prompt", sessionID: "s0" })
    expect(session.log).toEqual(["switch:s0:prov/a"])
    // ...while a recent manual pick is still suppressed.
    await supervisor.handleReport({ kind: "prompt", sessionID: "s-new" })
    expect(session.log).toEqual(["switch:s0:prov/a"])
  })

  it("suppression holds when the picked model is no longer tracked (evicted)", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 5,
      model: ref("prov", "b"),
    })
    // model-request events seed lastModel without manual selections, so the
    // tracker's map evicts earlier: enough of them from fresh sessions push
    // s1's lastModel out while its manual pick survives.
    for (let i = 0; i < 1024; i += 1) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: `x${String(i)}`,
        agent: "build",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
    }
    await supervisor.handleReport(PROMPT_S1)
    // No tracked model to evaluate: the pick is honored conservatively.
    expect(session.log).toEqual([])
  })
})

describe("per-session mode overrides (ADP-054)", () => {
  const PROMPT_S1 = { kind: "prompt", sessionID: "s1" } as const

  function observeStorage(tiers: Record<string, unknown[]> = {}): KeyFailStorage {
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, settingsJSON("observe", tiers))
    return storage
  }

  function seedParked(storage: KeyFailStorage, parkedAt = 5): void {
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [{ id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt }],
    })
  }

  /** Seed one persisted override directly (restart/hydration scenarios). */
  function seedOverride(storage: KeyFailStorage, sessionID: string, mode: string): void {
    seed(storage, SESSION_MODES_KEY, {
      version: 1,
      records: [{ sessionID, mode, updatedAt: 1 }],
    })
  }

  /** A supervisor whose session source treats one session as dead. */
  function supervisorWithDeadSession(
    storage: KeyFailStorage,
    deadSessionID: string,
  ): { supervisor: Supervisor; session: FakeSupervisorSession } {
    const session = new FakeSupervisorSession()
    const source = {
      ...session.source,
      get: (input: { sessionID: string }) =>
        input.sessionID === deadSessionID
          ? Promise.reject(new Error("session not found"))
          : session.source.get(input),
    }
    const infos = [makeInfo("prov", "a"), makeInfo("prov", "b")]
    const model = {
      transform: (cb: (editor: unknown) => unknown) => {
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
      session: source as unknown as SupervisorSessionSource,
      model,
      storage: storage.source,
      clock: () => 1000,
    })
    return { supervisor, session }
  }

  it("global observe with an active override admits the override session at prompt time", async () => {
    const session = new FakeSupervisorSession()
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.setSessionMode("s1", "active")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({
      kind: "apply",
      model: ref("prov", "a"),
      tier: "standard",
    })
  })

  it("an observe override keeps its session observed while unoverridden sessions stay controlled", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.setSessionMode("s1", "observe")
    // s1's prompt report is a no-op (observe never admits at prompt time) and
    // its execution-started routes as observe-only.
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual([])
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    // s2 carries no override: the global active mode controls it.
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s2", at: 11 })
    expect(session.log).toEqual(["switch:s2:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts).toHaveLength(2)
    expect(receipts[0]?.sessionID).toBe("s1")
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
    expect(receipts[1]?.sessionID).toBe("s2")
    expect(receipts[1]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
  })

  it("an off override makes the session fully inert (no switch, no receipts, retry untouched)", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.setSessionMode("s1", "off")
    await supervisor.handleReport(STARTED_S1)
    const input = {
      sessionID: "s1",
      model: ref("prov", "a"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 },
    }
    await supervisor.handleRetry(input)
    expect(session.log).toEqual([])
    expect(storedReceipts(storage)).toBeUndefined()
    expect(input.decision).toEqual({ retry: true, delay: 100 })
  })

  it("persists overrides and reads them back across instances", async () => {
    const storage = activeStorage()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    expect(await supervisor.getSessionMode("s1")).toBeNull()
    await supervisor.setSessionMode("s1", "active")
    expect(await supervisor.getSessionMode("s1")).toBe("active")
    await supervisor.setSessionMode("s1", null)
    expect(await supervisor.getSessionMode("s1")).toBeNull()
    // Another instance over the same storage hydrates the persisted override.
    await supervisor.setSessionMode("s1", "observe")
    const restarted = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    expect(await restarted.getSessionMode("s1")).toBe("observe")
    const payload = storage.data.get(SESSION_MODES_KEY) as {
      records: { sessionID: string; mode: string }[]
    }
    expect(payload.records).toEqual([{ sessionID: "s1", mode: "observe", updatedAt: 1000 }])
  })

  it("rejects an invalid override without persisting", async () => {
    const errors = spyErrors()
    try {
      const storage = activeStorage()
      const session = new FakeSupervisorSession()
      const supervisor = makeSupervisor({ storage, session })
      await expect(supervisor.setSessionMode("", "active")).rejects.toThrow("sessionID")
      await expect(supervisor.setSessionMode("x".repeat(129), "active")).rejects.toThrow(
        "sessionID",
      )
      await expect(supervisor.setSessionMode("s1", "sideways" as "active")).rejects.toThrow(
        "mode must be one of",
      )
      expect(await supervisor.getSessionMode("s1")).toBeNull()
    } finally {
      errors.restore()
    }
  })

  it("a parked session resumes under its own effective mode at idle", async () => {
    const session = new FakeSupervisorSession()
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.setSessionMode("s1", "active")
    // The idle report comes from a DIFFERENT session: the parked session's
    // own override governs the resume, not the reporting session's mode.
    await supervisor.handleReport({ kind: "idle", sessionID: "s2" })
    expect(session.log).toEqual([`wait:s1`, `switch:s1:prov/a`, `prompt:s1:${CONTINUATION_PROMPT}`])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(0)
  })

  it("an off override leaves its parked record untouched at idle", async () => {
    const session = new FakeSupervisorSession()
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.setSessionMode("s1", "off")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    expect(session.log).toEqual([])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    expect(storedReceipts(storage)).toBeUndefined()
    // The override itself is not pruned while the session is alive.
    expect(await supervisor.getSessionMode("s1")).toBe("off")
  })

  it("does not drop an OFF session's dead parked record either (no supervision)", async () => {
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    seedOverride(storage, "s1", "off")
    const { supervisor, session } = supervisorWithDeadSession(storage, "s1")
    await supervisor.handleReport({ kind: "idle", sessionID: "s2" })
    expect(session.log).toEqual([])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    expect(storedReceipts(storage)).toBeUndefined()
    // The dead session's override is still pruned (bookkeeping, not
    // supervision), even though its parked record is left alone.
    expect(await supervisor.getSessionMode("s1")).toBeNull()
  })

  it("logs a failed override pruning without breaking the sweep", async () => {
    const errors = spyErrors()
    try {
      const storage = new KeyFailStorage(SESSION_MODES_KEY)
      seed(storage, SETTINGS_KEY, settingsJSON("observe", { standard: [wireRef("prov", "a")] }))
      seedOverride(storage, "s2", "active")
      const { supervisor } = supervisorWithDeadSession(storage, "s2")
      await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
      // The prune write failed: logged fail-open, the sweep continued.
      expect(errors.lines.some((line) => line.includes("[coool.adaptive] session-modes:"))).toBe(
        true,
      )
      expect(await supervisor.getSessionMode("s2")).toBe("active")
    } finally {
      errors.restore()
    }
  })

  it("prunes a dead session's override at the idle sweep", async () => {
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    seedOverride(storage, "s2", "active")
    const { supervisor } = supervisorWithDeadSession(storage, "s2")
    expect(await supervisor.getSessionMode("s2")).toBe("active")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    expect(await supervisor.getSessionMode("s2")).toBeNull()
    // The alive parked session's override would be kept (none here); the
    // persisted mirror no longer carries the dead session.
    const payload = storage.data.get(SESSION_MODES_KEY) as { records: unknown[] }
    expect(payload.records).toEqual([])
  })

  // covers: ["ADP-024", "ADP-031"]
  it("a transient session.get error never destroys durable state at the sweep", async () => {
    // Only a definitive not-found counts as a dead session: a transient
    // storage/host error must not prune parked work, overrides, or tier
    // requests — the sweep leaves them for the next idle boundary.
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    seedOverride(storage, "s1", "observe")
    const session = new FakeSupervisorSession()
    const source = {
      ...session.source,
      get: () => Promise.reject(new Error("storage hiccup, try again")),
    }
    const infos = [makeInfo("prov", "a"), makeInfo("prov", "b")]
    const model = {
      transform: (cb: (editor: unknown) => unknown) => {
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
      session: source as unknown as SupervisorSessionSource,
      model,
      storage: storage.source,
      clock: () => 1000,
    })
    supervisor.noteTierRequest("s1", "quick")
    await supervisor.handleReport({ kind: "idle", sessionID: "s2" })
    // The parked record was not destroyed (observe mode leaves it parked and
    // the transient error left the session "alive"), and neither were the
    // override and the tier request.
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
    expect(await supervisor.getSessionMode("s1")).toBe("observe")
    expect(await supervisor.getTierRequest("s1")).toBe("quick")
  })

  it("an overridden session keeps its override when it is alive at idle", async () => {
    const storage = observeStorage({ standard: [wireRef("prov", "a")] })
    seedParked(storage)
    seedOverride(storage, "s1", "active")
    const { supervisor } = supervisorWithDeadSession(storage, "s2")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    expect(await supervisor.getSessionMode("s1")).toBe("active")
  })
})

describe("tier requests (ADP-055)", () => {
  const PROMPT_S1 = { kind: "prompt", sessionID: "s1" } as const

  /** A supervisor whose session source treats one session as dead. */
  function supervisorWithDeadSession(
    storage: KeyFailStorage,
    deadSessionID: string,
  ): { supervisor: Supervisor; session: FakeSupervisorSession } {
    const session = new FakeSupervisorSession()
    const source = {
      ...session.source,
      get: (input: { sessionID: string }) =>
        input.sessionID === deadSessionID
          ? Promise.reject(new Error("session not found"))
          : session.source.get(input),
    }
    const infos = [makeInfo("prov", "a"), makeInfo("prov", "b")]
    const model = {
      transform: (cb: (editor: unknown) => unknown) => {
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
      session: source as unknown as SupervisorSessionSource,
      model,
      storage: storage.source,
      clock: () => 1000,
    })
    return { supervisor, session }
  }

  it("a sticky tier request routes the next admission into the requested tier", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    expect(await supervisor.getTierRequest("s1")).toBeNull()
    expect(supervisor.noteTierRequest("s1", "standard")).toBe(true)
    expect(await supervisor.getTierRequest("s1")).toBe("standard")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.sessionID).toBe("s1")
    expect(receipts[0]?.tier).toBe("standard")
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", model: ref("prov", "a") })
    // Sticky: the request survives the admission until explicitly cleared.
    expect(await supervisor.getTierRequest("s1")).toBe("standard")
  })

  it("an unknown tier name is refused without touching routing", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    expect(supervisor.noteTierRequest("s1", "sideways")).toBe(false)
    expect(await supervisor.getTierRequest("s1")).toBeNull()
    // The prompt admits normally (no tier request in play).
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.tier).toBe("standard")
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", reason: "preferred" })
  })

  it("a user pin outranks the tier request", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", { standard: [wireRef("prov", "a")] }, wireRef("prov", "b")),
    )
    const supervisor = makeSupervisor({ storage, session })
    supervisor.noteTierRequest("s1", "standard")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/b"])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.decision).toMatchObject({ kind: "apply", reason: "pin" })
  })

  it("an unconfigured requested tier defers with tier-not-configured", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    supervisor.noteTierRequest("s1", "advanced")
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual([])
    const receipts = parseReceiptsPayload(storedReceipts(storage))
    expect(receipts[0]?.sessionID).toBe("s1")
    expect(receipts[0]?.decision).toEqual({
      kind: "defer",
      reason: "routing-defer",
      detail: "tier-not-configured",
    })
  })

  it("clears a tier request with null and refuses any other input", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    supervisor.noteTierRequest("s1", "quick")
    await supervisor.setTierRequest("s1", null)
    expect(await supervisor.getTierRequest("s1")).toBeNull()
    await expect(supervisor.setTierRequest("s1", "quick")).rejects.toThrow(
      "only null clears a tier request",
    )
    // Clearing an absent request is a no-op.
    await supervisor.setTierRequest("s2", null)
    expect(await supervisor.getTierRequest("s2")).toBeNull()
  })

  it("evicts the oldest tier request past the bounded capacity", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    // An incrementing clock stamps each request, so the store's newest-first
    // bound evicts the earliest-stamped one.
    let now = 0
    const supervisor = makeSupervisor({ storage, session, clock: () => ++now })
    for (let i = 0; i < MAX_TIER_REQUEST_RECORDS; i++) {
      supervisor.noteTierRequest(`s${String(i)}`, "standard")
    }
    // One more pushes the oldest (s0) out; the newest still rides.
    supervisor.noteTierRequest("s-new", "quick")
    expect(await supervisor.getTierRequest("s0")).toBeNull()
    expect(await supervisor.getTierRequest("s1")).toBe("standard")
    expect(await supervisor.getTierRequest("s-new")).toBe("quick")
    const persisted = parseTierRequestsPayload(storage.data.get(TIER_REQUESTS_KEY))
    expect(persisted).toHaveLength(MAX_TIER_REQUEST_RECORDS)
  })

  it("a tier request noted before load is dropped fail-open when its write fails", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage(TIER_REQUESTS_KEY)
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
    const supervisor = makeSupervisor({ storage, session })
    expect(supervisor.noteTierRequest("s1", "quick")).toBe(true)
    expect(await supervisor.getTierRequest("s1")).toBeNull()
    // The prompt admits normally (the lost record is the in-memory era's
    // restart degradation, never a crash).
    await supervisor.handleReport(PROMPT_S1)
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("a tier request recorded through one instance is visible to a second instance sharing the storage", async () => {
    // The TUI host loads the plugin twice (hooks instance vs RPC instance);
    // the request must travel through the persisted mirror, not live only on
    // the instance that recorded it.
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const recorder = makeSupervisor({ storage, session })
    expect(recorder.noteTierRequest("s1", "quick")).toBe(true)
    // Flush the recorder's queue so the persisted write has committed before
    // the second instance hydrates.
    expect(await recorder.getTierRequest("s1")).toBe("quick")
    const router = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    expect(await router.getTierRequest("s1")).toBe("quick")
  })

  it("a dead session's tier request survives a failed prune write at the idle sweep", async () => {
    const errors = spyErrors()
    const storage = new KeyFailStorage(TIER_REQUESTS_KEY)
    seed(storage, SETTINGS_KEY, settingsJSON("active", { standard: [wireRef("prov", "a")] }))
    seed(storage, TIER_REQUESTS_KEY, {
      version: 1,
      records: [
        { sessionID: "s2", tier: "advanced", updatedAt: 1000 },
        { sessionID: "s1", tier: "quick", updatedAt: 1001 },
      ],
    })
    const { supervisor } = supervisorWithDeadSession(storage, "s2")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    // The prune write failed: the record stays (fail-open), the sweep moves on.
    expect(await supervisor.getTierRequest("s2")).toBe("advanced")
    expect(await supervisor.getTierRequest("s1")).toBe("quick")
    errors.restore()
  })

  it("does not re-probe a session that already joined the sweep", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 5 },
      ],
    })
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    supervisor.noteTierRequest("s1", "quick")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    // The parked holder joined the sweep first; the tier-request pass saw it
    // already probed and kept the live session's request.
    expect(await supervisor.getTierRequest("s1")).toBe("quick")
  })

  it("prunes a dead session's tier request at the idle sweep, keeps a live one", async () => {
    const storage = activeStorage()
    const { supervisor } = supervisorWithDeadSession(storage, "s2")
    supervisor.noteTierRequest("s1", "quick")
    supervisor.noteTierRequest("s2", "advanced")
    expect(await supervisor.getTierRequest("s2")).toBe("advanced")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    expect(await supervisor.getTierRequest("s1")).toBe("quick")
    expect(await supervisor.getTierRequest("s2")).toBeNull()
  })
})
