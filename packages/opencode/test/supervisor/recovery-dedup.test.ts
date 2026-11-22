// covers: ["ADP-023"]
// Regression: a burst of retry-hook failures (parallel model calls in one
// turn, event replay after a plugin reload) each vetoed the host retry and
// each started its own owned recovery — the user saw N stacked "Continue the
// interrupted work…" prompts within a second (nine same-model admission
// receipts in 85 ms in the production receipt ring). The quota path already
// guards with #recoveryPending; the retry-veto path did not. At most one
// owned continuation chain may be in flight per session, whatever the call
// site. The vetoes here are unit-less on purpose: production's stacked
// receipts carried no unit, and a unit-less veto never consumes the
// per-unit veto budget, so only the pending guard bounds the burst.
import { describe, expect, it } from "vitest"

import { CONTINUATION_PROMPT } from "@coool/adaptive-core/execution/index"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/index"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"

import { processLedger } from "../../src/adapters/opencode/process-ledger.js"
import { wireRef } from "../adapters/opencode/helpers.js"
import {
  FakeSupervisorSession,
  activeStorage,
  flush,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  storedReceipts,
} from "./helpers.js"

/** Active mode with a three-model standard ladder, so consecutive failures always have a next resource. */
function ladderStorage(): ReturnType<typeof activeStorage> {
  const storage = activeStorage()
  seed(
    storage,
    SETTINGS_KEY,
    settingsJSON("active", {
      standard: [wireRef("prov", "a"), wireRef("prov", "b"), wireRef("prov", "c")],
    }),
  )
  return storage
}

const retryInput = (model: "a" | "b" | "c", sessionID = "s1") => ({
  sessionID,
  model: ref("prov", model),
  error: { type: "UnknownError", message: "", status: 429 },
  attempt: 1,
  decision: { retry: true, delay: 100 },
})

