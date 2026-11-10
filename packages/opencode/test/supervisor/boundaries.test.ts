/**
 * Cross-cutting invariants through the supervisor's public entry points:
 * privacy of everything persisted (ADP-030/051), user cancellation never
 * failing over (ADP-010), and settings durability (ADP-036).
 */
// covers: ["ADP-010", "ADP-030", "ADP-036", "ADP-051"]
import { describe, expect, it, vi } from "vitest"

import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/index"
import { MAX_RECEIPTS } from "@coool/adaptive-core/state/receipts/types"
import { RECEIPTS_VIEW_LIMIT } from "../../src/supervisor/view.js"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import {
  activeStorage,
  FakeSupervisorSession,
  flush,
  KeyFailStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  storedReceipts,
} from "./helpers.js"

const STARTED = { kind: "execution-started", sessionID: "s1", at: 10 } as const
const SECRET = "sk-LEAK-0123456789"

function retryInput(message: string, status?: number) {
  return {
    sessionID: "s1",
    model: ref("prov", "a"),
    error: { type: "UnknownError", message, ...(status !== undefined ? { status } : {}) },
    attempt: 1,
    decision: { retry: true, delay: 100 } as { retry: false } | { retry: true; delay: number },
  }
}

describe("privacy: nothing the host reports as error text is persisted (ADP-051)", () => {
  it("keeps error messages, response bodies and credentials out of every stored key, receipt and prompt", async () => {
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", {
        standard: [wireRef("prov", "a"), wireRef("prov", "b")],
        advanced: [wireRef("prov", "c")],
      }),
    )
    const supervisor = makeSupervisor({
      storage,
      session,
      infos: [makeInfo("prov", "a"), makeInfo("prov", "b"), makeInfo("prov", "c")],
    })
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
      bodyExcerpt: `{"error":"${SECRET}"}`,
      capturedHeaders: { "x-codex-primary-used-percent": "40", authorization: `Bearer ${SECRET}` },
    })
    // A retry-hook recovery whose error text carries the credential.
    await supervisor.handleRetry(retryInput(`Bearer ${SECRET} rate limit`, 429))
    await flush()
    // The recovered continuation hits a capability failure carrying it too.
    await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 20 })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 30,
      error: {
        type: "UnknownError",
        message: `context length exceeded for key ${SECRET}`,
        status: 400,
        response: { body: `echo ${SECRET}` },
      },
    })
    await flush()
    // Even the escalation tool's free text is bounded evidence, not a receipt field.
    supervisor.noteEscalationRequest("s1", `reason ${SECRET}`, `evidence ${SECRET}`)

    const everything = JSON.stringify([...storage.data.entries()])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain("Bearer")
    expect(JSON.stringify(await supervisor.receipts())).not.toContain(SECRET)
    expect(JSON.stringify(await supervisor.status())).not.toContain(SECRET)
    expect(session.log.join("\n")).not.toContain(SECRET)
    // The narrative itself is intact: privacy is not bought by dropping receipts.
    expect(parseReceiptsPayload(storedReceipts(storage)).length).toBeGreaterThan(1)
  })
})

describe("user cancellation never fails over (ADP-010)", () => {
  const cancelled = {
    type: "UnknownError",
    message: "The request was cancelled by the user",
  } as const

  it("a terminal failure the host words as a cancellation starts no recovery and benches nothing", async () => {
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
      error: cancelled,
    })
    await flush()
    // Only the admission switch: no settle, no second switch, no continuation.
    expect(session.log).toEqual(["switch:s1:prov/a"])
    expect(parseReceiptsPayload(storedReceipts(storage))[0]?.outcome).toEqual({
      status: "failed",
      category: "user_cancelled",
    })
    // No health damage: the next prompt still lands on the preferred model.
    await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    expect(session.log).toEqual(["switch:s1:prov/a", "switch:s1:prov/a"])
  })

  it("the retry hook leaves a cancellation to the host: no veto, no recovery, no probe", async () => {
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED)
    const input = retryInput(cancelled.message)
    await supervisor.handleRetry(input)
    await flush()
    expect(input.decision).toEqual({ retry: true, delay: 100 })
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })

  it("a user interrupt after a vetoed failure aborts the pending continuation before any prompt", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED)
    const input = retryInput("", 429)
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await supervisor.handleReport({
      kind: "execution-interrupted",
      sessionID: "s1",
      at: 15,
      reason: "user",
    })
    session.releaseWait()
    await flush()
    expect(session.log.some((entry) => entry.startsWith("prompt:"))).toBe(false)
    expect(session.log.filter((entry) => entry.startsWith("switch:"))).toEqual(["switch:s1:prov/a"])
  })
})

