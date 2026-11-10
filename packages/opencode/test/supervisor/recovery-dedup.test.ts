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

const retryInput = (model: "a" | "b" | "c") => ({
  sessionID: "s1",
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
