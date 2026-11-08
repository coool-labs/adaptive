/**
 * Session event subscription (ADP-001). Subscribes to the lifecycle/
 * selection events, maps them into reports, and pumps them to the supervisor.
 * The pump runs until disposed. A stream error (SSE hiccup, host reconnect)
 * must not permanently silence observation — the pump resubscribes with a
 * bounded backoff and reports each failure to `onError` (wiring decides
 * fail-open behavior — ADP-031). Abort-induced termination is quiet.
 */
import type { EventDomain } from "@opencode/plugin/promise/event"

/** The event surface the subscription actually uses (structural — fixture-friendly). */
export type EventSource = Pick<EventDomain, "subscribe">
import { mapSessionEvent, type SessionEvent } from "./report.js"
import type { ExecutionReport } from "./types.js"

export const SESSION_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.model.selected",
] as const satisfies readonly string[]

export interface SessionSubscription {
  /** Abort the stream; the pump settles quietly. */
  dispose(): void
  /** Settles when the pump ends (disposed or errored). */
  done: Promise<void>
}

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

const defaultPause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Subscribe and pump session lifecycle reports to `onReport`, resubscribing after stream errors. */
export function subscribeSessions(
  events: EventSource,
  onReport: (report: ExecutionReport) => void,
  onError: (error: unknown) => void,
  /** Injectable so tests never wait on real timers. */
  pause: (ms: number) => Promise<void> = defaultPause,
): SessionSubscription {
  const controller = new AbortController()
  // Checked through a function on purpose: TS narrows the `controller.signal`
  // property after the first guard, but `dispose()` flips `aborted` from
  // another context mid-pump, so every re-check below is load-bearing.
  const aborted = (): boolean => controller.signal.aborted
  const done = (async () => {
    let backoff = RETRY_BASE_MS
    for (;;) {
      if (aborted()) return
      // Events delivered since the last failure prove the stream itself
      // works; a fresh failure then starts the backoff climb again.
      let delivered = 0
      try {
        const stream = events.subscribe({
          types: [...SESSION_EVENT_TYPES],
          signal: controller.signal,
        })
        for await (const event of stream as AsyncIterable<SessionEvent>) {
          const report = mapSessionEvent(event)
          if (report !== null) {
            delivered += 1
            onReport(report)
          }
        }
        // A clean stream end is still an observation outage: the host closed
        // the subscription, so fall through to the resubscribe path.
        if (!aborted()) onError(new Error("session event stream ended"))
      } catch (error) {
        if (aborted()) return
        onError(error)
      }
      if (aborted()) return
      if (delivered > 0) backoff = RETRY_BASE_MS
      await pause(backoff)
      backoff = Math.min(backoff * 2, RETRY_MAX_MS)
    }
  })()
  return {
    dispose: () => {
      controller.abort()
    },
    done,
  }
}