describe("settings durability (ADP-036)", () => {
  it("a failed settings write advances nothing and leaves routing as it was", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const session = new FakeSupervisorSession()
    const storage = new KeyFailStorage(SETTINGS_KEY)
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", { standard: [wireRef("prov", "a"), wireRef("prov", "b")] }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await expect(supervisor.updateSettings({ mode: "off" })).rejects.toThrow("write failed")
    expect((await supervisor.settings()).mode).toBe("active")
    await supervisor.handleReport(STARTED)
    expect(session.log).toEqual(["switch:s1:prov/a"])
    errors.mockRestore()
  })

  it("a rejected patch names the offending field and persists nothing", async () => {
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    const before = JSON.stringify(storage.data.get(SETTINGS_KEY))
    const result = await supervisor.updateSettings({
      mode: "bogus" as never,
      pin: { providerID: "", id: "m" },
      tiers: { quick: [] } as never,
    })
    expect(result).toEqual({
      ok: false,
      errors: ["invalid mode", 'invalid tiers: missing "standard", "advanced"', "invalid pin"],
    })
    expect(JSON.stringify(storage.data.get(SETTINGS_KEY))).toBe(before)
  })
})

describe("receipt retention is bounded (ADP-030)", () => {
  it("evicts the oldest receipts past the ring and serves only the newest page, newest first", async () => {
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
    const units = MAX_RECEIPTS + 25
    for (let unit = 1; unit <= units; unit += 1) {
      await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: unit })
      await supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: unit })
    }
    const stored = parseReceiptsPayload(storedReceipts(storage))
    expect(stored).toHaveLength(MAX_RECEIPTS)
    // Ids are monotonic and the survivors are the newest ones.
    expect(stored.at(-1)?.id).toBe(units)
    expect(stored[0]?.id).toBe(units - MAX_RECEIPTS + 1)
    const view = await supervisor.receipts()
    expect(view).toHaveLength(RECEIPTS_VIEW_LIMIT)
    expect(view.map((receipt) => receipt.id)).toEqual(
      Array.from({ length: RECEIPTS_VIEW_LIMIT }, (_, index) => units - index),
    )
    expect((await supervisor.status()).receipts).toBe(MAX_RECEIPTS)
  })
})

describe("manual intent aborts a pending owned recovery (ADP-028)", () => {
  const failure = { type: "UnknownError", message: "", status: 429 }

  async function vetoedWhileSettling() {
    const session = new FakeSupervisorSession({ holdWait: true })
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport(STARTED)
    const input = retryInput("", 429)
    await supervisor.handleRetry(input)
    expect(input.decision).toEqual({ retry: false })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 15,
      error: failure,
    })
    return { session, supervisor }
  }

  const prompts = (log: readonly string[]): string[] =>
    log.filter((entry) => entry.startsWith("prompt:"))

  it("a fresh user prompt during the settle is not followed by a stale continuation", async () => {
    const { session, supervisor } = await vetoedWhileSettling()
    await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 20 })
    const before = [...session.log]
    session.releaseWait()
    await flush()
    expect(prompts(session.log)).toEqual([])
    // The recovery did nothing at all after the settle: no switch either.
    expect(session.log).toEqual(before)
  })

  it("a manual model pick during the settle is not overridden by the recovery's switch", async () => {
    const { session, supervisor } = await vetoedWhileSettling()
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      model: ref("prov", "picked-by-user"),
      at: 20,
    })
    const before = [...session.log]
    session.releaseWait()
    await flush()
    expect(session.log).toEqual(before)
  })

  it("the abort does not outlive its recovery: a later failure still recovers", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const session = new FakeSupervisorSession()
    const storage = activeStorage()
    const supervisor = makeSupervisor({ storage, session })
    // The first settle stays pending, then fails instead of returning, so the
    // post-settle guard never gets to consume the steering signal.
    let failSettle: (error: Error) => void = () => undefined
    session.source.wait = () =>
      new Promise<void>((_, reject) => {
        failSettle = reject
      })
    await supervisor.handleReport(STARTED)
    await supervisor.handleRetry(retryInput("", 429))
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 15,
      error: failure,
    })
    await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
    failSettle(new Error("settle failed"))
    await flush()
    // A new, unrelated failure on the session recovers normally.
    session.source.wait = () => Promise.resolve()
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 30 })
    await supervisor.handleRetry(retryInput("", 429))
    await flush()
    expect(prompts(session.log)).toHaveLength(1)
    errors.mockRestore()
  })
})
