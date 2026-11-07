/**
 * Parked-work wake (ADP-024): when every model of the tier is out of quota
 * the work parks, and a timer resumes it once the earliest model's window
 * ends — without a user prompt, without a second instance doubling the
 * continuation, and without looping when resumes keep failing.
 */
// covers: ["ADP-022", "ADP-024", "ADP-056"]
import { describe, expect, it, vi } from "vitest"

import { processLedger, type ProcessLedger } from "../../src/adapters/opencode/process-ledger.js"
import { CONTINUATION_PROMPT } from "../../src/execution/index.js"
import {
  FRUITLESS_BASE_MS,
  MAX_WAKE_MS,
  MIN_WAKE_MS,
  UNKNOWN_WAKE_MS,
  WAKE_GRACE_MS,
} from "../../src/execution/parking/wake.js"
import { parseParkedPayload } from "../../src/state/parked-work/index.js"
import { PARKED_KEY } from "../../src/state/parked-work/types.js"
import { parseReceiptsPayload } from "../../src/state/receipts/index.js"
import { HEALTH_KEY } from "../../src/state/health/types.js"
import type { RetryHookInput } from "../../src/supervisor/types.js"
import { DEFAULT_HEALTH_CONFIG } from "../../src/health/resource-health/types.js"
import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import {
  activeStorage,
  FakeScheduler,
  FakeSupervisorSession,
  flush,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
  storedParked,
  storedReceipts,
} from "./helpers.js"

const QUOTA_WINDOW = DEFAULT_HEALTH_CONFIG.defaultQuotaWindowMs
const PROMPT = { kind: "prompt", sessionID: "s1" } as const
const CONTINUE = `prompt:s1:${CONTINUATION_PROMPT}`

function quotaFailure(at: number) {
  return {
    kind: "execution-failed",
    sessionID: "s1",
    at,
    error: { type: "UnknownError", message: "Model quota exhausted" },
  } as const
}

function parkedSeed(attempts?: number): Record<string, unknown> {
  return {
    version: 1,
    parked: [
      {
        id: "s1#1",
        sessionID: "s1",
        tier: "standard",
        reason: "all-blocked",
        parkedAt: 5,
        ...(attempts === undefined ? {} : { attempts }),
      },
    ],
  }
}

/** A clock the test moves, and the supervisor wired to it. */
function harness(
  options: {
    storage?: ReturnType<typeof activeStorage>
    session?: FakeSupervisorSession
    ledger?: ProcessLedger
  } = {},
) {
  const clock = { now: 1_000 }
  const session = options.session ?? new FakeSupervisorSession()
  const storage = options.storage ?? activeStorage()
  const scheduler = new FakeScheduler()
  const supervisor = makeSupervisor({
    storage,
    session,
    scheduler,
    clock: () => clock.now,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  })
  return { clock, session, storage, scheduler, supervisor }
}

/**
 * Holds every `prompt` call open (the call is logged at once) until
 * `releaseNext()` returns the oldest one still open.
 */
function holdPrompts(session: FakeSupervisorSession): { releaseNext: () => void } {
  const prompt = session.source.prompt.bind(session.source)
  const waiting: (() => void)[] = []
  session.source.prompt = (input) => {
    const delivered = prompt(input)
    return new Promise((resolve) => {
      waiting.push(() => {
        resolve(delivered)
      })
    })
  }
  return {
    releaseNext: () => {
      waiting.shift()?.()
    },
  }
}

/** A supervisor resuming the seeded s1 record once its first wake fires. */
async function seededHarness(
  options: { session?: FakeSupervisorSession; ledger?: ProcessLedger; attempts?: number } = {},
) {
  const storage = activeStorage()
  seed(storage, PARKED_KEY, parkedSeed(options.attempts))
  const h = harness({ ...options, storage })
  await h.supervisor.settings()
  await flush()
  return h
}

/** Advances the clock by the live timer's delay and fires it; returns the delay. */
async function wake(h: ReturnType<typeof harness>): Promise<number> {
  const delay = h.scheduler.pending()[0]?.delayMs ?? 0
  h.clock.now += delay
  await h.scheduler.fire()
  return delay
}

/**
 * One s1 turn on `id` that ends out of quota: the prompt, the host echoing the
 * model it runs, then the terminal failure (and the owned recovery it starts).
 */
