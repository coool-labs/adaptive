// covers: ["ADP-008","ADP-009","ADP-011","ADP-013","ADP-014"]
/**
 * Runtime E2E: provider failure modes on a real OpenCode host.
 *
 * Timeout, mid-stream disconnect, and malformed (non-JSON) stream responses:
 * each runs on an active-mode two-resource standard tier with a healthy
 * advanced resource, the failure is recorded on the unit's receipt, the unit
 * recovers (native retry or the next admission boundary) WITHOUT escalating
 * to the advanced tier, and the host keeps serving a following success turn.
 *
 * A definitive 401 authentication failure is a permanent error: the resource
 * is quarantined (hard-unavailable) and is never retried in a loop.
 *
 * Empirical host facts baked into the scripts:
 * - The host has no short request timeout: a chat-completions response
 *   delayed by 5s (the fake provider's `timeout` scenario) is simply a slow
 *   success, so the wire-level timeout signal (HTTP 408) exercises the
 *   timeout failure mode instead.
 * - The host requests streaming completions, so a malformed payload is
 *   delivered inside the SSE stream (a data line that is not JSON); a
 *   non-JSON plain body is synthesized into a stream by the fake provider.
 * - The fake provider repeats its last behavior once its per-model queue is
 *   exhausted, so failing queues stay failing until explicitly replaced.
 */
import { afterAll, describe, expect, it } from "vitest"
import { rpc, scenarioScript, startHost, type StartedHost } from "./helpers.js"
import type { Receipt } from "@coool/adaptive-core/state/receipts/types"
import type {
  FakeProviderBehavior,
  FakeProviderScript,
} from "@coool/adaptive-testkit/fake-provider/scenarios"

const hosts: StartedHost[] = []

afterAll(async () => {
  for (const host of [...hosts].reverse()) await host.close()
})

const settle = async (ms = 500): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const receipts = async (host: StartedHost): Promise<Receipt[]> => {
  const list = await rpc(host).receipts.list()
  return list as Receipt[]
}

/** Poll the receipt list until `predicate` holds or the deadline passes. */
const pollReceipts = async (
  host: StartedHost,
  predicate: (list: Receipt[]) => boolean,
  deadlineMs: number,
): Promise<Receipt[]> => {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const list = await receipts(host)
    if (predicate(list)) return list
    if (Date.now() > deadline) return list
    await settle(500)
  }
}

const stop = async (host: StartedHost, sessionID: string): Promise<void> => {
  try {
    await host.client.session.interrupt({ sessionID })
  } catch {
    // session already idle
  }
}

interface StatusSnapshot {
  tiers: Record<string, { ref: { id: string }; health: string; breaker: string }[]>
}

const status = async (host: StartedHost): Promise<StatusSnapshot> =>
  (await rpc(host).status.get()) as StatusSnapshot

/** Model ids parsed from the captured provider call bodies, in call order. */
const modelSequence = (host: StartedHost): string[] =>
  host.provider.calls
    .map((call) => {
      try {
        const parsed: unknown = JSON.parse(call.body)
        if (typeof parsed === "object" && parsed !== null && "model" in parsed) {
          const model = (parsed as { model?: unknown }).model
          if (typeof model === "string") return model
        }
      } catch {
        // non-JSON call body has no model
      }
      return "?"
    })
    .filter((model) => model !== "?")

const callCountFor = (host: StartedHost, model: string): number =>
  modelSequence(host).filter((entry) => entry === model).length

const THREE_MODELS = {
  "fake-model": { name: "Fake Model" },
  "fake-model-2": { name: "Fake Model 2" },
  "fake-model-3": { name: "Fake Model 3" },
}

const ACTIVE_THREE = {
  version: 1,
  mode: "active",
  tiers: {
    quick: [],
    standard: [
      { providerID: "fake", id: "fake-model" },
      { providerID: "fake", id: "fake-model-2" },
    ],
    advanced: [{ providerID: "fake", id: "fake-model-3" }],
  },
} as const

/**
 * Failing phase: the preferred standard resource answers the fresh session's
 * title call, then fails every main call (the last behavior repeats); the
 * tier sibling and the advanced resource always succeed. Per-model queues
 * are immune to the per-run global script reset, so a late retry can never
 * observe a success it did not earn.
 */
const installFailing = (host: StartedHost, failure: FakeProviderBehavior): void => {
  host.provider.setModelScripts({
    "fake-model": { behaviors: [scenarioScript("success").behaviors[0], failure] },
    "fake-model-2": { behaviors: [scenarioScript("success").behaviors[0]] },
    "fake-model-3": { behaviors: [scenarioScript("success").behaviors[0]] },
  })
}

