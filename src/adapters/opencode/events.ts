/**
 * Session event subscription (ADP-001). Subscribes to the five lifecycle/
 * selection events, maps them into reports, and pumps them to the supervisor.
 * The pump runs until disposed (abort) or the stream errors; abort-induced
 * termination is quiet, everything else reaches `onError` (wiring decides
 * fail-open behavior — ADP-031).
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

/** Subscribe and pump session lifecycle reports to `onReport`. */
export function subscribeSessions(
  events: EventSource,
  onReport: (report: ExecutionReport) => void,
  onError: (error: unknown) => void,
): SessionSubscription {
  const controller = new AbortController()
  const stream = events.subscribe({ types: [...SESSION_EVENT_TYPES], signal: controller.signal })
  const done = (async () => {
    try {
      for await (const event of stream as AsyncIterable<SessionEvent>) {
        const report = mapSessionEvent(event)
        if (report !== null) {
          onReport(report)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(error)
      }
    }
  })()
  return {
    dispose: () => {
      controller.abort()
    },
    done,
  }
}