async function runOutOfQuota(h: ReturnType<typeof harness>, id: string): Promise<void> {
  const { supervisor, clock } = h
  await supervisor.handleReport(PROMPT)
  await supervisor.handleReport({
    kind: "model-selected",
    sessionID: "s1",
    at: clock.now - 1,
    model: ref("prov", id),
  })
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: clock.now })
  await supervisor.handleReport(quotaFailure(clock.now))
  await flush()
}

/** Runs s1 into both standard models' quota (prov/a, then prov/b), parking it. */
async function exhaustBoth(h: ReturnType<typeof harness>): Promise<void> {
  await runOutOfQuota(h, "a")
  await runOutOfQuota(h, "b")
}

describe("parked-work wake", () => {
  it("resumes on the first model whose quota resets, without a user prompt", async () => {
    const h = harness()
    await exhaustBoth(h)
    expect(h.session.log).toEqual(["switch:s1:prov/a", "wait:s1", "switch:s1:prov/b", CONTINUE])
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    // One wake, just after prov/a's window (the earlier of the two) ends.
    const [timer] = h.scheduler.pending()
    expect(h.scheduler.pending()).toHaveLength(1)
    expect(timer?.delayMs).toBe(QUOTA_WINDOW + WAKE_GRACE_MS)
    const status = await h.supervisor.status()
    expect(status.waiting).toEqual([
      // When the wake lands, not just when the quota resets.
      { sessionID: "s1", tier: "standard", resumeAt: 1_000 + QUOTA_WINDOW + WAKE_GRACE_MS },
    ])

    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS
    await h.scheduler.fire()
    expect(h.session.log.slice(4)).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
    expect((await h.supervisor.status()).waiting).toEqual([])
  })

  it("parks when the continuation runs out of quota before its prompt call returns", async () => {
    // Regression: the host can fail the continuation unit while the recovery
    // that started it is still awaiting the prompt call; the failure was taken
    // for the superseded unit's echo and dropped, so nothing ever resumed.
    const h = harness()
    const { releaseNext } = holdPrompts(h.session)
    await runOutOfQuota(h, "a")
    await h.supervisor.handleReport(PROMPT)
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: h.clock.now - 1,
      model: ref("prov", "b"),
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    // The event pump does not await reports, so the failure is handled while
    // the recovery's prompt call is still open.
    const failed = h.supervisor.handleReport(quotaFailure(h.clock.now))
    await flush()
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    releaseNext()
    await failed
    await flush()
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([
      expect.objectContaining({ sessionID: "s1", tier: "standard", detail: "quota exhausted" }),
    ])
    expect(h.scheduler.pending()).toHaveLength(1)
  })

  it("a reset beyond the timer cap only re-plans at the cap: no sweep, no receipt", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const h = harness({ storage })
    // A provider-wide balance out until fifty minutes from now.
    await h.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s2",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    await h.supervisor.handleReport({
      kind: "http-response",
      sessionID: "s2",
      status: 402,
      retryAfterHeader: "3000",
    })
    await h.supervisor.updateSettings({ mode: "active" })
    const receipts = parseReceiptsPayload(storedReceipts(h.storage)).length
    expect(await wake(h)).toBe(MAX_WAKE_MS)
    expect(h.session.log).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(h.storage))).toHaveLength(receipts)
    expect(h.scheduler.pending().map((timer) => timer.delayMs)).toEqual([
      3_000_000 + WAKE_GRACE_MS - MAX_WAKE_MS,
    ])
  })

  it("a timer that fires a moment early still resumes", async () => {
    // Timers may fire slightly before the wall clock reads the due time (or
    // the clock steps back); an uncapped wake is due whenever it fires.
    const h = harness()
    await exhaustBoth(h)
    h.clock.now += QUOTA_WINDOW + WAKE_GRACE_MS - 1
    await h.scheduler.fire()
    expect(h.session.log.at(-1)).toBe(CONTINUE)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("re-arms from persisted parked work and health after a restart", async () => {
    const first = harness()
    await exhaustBoth(first)
    first.supervisor.dispose()
    expect(first.scheduler.pending()).toEqual([])

    const scheduler = new FakeScheduler()
    const session = new FakeSupervisorSession()
    const clock = { now: first.clock.now + 60_000 }
    const restarted = makeSupervisor({
      storage: first.storage,
      session,
      scheduler,
      clock: () => clock.now,
    })
    await restarted.settings()
    await flush()
    expect(scheduler.pending().map((timer) => timer.delayMs)).toEqual([
      QUOTA_WINDOW + WAKE_GRACE_MS - 60_000,
    ])
    // No instance hears the host yet, so its own wake is the one that resumes.
    expect((await restarted.status()).waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: 1_000 + QUOTA_WINDOW + WAKE_GRACE_MS },
    ])
    clock.now += QUOTA_WINDOW
    await scheduler.fire()
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
  })

  it("a wake that resumes nothing backs off, and a resume resets the backoff", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const holder = {}
    // The other plugin instance holds s1's claim.
    const other = processLedger(holder)
    other.claim("s1")
    const scheduler = new FakeScheduler()
    const session = new FakeSupervisorSession()
    const clock = { now: 1_000 }
    const supervisor = makeSupervisor({
      storage,
      session,
      scheduler,
      clock: () => clock.now,
      ledger: processLedger(holder),
    })
    await supervisor.settings()
    await flush()
    const delays: number[] = []
    for (let wake = 0; wake < 3; wake += 1) {
      const [timer] = scheduler.pending()
      delays.push(timer?.delayMs ?? 0)
      clock.now += timer?.delayMs ?? 0
      await scheduler.fire()
    }
    expect(delays).toEqual([MIN_WAKE_MS, FRUITLESS_BASE_MS, FRUITLESS_BASE_MS * 2])
    expect(session.log).toEqual([])

    other.release("s1")
    clock.now += scheduler.pending()[0]?.delayMs ?? 0
    await scheduler.fire()
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
  })

  it("re-checks on a fixed cadence when no model states a reset", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const h = harness({ storage })
    // Both models are unavailable (auth): no window says when they recover.
    for (const id of ["a", "b"]) {
      await h.supervisor.handleReport({
        kind: "model-request",
        sessionID: "s2",
        model: ref("prov", id),
        requestKind: "primary",
      })
      await h.supervisor.handleReport({ kind: "http-response", sessionID: "s2", status: 401 })
    }
    await h.supervisor.updateSettings({ mode: "active" })
    expect(h.scheduler.pending().map((timer) => timer.delayMs)).toEqual([UNKNOWN_WAKE_MS])
    expect((await h.supervisor.status()).waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: null },
    ])
    h.clock.now += UNKNOWN_WAKE_MS
    await h.scheduler.fire()
    expect(h.session.log).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)?.decision).toMatchObject({
      kind: "park",
    })
    expect(h.scheduler.pending().map((timer) => timer.delayMs)).toEqual([UNKNOWN_WAKE_MS])
    // The same outcome again records nothing new: a wait with no stated end
    // must not fill the receipt ring.
    const receipts = parseReceiptsPayload(storedReceipts(h.storage)).length
    await wake(h)
    expect(parseReceiptsPayload(storedReceipts(h.storage))).toHaveLength(receipts)
  })

  it("two plugin instances continue a parked unit exactly once", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const holder = {}
    const clock = { now: 1_000 }
    const session = new FakeSupervisorSession()
    const instances = [new FakeScheduler(), new FakeScheduler()].map((scheduler) => ({
      scheduler,
      supervisor: makeSupervisor({
        storage,
        session,
        scheduler,
        clock: () => clock.now,
        ledger: processLedger(holder),
      }),
    }))
    for (const { supervisor } of instances) await supervisor.settings()
    await flush()
    clock.now += MIN_WAKE_MS
    // Both wakes fire together: whichever loses finds the session claimed or
    // the record already gone from the re-read store.
    for (const { scheduler } of instances) {
      const [timer] = scheduler.pending()
      if (timer !== undefined) timer.cancelled = true
      timer?.callback()
    }
    await flush()
    expect(session.log.filter((line) => line === CONTINUE)).toHaveLength(1)
    expect(parseParkedPayload(storedParked(storage))).toEqual([])
  })

  it("an instance that sees no host reports re-reads persisted health before resuming", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const idle = harness({ storage })
    await idle.supervisor.settings()
    await flush()
    // The event pump instance records both models out of quota afterwards.
    const pump = harness({ storage })
    pump.clock.now = idle.clock.now
    for (const id of ["a", "b"]) {
      await pump.supervisor.handleReport({
        kind: "model-request",
        sessionID: "s2",
        model: ref("prov", id),
        requestKind: "primary",
      })
      await pump.supervisor.handleReport({ kind: "http-response", sessionID: "s2", status: 402 })
    }
    await flush()
    expect(storage.data.get(HEALTH_KEY)).toBeDefined()
    idle.clock.now += MIN_WAKE_MS
    await idle.scheduler.fire()
    expect(idle.session.log).toEqual([])
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
  })

  it("gives up with a receipt once the resume cycles are spent", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed(4))
    const h = harness({ storage })
    await h.supervisor.settings()
    await flush()
    h.clock.now += MIN_WAKE_MS
    await h.scheduler.fire()
    expect(h.session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
    // The resumed unit runs every model out of quota again.
    await exhaustBoth(h)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)).toMatchObject({
      sessionID: "s1",
      decision: { kind: "park", detail: "gave up after 5 resume attempts" },
    })
    expect(h.scheduler.pending()).toEqual([])
    expect((await h.supervisor.status()).waiting).toEqual([])
  })

  it("parks instead of stopping when the quota ladder is spent but a model recovered", async () => {
    const h = harness()
    await runOutOfQuota(h, "a")
    // prov/a's window ends while prov/b runs: the second recovery returns to a.
    h.clock.now += QUOTA_WINDOW
    await runOutOfQuota(h, "b")
    h.clock.now += QUOTA_WINDOW
    await runOutOfQuota(h, "a")
    expect(h.session.log.filter((line) => line === CONTINUE)).toHaveLength(2)
    expect(parseReceiptsPayload(storedReceipts(h.storage)).at(-1)?.decision).toEqual({
      kind: "park",
      reason: "all-blocked",
      detail: "quota recovery budget spent",
    })
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    expect(h.scheduler.pending()).toHaveLength(1)
  })

  it("the user's own prompt or model pick takes the parked session over", async () => {
    for (const takeover of ["prompt", "pick"] as const) {
      const h = harness()
      await exhaustBoth(h)
      await h.supervisor.handleReport({ kind: "execution-succeeded", sessionID: "s1", at: 50 })
      if (takeover === "prompt") await h.supervisor.handleReport(PROMPT)
      else {
        await h.supervisor.handleReport({
          kind: "model-selected",
          sessionID: "s1",
          at: 60,
          model: ref("prov", "b"),
        })
      }
      expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
      expect(h.scheduler.pending()).toEqual([])
    }
  })

  it("turning the session or Adaptive off stops the wake; turning it back on re-arms", async () => {
    const h = harness()
    await exhaustBoth(h)
    await h.supervisor.setSessionMode("s1", "off")
    expect(h.scheduler.pending()).toEqual([])
    expect((await h.supervisor.status()).waiting).toEqual([])
    await h.supervisor.setSessionMode("s1", null)
    expect(h.scheduler.pending()).toHaveLength(1)
    await h.supervisor.updateSettings({ mode: "observe" })
    expect(h.scheduler.pending()).toEqual([])
    await h.supervisor.updateSettings({ mode: "active" })
    expect(h.scheduler.pending()).toHaveLength(1)
  })

  it("a disposed supervisor neither sweeps nor re-arms", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    const h = harness({ storage })
    await h.supervisor.settings()
    await flush()
    const [timer] = h.scheduler.pending()
    h.supervisor.dispose()
    expect(timer?.cancelled).toBe(true)
    // A callback already queued when the timer was cancelled.
    h.clock.now += MIN_WAKE_MS
    timer?.callback()
    await flush()
    await h.supervisor.updateSettings({ mode: "active" })
    expect(h.session.log).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
  })

  it("an idle sweep that resumes the work also cancels the pending wake", async () => {
    const h = harness()
    await exhaustBoth(h)
    h.clock.now += QUOTA_WINDOW
    await h.supervisor.handleReport({ kind: "idle", sessionID: "s2" })
    expect(h.session.log.at(-1)).toBe(CONTINUE)
    expect(h.scheduler.pending()).toEqual([])
  })

  it("a standing pin decides when parked work wakes", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON(
        "active",
        { standard: [wireRef("prov", "a"), wireRef("prov", "b")] },
        wireRef("prov", "b"),
      ),
    )
    const h = harness({ storage })
    // Only the pinned model is rate limited; the tier's prov/a is not.
    await h.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s2",
      model: ref("prov", "b"),
      requestKind: "primary",
    })
    await h.supervisor.handleReport({ kind: "http-response", sessionID: "s2", status: 429 })
    await h.supervisor.updateSettings({ mode: "active" })
    const window = DEFAULT_HEALTH_CONFIG.defaultRateLimitWindowMs
    expect(h.scheduler.pending().map((timer) => timer.delayMs)).toEqual([window + WAKE_GRACE_MS])
    expect((await h.supervisor.status()).waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: 1_000 + window + WAKE_GRACE_MS },
    ])
  })

  it("a pinned unit out of quota neither parks nor continues", async () => {
    const h = harness()
    await h.supervisor.handleReport(PROMPT)
    await h.supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: 999,
      model: ref("prov", "a"),
    })
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1_000 })
    // The user pins prov/b mid-unit: the pin owns routing, not the quota ladder.
    await h.supervisor.updateSettings({ pin: wireRef("prov", "b") })
    const receipts = parseReceiptsPayload(storedReceipts(h.storage)).length
    await h.supervisor.handleReport(quotaFailure(1_000))
    await flush()
    expect(h.session.log).toEqual(["switch:s1:prov/a"])
    expect(parseReceiptsPayload(storedReceipts(h.storage))).toHaveLength(receipts)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
  })

  it("a scheduler or claim failure is logged and leaves parked work for the idle boundary", async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line))
    })
    try {
      class ThrowingScheduler extends FakeScheduler {
        override schedule = (): (() => void) => {
          throw new Error("no timers")
        }
      }
      const storage = activeStorage()
      seed(storage, PARKED_KEY, parkedSeed())
      const broken = makeSupervisor({
        storage,
        session: new FakeSupervisorSession(),
        scheduler: new ThrowingScheduler(),
      })
      await broken.settings()
      await flush()
      expect(errors).toEqual(["[coool.adaptive] wake: Error: no timers"])

      errors.length = 0
      const h = harness({ storage: activeStorage() })
      seed(h.storage, PARKED_KEY, parkedSeed())
      const ledger: ProcessLedger = {
        ...processLedger({}),
        claim: () => {
          throw new Error("claims down")
        },
      }
      const scheduler = new FakeScheduler()
      const supervisor = makeSupervisor({
        storage: h.storage,
        session: h.session,
        scheduler,
        ledger,
        clock: () => h.clock.now,
      })
      await supervisor.settings()
      await flush()
      h.clock.now += MIN_WAKE_MS
      await scheduler.fire()
      expect(errors).toEqual(["[coool.adaptive] wake: Error: claims down"])
      expect(h.session.log).toEqual([])
      // The failed wake still re-plans.
      expect(scheduler.pending()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("a lost claim hands back the probe it admitted", async () => {
    const storage = activeStorage()
    seed(storage, PARKED_KEY, parkedSeed())
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("active", { standard: [wireRef("prov", "a")] }),
    )
    const holder = {}
    const other = processLedger(holder)
    other.claim("s1")
    const scheduler = new FakeScheduler()
    const session = new FakeSupervisorSession()
    const clock = { now: 1_000 }
    const supervisor = makeSupervisor({
      storage,
      session,
      scheduler,
      clock: () => clock.now,
      ledger: processLedger(holder),
    })
    // Trip prov/a's breaker (threshold 5 outage failures) from another session.
    for (let index = 0; index < 5; index += 1) {
      await supervisor.handleReport({
        kind: "model-request",
        sessionID: "s2",
        model: ref("prov", "a"),
        requestKind: "primary",
      })
      await supervisor.handleReport({ kind: "http-response", sessionID: "s2", status: 503 })
    }
    await supervisor.updateSettings({ mode: "active" })
    // The wake lands once the breaker is due: the admission takes the one
    // probe, then the other instance's claim turns the resume away.
    clock.now += scheduler.pending()[0]?.delayMs ?? 0
    await scheduler.fire()
    expect(session.log).toEqual([])
    other.release("s1")
    clock.now += scheduler.pending()[0]?.delayMs ?? 0
    await scheduler.fire()
    // A leaked probe would read as probe-in-flight and keep the work parked.
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
  })

  it("the other instance takes a resume it hears as Adaptive's own continuation", async () => {
    // Regression: the instance that resumes need not be the one hearing the
    // host. The listener took the resume's switch for a manual pick and its
    // prompt for the user's, re-routing the unit and resetting its cycles.
    const holder = {}
    const session = new FakeSupervisorSession()
    const resumer = await seededHarness({ session, ledger: processLedger(holder) })
    const listener = harness({ storage: resumer.storage, session, ledger: processLedger(holder) })
    await wake(resumer)
    expect(session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])

    listener.clock.now = resumer.clock.now
    await runOutOfQuota(listener, "a")
    // Not re-routed (no second switch to prov/a): its recovery moves on to b.
    expect(session.log.slice(3)).toEqual(["wait:s1", "switch:s1:prov/b", CONTINUE])
    await runOutOfQuota(listener, "b")
    // Parked again with the resume cycle the other instance spent.
    expect(parseParkedPayload(storedParked(resumer.storage))).toMatchObject([
      { sessionID: "s1", attempts: 1 },
    ])
    const kinds = parseReceiptsPayload(storedReceipts(resumer.storage)).map(
      (receipt) => receipt.decision.kind,
    )
    expect(kinds).not.toContain("defer")
  })

  it("an instance that hears no host leaves the resume to the one that does", async () => {
    const holder = {}
    const quiet = await seededHarness({ ledger: processLedger(holder) })
    const pump = await seededHarness({ ledger: processLedger(holder) })
    await pump.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s9",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    await wake(quiet)
    expect(quiet.session.log).toEqual([])
    expect(quiet.scheduler.pending().map((timer) => timer.delayMs)).toEqual([FRUITLESS_BASE_MS])
    await wake(pump)
    expect(pump.session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
  })

  it("a user prompt during the resume's settle drops the work instead of continuing", async () => {
    // Regression: the record is already popped while the resume settles, so
    // the takeover found nothing to drop and the stale continuation followed
    // the user's turn (then re-parked and resumed again).
    const h = await seededHarness()
    const wait = h.session.source.wait.bind(h.session.source)
    let settle = (): void => undefined
    h.session.source.wait = (input) =>
      new Promise((resolve) => {
        settle = () => {
          resolve(wait(input))
        }
      })
    await wake(h)
    await h.supervisor.handleReport(PROMPT)
    settle()
    await flush()
    expect(h.session.log).not.toContain(CONTINUE)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
  })

  it("a resume that fails to continue backs off before trying again", async () => {
    // Regression: the failed resume counted as resumed, so the re-parked
    // record woke a second later and spent its cycles in seconds.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const h = await seededHarness({ session: new FakeSupervisorSession({ failPrompt: true }) })
      await wake(h)
      expect(parseParkedPayload(storedParked(h.storage))).toMatchObject([{ attempts: 1 }])
      expect(h.scheduler.pending().map((timer) => timer.delayMs)).toEqual([FRUITLESS_BASE_MS])
    } finally {
      spy.mockRestore()
    }
  })

  it("a supervisor disposed mid-sweep resumes nothing", async () => {
    const h = await seededHarness()
    const get = h.session.source.get.bind(h.session.source)
    let answer = (): void => undefined
    h.session.source.get = (input) =>
      new Promise((resolve) => {
        answer = () => {
          resolve(get(input))
        }
      })
    await wake(h)
    h.supervisor.dispose()
    answer()
    await flush()
    expect(h.session.log).toEqual([])
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    expect(h.scheduler.pending()).toEqual([])
  })

  it("a prompt in a session Adaptive does not drive still ends its wait", async () => {
    // Regression: the user's turn in an OFF or OBSERVE session left the
    // parked work behind, to replay a stale continuation once turned back on.
    for (const turnOff of ["session", "global"] as const) {
      const h = harness()
      await exhaustBoth(h)
      if (turnOff === "session") await h.supervisor.setSessionMode("s1", "off")
      else await h.supervisor.updateSettings({ mode: "observe" })
      await h.supervisor.handleReport(PROMPT)
      expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
      if (turnOff === "session") await h.supervisor.setSessionMode("s1", null)
      else await h.supervisor.updateSettings({ mode: "active" })
      expect(h.scheduler.pending()).toEqual([])
    }
  })

  it("a continuation the other instance sends is no takeover where this one does not drive", async () => {
    const holder = {}
    const other = processLedger(holder)
    const h = harness({ ledger: processLedger(holder) })
    await exhaustBoth(h)
    await h.supervisor.setSessionMode("s1", "off")
    other.noteContinuation("s1", { tier: "standard" }, h.clock.now)
    await h.supervisor.handleReport(PROMPT)
    expect(parseParkedPayload(storedParked(h.storage))).toHaveLength(1)
    // The next prompt is the user's own.
    await h.supervisor.handleReport(PROMPT)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("an older recovery finishing does not clear a newer one's pending mark", async () => {
    const storage = activeStorage()
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("active", {
        standard: [wireRef("prov", "a"), wireRef("prov", "b"), wireRef("prov", "c")],
      }),
    )
    const clock = { now: 1_000 }
    const session = new FakeSupervisorSession()
    const scheduler = new FakeScheduler()
    const supervisor = makeSupervisor({
      storage,
      session,
      scheduler,
      clock: () => clock.now,
      infos: [makeInfo("prov", "a"), makeInfo("prov", "b"), makeInfo("prov", "c")],
    })
    const h = { clock, session, storage, scheduler, supervisor }
    const { releaseNext } = holdPrompts(session)
    // Recovery 1 (a → b) stays in its prompt call while its continuation
    // unit is vetoed by the retry hook, starting recovery 2 (b → c).
    await runOutOfQuota(h, "a")
    await supervisor.handleReport(PROMPT)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: clock.now - 1,
      model: ref("prov", "b"),
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: clock.now })
    const retry: RetryHookInput = {
      sessionID: "s1",
      model: ref("prov", "b"),
      error: { type: "UnknownError", message: "", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 100 },
    }
    await supervisor.handleRetry(retry)
    expect(retry.decision).toEqual({ retry: false })
    await supervisor.handleReport({
      kind: "execution-failed",
      sessionID: "s1",
      at: clock.now,
      error: { type: "UnknownError", message: "", status: 429 },
    })
    await flush()
    expect(session.log.at(-1)).toBe(CONTINUE)
    releaseNext()
    await flush()
    // Recovery 2's continuation runs c out of quota before its prompt call
    // returns: the failure must still wait for recovery 2, not find no mark.
    await supervisor.handleReport(PROMPT)
    await supervisor.handleReport({
      kind: "model-selected",
      sessionID: "s1",
      at: clock.now - 1,
      model: ref("prov", "c"),
    })
    await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: clock.now })
    const failed = supervisor.handleReport(quotaFailure(clock.now))
    await flush()
    expect(parseParkedPayload(storedParked(storage))).toEqual([])
    releaseNext()
    await failed
    await flush()
    expect(parseParkedPayload(storedParked(storage))).toHaveLength(1)
  })

  it("a user prompt while the resume pops its record still drops the work", async () => {
    // Regression: the takeover baseline was read after the pop, so a prompt
    // landing during the pop's write went unnoticed and the stale
    // continuation followed the user's turn.
    const h = await seededHarness()
    const set = h.storage.source.set
    let armed = true
    const persist = vi.spyOn(h.storage.source, "set").mockImplementation((key, value) => {
      if (key === PARKED_KEY && armed) {
        armed = false
        // Not awaited: the prompt's own store read queues behind this write.
        void h.supervisor.handleReport(PROMPT)
      }
      return set(key, value)
    })
    await wake(h)
    await flush()
    persist.mockRestore()
    expect(h.session.log).not.toContain(CONTINUE)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("a continuation that never arrived is no continuation to the other instance", async () => {
    // Regression: the undelivered prompt's mark outlived it, so the other
    // instance took the user's next prompt for that continuation: no
    // takeover, no routing, and the re-parked work replayed later.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const holder = {}
      const session = new FakeSupervisorSession({ failPrompt: true })
      const resumer = await seededHarness({ session, ledger: processLedger(holder) })
      const listener = harness({ storage: resumer.storage, session, ledger: processLedger(holder) })
      await listener.supervisor.settings()
      await wake(resumer)
      expect(parseParkedPayload(storedParked(resumer.storage))).toMatchObject([{ attempts: 1 }])
      listener.clock.now = resumer.clock.now
      const before = session.log.length
      await listener.supervisor.handleReport(PROMPT)
      expect(session.log.slice(before)).toContain("switch:s1:prov/a")
      expect(parseParkedPayload(storedParked(resumer.storage))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("a disposed instance hearing a late report does not stop the other's wakes", async () => {
    // Regression: the late report marked the disposed instance live again,
    // so the survivor left every resume to it and backed off forever.
    const holder = {}
    const gone = harness({ ledger: processLedger(holder) })
    gone.supervisor.dispose()
    await gone.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s9",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    const survivor = await seededHarness({ ledger: processLedger(holder) })
    await wake(survivor)
    expect(survivor.session.log).toEqual(["wait:s1", "switch:s1:prov/a", CONTINUE])
  })

  it("one session's resumed run does not hold up the next session's resume", async () => {
    // Regression: the sweep awaited each continuation's prompt call, which
    // stays open while the continued run works.
    const storage = activeStorage()
    const record = { sessionID: "s1", tier: "standard", reason: "all-blocked" }
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { ...record, id: "s1#1", parkedAt: 5 },
        { ...record, id: "s2#1", sessionID: "s2", parkedAt: 6 },
      ],
    })
    const h = harness({ storage })
    await h.supervisor.settings()
    await flush()
    const { releaseNext } = holdPrompts(h.session)
    await wake(h)
    expect(h.session.log).toContain(CONTINUE)
    expect(h.session.log).toContain(`prompt:s2:${CONTINUATION_PROMPT}`)
    releaseNext()
    releaseNext()
    await flush()
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
  })

  it("status reports the wake of the instance that hears the host", async () => {
    // Regression: the instance serving status usually hears no host, so it
    // showed its own wake and ignored the live instance's backoff.
    const holder = {}
    const other = processLedger(holder)
    other.claim("s1")
    const pump = await seededHarness({ ledger: processLedger(holder) })
    await pump.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s9",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    await wake(pump)
    const due = pump.clock.now + FRUITLESS_BASE_MS
    expect(pump.scheduler.pending().map((timer) => timer.delayMs)).toEqual([FRUITLESS_BASE_MS])
    const quiet = await seededHarness({ ledger: processLedger(holder) })
    quiet.clock.now = pump.clock.now
    expect((await quiet.supervisor.status()).waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: due },
    ])

    // A live instance with nothing armed: the resources' own time stands.
    pump.supervisor.dispose()
    const idle = harness({ ledger: processLedger(holder) })
    await idle.supervisor.handleReport({
      kind: "model-request",
      sessionID: "s9",
      model: ref("prov", "a"),
      requestKind: "primary",
    })
    expect((await quiet.supervisor.status()).waiting).toEqual([
      { sessionID: "s1", tier: "standard", resumeAt: quiet.clock.now },
    ])
  })

  it("a run the user starts during the resume's settle drops the work", async () => {
    // Regression: a shell or slash-command run skips the prompt hook, so the
    // resume re-parked behind it and replayed the continuation later.
    const h = await seededHarness()
    const wait = h.session.source.wait.bind(h.session.source)
    let settle = (): void => undefined
    h.session.source.wait = (input) =>
      new Promise((resolve) => {
        settle = () => {
          resolve(wait(input))
        }
      })
    await wake(h)
    await h.supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: h.clock.now })
    settle()
    await flush()
    expect(h.session.log).not.toContain(CONTINUE)
    expect(parseParkedPayload(storedParked(h.storage))).toEqual([])
    expect(h.scheduler.pending()).toEqual([])
  })

  it("a prompt in a session that never parked reads no parked work", async () => {
    // OFF must cost nothing: the hint spares the store read on every prompt.
    const h = harness()
    await h.supervisor.settings()
    await flush()
    const get = h.storage.source.get
    const reads: string[] = []
    const spy = vi.spyOn(h.storage.source, "get").mockImplementation((key) => {
      reads.push(key)
      return get(key)
    })
    await h.supervisor.setSessionMode("s7", "off")
    await h.supervisor.handleReport({ kind: "prompt", sessionID: "s7" })
    spy.mockRestore()
    expect(reads).not.toContain(PARKED_KEY)
  })

  it("an OBSERVE session's parked work records what it would do once", async () => {
    const h = await seededHarness()
    await h.supervisor.updateSettings({ mode: "observe" })
    const idle = { kind: "idle", sessionID: "s9" } as const
    await h.supervisor.handleReport(idle)
    await h.supervisor.handleReport(idle)
    const kinds = parseReceiptsPayload(storedReceipts(h.storage))
      .filter((receipt) => receipt.unitID === "s1#1")
      .map((receipt) => receipt.decision.kind)
    expect(kinds).toEqual(["observe-only"])
  })

  it("a supervisor disposed while planning its wake arms none", async () => {
    const h = await seededHarness()
    const get = h.storage.source.get
    let answer = (): void => undefined
    const spy = vi.spyOn(h.storage.source, "get").mockImplementation((key) =>
      key === HEALTH_KEY
        ? new Promise((resolve) => {
            answer = () => {
              resolve(get(key))
            }
          })
        : get(key),
    )
    const updated = h.supervisor.updateSettings({ mode: "active" })
    await flush()
    h.supervisor.dispose()
    answer()
    await updated
    await flush()
    spy.mockRestore()
    expect(h.scheduler.pending()).toEqual([])
  })
})