/** Recovery phase: every resource serves plain successes again. */
const installRecovering = (host: StartedHost): void => {
  host.provider.setModelScripts({
    "fake-model": scenarioScript("success"),
    "fake-model-2": scenarioScript("success"),
    "fake-model-3": scenarioScript("success"),
  })
}

const failureScript = (failure: FakeProviderBehavior): FakeProviderScript => ({
  behaviors: [failure],
})

describe("runtime e2e: provider failure modes", () => {
  it(
    "records a provider timeout (408) on the unit, never escalates, and keeps serving",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ models: THREE_MODELS })
      hosts.push(host)
      await rpc(host).settings.set(ACTIVE_THREE)
      const timeout408: FakeProviderBehavior = {
        status: 408,
        body: JSON.stringify({ error: { message: "request timeout" } }),
      }
      installFailing(host, timeout408)

      const run = await host.run({ script: failureScript(timeout408), text: "hit the timeout" })

      // The failed attempt is classified as a timeout (definitive status
      // layer, ADP-008/ADP-009) and recorded on the unit's receipt.
      const afterFailure = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.outcome?.status === "failed" &&
              r.outcome.category === "timeout",
          ),
        90_000,
      )
      expect(
        afterFailure.some(
          (r) =>
            r.sessionID === run.sessionID &&
            r.outcome?.status === "failed" &&
            r.outcome.category === "timeout",
        ),
      ).toBe(true)

      // Visible in the health view: the timeout marks the resource degraded.
      const snap = await status(host)
      const preferred = snap.tiers["standard"]?.find((entry) => entry.ref.id === "fake-model")
      expect(preferred?.health).toBe("degraded")

      // Infrastructure failure never escalates capability (ADP-013): no
      // escalation decision anywhere, and the healthy advanced resource was
      // never touched.
      expect(afterFailure.some((r) => r.decision.kind === "escalate")).toBe(false)
      expect(modelSequence(host).includes("fake-model-3")).toBe(false)

      // The host keeps serving: a following turn succeeds.
      installRecovering(host)
      const next = await host.run({ text: "after the timeout", sessionID: run.sessionID })
      const afterNext = await pollReceipts(
        host,
        (all) =>
          all.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
        60_000,
      )
      expect(
        afterNext.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
      ).toBe(true)
      await stop(host, run.sessionID)
    },
  )

  it(
    "records a mid-stream disconnect on the unit, never escalates, and keeps serving",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ models: THREE_MODELS })
      hosts.push(host)
      await rpc(host).settings.set(ACTIVE_THREE)
      // Mid-stream: a content chunk arrives, then the socket is destroyed
      // before the finish event (the fake provider's sseEnd "close").
      const midStreamDisconnect: FakeProviderBehavior = {
        sse: [
          `data: ${JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          })}\n\n`,
        ],
        sseEnd: "close",
      }
      installFailing(host, midStreamDisconnect)

      const run = await host.run({
        script: failureScript(midStreamDisconnect),
        text: "hit the disconnect",
      })

      // The host's native retry handles the first connection error (a retry
      // against the still-failing resource is observed on the wire); with the
      // failure repeating, the unit ultimately fails and the outcome is
      // recorded (ADP-014: the native retry is the horizontal remedy).
      const afterFailure = await pollReceipts(
        host,
        (all) => all.some((r) => r.sessionID === run.sessionID && r.outcome?.status === "failed"),
        90_000,
      )
      const failure = afterFailure.find(
        (r) => r.sessionID === run.sessionID && r.outcome?.status === "failed",
      )
      expect(failure).toBeDefined()
      if (failure?.outcome?.status !== "failed") return
      // The disconnect evidence reaches the classifier as a connection-level
      // failure; the recorded category must be one of the connection/
      // infrastructure categories it can express.
      expect(["outage", "overload", "unknown"]).toContain(failure.outcome.category)

      // No capability escalation, no advanced-tier traffic (ADP-013).
      expect(afterFailure.some((r) => r.decision.kind === "escalate")).toBe(false)
      expect(modelSequence(host).includes("fake-model-3")).toBe(false)

      // The host keeps serving: a following turn succeeds.
      installRecovering(host)
      const next = await host.run({ text: "after the disconnect", sessionID: run.sessionID })
      const afterNext = await pollReceipts(
        host,
        (all) =>
          all.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
        60_000,
      )
      expect(
        afterNext.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
      ).toBe(true)
      await stop(host, run.sessionID)
    },
  )

  it(
    "records a malformed (non-JSON) stream response on the unit, never escalates, and keeps serving",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ models: THREE_MODELS })
      hosts.push(host)
      await rpc(host).settings.set(ACTIVE_THREE)
      // The host requests streaming completions, so the malformed payload is
      // delivered inside the SSE stream: a data line whose body is not JSON.
      const malformedStream: FakeProviderBehavior = {
        sse: ["<not json>"],
        sseEnd: "done",
      }
      installFailing(host, malformedStream)

      const run = await host.run({
        script: failureScript(malformedStream),
        text: "hit the malformed response",
      })

      // The parse failure terminates the unit; the bounded textual layer
      // cannot name the error text, so the classification is `unknown`
      // (ADP-009: evidence outside the documented vocabularies never guesses)
      // — the failed outcome is still recorded on the unit's receipt.
      const afterFailure = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.outcome?.status === "failed" &&
              r.outcome.category === "unknown",
          ),
        90_000,
      )
      expect(
        afterFailure.some(
          (r) =>
            r.sessionID === run.sessionID &&
            r.outcome?.status === "failed" &&
            r.outcome.category === "unknown",
        ),
      ).toBe(true)

      // An unclassifiable failure never escalates capability (ADP-013) and
      // never touches the advanced resource.
      expect(afterFailure.some((r) => r.decision.kind === "escalate")).toBe(false)
      expect(modelSequence(host).includes("fake-model-3")).toBe(false)

      // The host keeps serving: a following turn succeeds.
      installRecovering(host)
      const next = await host.run({
        text: "after the malformed response",
        sessionID: run.sessionID,
      })
      const afterNext = await pollReceipts(
        host,
        (all) =>
          all.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
        60_000,
      )
      expect(
        afterNext.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
      ).toBe(true)
      await stop(host, run.sessionID)
    },
  )

  it(
    "treats a definitive authentication failure as permanent: quarantines the resource and never retries in a loop",
    { timeout: 120_000 },
    async () => {
      const host = await startHost({ models: THREE_MODELS })
      hosts.push(host)
      await rpc(host).settings.set(ACTIVE_THREE)
      const unauthorized: FakeProviderBehavior = {
        status: 401,
        body: JSON.stringify({
          error: {
            message: "invalid api key",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      }
      installFailing(host, unauthorized)

      const run = await host.run({
        script: failureScript(unauthorized),
        text: "hit the auth failure",
      })

      // The failure is classified definitively as an auth failure (HTTP
      // status layer, ADP-008) and recorded on the unit's receipt.
      const afterFailure = await pollReceipts(
        host,
        (all) =>
          all.some(
            (r) =>
              r.sessionID === run.sessionID &&
              r.outcome?.status === "failed" &&
              r.outcome.category === "auth_failure",
          ),
        60_000,
      )
      expect(
        afterFailure.some(
          (r) =>
            r.sessionID === run.sessionID &&
            r.outcome?.status === "failed" &&
            r.outcome.category === "auth_failure",
        ),
      ).toBe(true)

      // The resource is quarantined: hard-unavailable in the health view.
      const quarantineDeadline = Date.now() + 30_000
      let quarantined = false
      for (;;) {
        const snap = await status(host)
        const preferred = snap.tiers["standard"]?.find((entry) => entry.ref.id === "fake-model")
        if (preferred?.health === "unavailable") {
          quarantined = true
          break
        }
        if (Date.now() > quarantineDeadline) break
        await settle(500)
      }
      expect(quarantined).toBe(true)

      // Bounded request count (ADP-011): the title call plus exactly one
      // failed main attempt — no native or owned retry loop against a
      // permanently broken credential.
      await settle(3000)
      expect(callCountFor(host, "fake-model")).toBe(2)

      // A following turn still works: the quarantined resource is skipped and
      // the tier sibling serves it, with no further calls to the 401 resource
      // and none to the advanced resource.
      const before = host.provider.requestCount()
      installRecovering(host)
      const next = await host.run({ text: "after the auth failure", sessionID: run.sessionID })
      const afterNext = await pollReceipts(
        host,
        (all) =>
          all.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
        60_000,
      )
      expect(
        afterNext.some((r) => r.sessionID === next.sessionID && r.outcome?.status === "succeeded"),
      ).toBe(true)
      expect(callCountFor(host, "fake-model")).toBe(2)
      expect(host.provider.requestCount()).toBeGreaterThan(before)
      expect(modelSequence(host).includes("fake-model-3")).toBe(false)
      await stop(host, run.sessionID)
    },
  )
})