describe("one owned continuation per session", () => {
  it("a second vetoed retry while a recovery is pending folds into the pending chain", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    const supervisor = makeSupervisor({ storage: ladderStorage(), session })

    // No execution-started report: the retry hook fires unit-less, the shape
    // the production burst's receipts show.
    const first = retryInput("a")
    await supervisor.handleRetry(first)
    // The first chain is now parked mid-settle (wait is held). A second
    // failure of the same model arrives while the recovery is still in
    // flight — the admission re-applies the same healthy fallback.
    const second = retryInput("a")
    await supervisor.handleRetry(second)
    await flush()

    // Both host retries are vetoed either way: a host retry would race the
    // pending settle→switch→prompt chain.
    expect(first.decision).toEqual({ retry: false })
    expect(second.decision).toEqual({ retry: false })
    // Exactly one settle so far: the second veto folded into the pending
    // recovery instead of starting its own chain.
    expect(session.log.filter((entry) => entry === "wait:s1")).toHaveLength(1)

    session.releaseWait()
    await flush()
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/b", `prompt:s1:${CONTINUATION_PROMPT}`])
  })

  it("the fold leaves one admission receipt, not one per vetoed failure", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    const storage = ladderStorage()
    const supervisor = makeSupervisor({ storage, session })

    await supervisor.handleRetry(retryInput("a"))
    const afterFirst = parseReceiptsPayload(storedReceipts(storage)).length

    await supervisor.handleRetry(retryInput("a"))
    await flush()
    expect(parseReceiptsPayload(storedReceipts(storage))).toHaveLength(afterFirst)

    session.releaseWait()
    await flush()
  })

  it("concurrent retry hooks on one session start exactly one recovery", async () => {
    const session = new FakeSupervisorSession()
    const waiters: (() => void)[] = []
    session.source.wait = () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    const storage = ladderStorage()
    const supervisor = makeSupervisor({ storage, session })

    // Production's 400 ms burst: the same failed turn reports through several
    // retry hooks before the first recovery has set its pending marker. Every
    // hook checks the marker, awaits admission, and only then starts a chain —
    // so a marker set after those awaits cannot serialize them.
    const inputs = Array.from({ length: 8 }, () => retryInput("a"))
    await Promise.all(inputs.map((input) => supervisor.handleRetry(input)))
    await flush()

    for (const input of inputs) expect(input.decision).toEqual({ retry: false })
    expect(waiters).toHaveLength(1)
    expect(session.log.filter((entry) => entry.startsWith("prompt:s1:"))).toHaveLength(0)

    waiters[0]?.()
    await flush()
    expect(session.log).toEqual(["switch:s1:prov/b", `prompt:s1:${CONTINUATION_PROMPT}`])
  })

  it("duplicate plugin instances deliver one continuation for the same failure", async () => {
    const holder = {}
    const storage = ladderStorage()
    const firstSession = new FakeSupervisorSession()
    const secondSession = new FakeSupervisorSession()
    const waiters: (() => void)[] = []
    for (const session of [firstSession, secondSession]) {
      session.source.wait = () =>
        new Promise<void>((resolve) => {
          waiters.push(resolve)
        })
    }
    const firstSupervisor = makeSupervisor({
      storage,
      session: firstSession,
      ledger: processLedger(holder),
    })
    const secondSupervisor = makeSupervisor({
      storage,
      session: secondSession,
      ledger: processLedger(holder),
    })

    // The host loads the plugin twice (ADP-056); both instances receive the
    // same failed turn and each has its own empty pending map. The shared
    // ledger claim is the only thing that can serialize them.
    const first = retryInput("a")
    const second = retryInput("a")
    await Promise.all([firstSupervisor.handleRetry(first), secondSupervisor.handleRetry(second)])
    await flush()

    expect(first.decision).toEqual({ retry: false })
    expect(second.decision).toEqual({ retry: false })
    expect(waiters).toHaveLength(1)

    waiters[0]?.()
    await flush()
    const prompts = [...firstSession.log, ...secondSession.log].filter((entry) =>
      entry.startsWith("prompt:s1:"),
    )
    expect(prompts).toEqual([`prompt:s1:${CONTINUATION_PROMPT}`])
  })

  it("each duplicate instance's receipt survives the other instance's next write", async () => {
    const holder = {}
    const storage = ladderStorage()
    const one = makeSupervisor({
      storage,
      session: new FakeSupervisorSession(),
      ledger: processLedger(holder),
    })
    const two = makeSupervisor({
      storage,
      session: new FakeSupervisorSession(),
      ledger: processLedger(holder),
    })
    // Both instances load the empty ring before either writes — the
    // production split where one instance hears the hooks and another
    // serves RPC. Each then records a receipt from its own stale view.
    await Promise.all([one.settings(), two.settings()])
    await Promise.all([
      one.handleRetry(retryInput("a", "s1")),
      two.handleRetry(retryInput("a", "s2")),
    ])
    await flush()

    const persisted = parseReceiptsPayload(storedReceipts(storage))
    expect(persisted.map((receipt) => receipt.id)).toEqual([1, 2])
    expect(persisted.map((receipt) => receipt.sessionID).sort()).toEqual(["s1", "s2"])
    // Either instance's view refreshes from the shared key instead of
    // serving the ring it loaded at startup.
    expect((await one.receipts()).map((receipt) => receipt.id)).toEqual([2, 1])
    expect((await two.receipts()).map((receipt) => receipt.id)).toEqual([2, 1])
  })

  it("a recovery that starts after the pending one completes still continues the work", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    const supervisor = makeSupervisor({ storage: ladderStorage(), session })

    await supervisor.handleRetry(retryInput("a"))
    session.releaseWait()
    await flush()
    // The pending chain finished; the next failure must start a fresh
    // recovery, not fold into the finished one.
    await supervisor.handleRetry(retryInput("a"))
    session.releaseWait()
    await flush()
    expect(session.log.filter((entry) => entry === "wait:s1")).toHaveLength(2)
    expect(session.log.filter((entry) => entry.startsWith("prompt:s1:"))).toHaveLength(2)
  })

  it("an escalation while a recovery is pending folds into the pending chain", async () => {
    const session = new FakeSupervisorSession({ holdWait: true })
    // The escalation call site has no pending guard of its own before this
    // regression — the skip-guard mirrors the quota path's rule.
    const storage = activeStorage()
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", {
        standard: [wireRef("prov", "a"), wireRef("prov", "b")],
        advanced: [wireRef("prov", "b")],
      }),
    )
    const supervisor = makeSupervisor({ storage, session })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
    await supervisor.handleReport({
      kind: "model-request",
      sessionID: "s1",
      model: ref("prov", "a"),
      requestKind: "primary",
    })

    // A quota veto's chain is mid-settle when a capability failure escalates.
    await supervisor.handleRetry(retryInput("a"))
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: 20,
      error: { type: "UnknownError", message: "", status: 413 },
    })
    await flush()
    expect(session.log.filter((entry) => entry === "wait:s1")).toHaveLength(1)

    session.releaseWait()
    await flush()
    expect(session.log.filter((entry) => entry.startsWith("prompt:s1:"))).toHaveLength(1)
  })
})
