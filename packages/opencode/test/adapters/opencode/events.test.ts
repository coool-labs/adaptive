// covers: ["ADP-001"]
import { describe, expect, it } from "vitest"
import { SESSION_EVENT_TYPES, subscribeSessions } from "../../../src/adapters/opencode/events.js"
import type { EventSource } from "../../../src/adapters/opencode/events.js"
import { fakeEvents, sessionEvent, wireRef } from "./helpers.js"

/** Macrotask-yielding pause so resubscribe tests never wait on long timers but timers still fire. */
const instant = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Independent single-use streams: one per subscribe call, each with its own queue. */
function resubscribeEvents(): {
  source: EventSource
  failFirst: (error: unknown) => void
  closeFirst: () => void
  deliver: (event: unknown) => void
  subscriptions: () => number
  signals: () => (AbortSignal | undefined)[]
} {
  interface StreamState {
    queue: unknown[]
    failure: { error: unknown } | null
    closed: boolean
    wake: (() => void) | null
    signal: AbortSignal | undefined
  }
  const streams: StreamState[] = []
  const signals: (AbortSignal | undefined)[] = []
  const source = {
    subscribe: (options?: { signal?: AbortSignal }) => {
      signals.push(options?.signal)
      const state: StreamState = {
        queue: [],
        failure: null,
        closed: false,
        wake: null,
        signal: options?.signal,
      }
      streams.push(state)
      // Real host streams reject pending next() on abort; the fixture does
      // the same so dispose can break a pending wait.
      options?.signal?.addEventListener("abort", () => {
        state.wake?.()
      })
      const stream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            for (;;) {
              if (state.signal?.aborted) return { done: true as const, value: undefined }
              if (state.queue.length > 0) return { done: false, value: state.queue.shift() }
              if (state.failure !== null) throw state.failure.error
              if (state.closed) return { done: true as const, value: undefined }
              await new Promise<void>((resolve) => {
                state.wake = resolve
              })
            }
          },
        }),
      }
      return stream
    },
  } as unknown as EventSource
  const first = (): (typeof streams)[number] | undefined => streams[0]
  return {
    source,
    failFirst: (error) => {
      const stream = first()
      if (stream !== undefined) {
        stream.failure = { error }
        stream.wake?.()
      }
    },
    closeFirst: () => {
      const stream = first()
      if (stream !== undefined) {
        stream.closed = true
        stream.wake?.()
      }
    },
    deliver: (event) => {
      const stream = streams.at(-1)
      if (stream !== undefined) {
        stream.queue.push(event)
        stream.wake?.()
      }
    },
    subscriptions: () => streams.length,
    signals: () => signals,
  }
}

describe("SESSION_EVENT_TYPES", () => {
  it("subscribes to exactly the five lifecycle/selection events", () => {
    expect(SESSION_EVENT_TYPES).toEqual([
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.model.selected",
    ])
  })
})

describe("subscribeSessions", () => {
  it("forwards mapped reports in arrival order", async () => {
    const events = fakeEvents()
    const reports: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      (report) => {
        reports.push(report)
      },
      () => undefined,
    )
    events.push(sessionEvent("session.execution.started", { sessionID: "s1" }, 1))
    events.push(
      sessionEvent("session.model.selected", { sessionID: "s1", model: wireRef("p", "m") }, 2),
    )
    events.push(sessionEvent("session.execution.succeeded", { sessionID: "s1" }, 3))
    subscription.dispose()
    events.close()
    await subscription.done
    expect(reports).toEqual([
      { kind: "execution-started", sessionID: "s1", at: 1 },
      { kind: "model-selected", sessionID: "s1", at: 2, model: { providerID: "p", id: "m" } },
      { kind: "execution-succeeded", sessionID: "s1", at: 3 },
    ])
  })

  it("passes the abort signal to the subscription", async () => {
    const events = fakeEvents()
    const subscription = subscribeSessions(
      events.source,
      () => undefined,
      () => undefined,
    )
    expect(events.signal()).toBeInstanceOf(AbortSignal)
    subscription.dispose()
    events.close()
    await subscription.done
  })

  it("ignores event shapes it cannot map", async () => {
    const events = fakeEvents()
    const reports: unknown[] = []
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      (report) => reports.push(report),
      (e) => errors.push(e),
    )
    events.push({ type: "session.status", created: 1, data: {} })
    subscription.dispose()
    events.close()
    await subscription.done
    expect(reports).toEqual([])
    expect(errors).toEqual([])
  })

  it("reports pump errors to onError and resubscribes instead of dying (A4)", async () => {
    const events = fakeEvents()
    const reports: unknown[] = []
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      (report) => reports.push(report),
      (error) => errors.push(error),
      instant,
    )
    events.push(sessionEvent("session.execution.started", { sessionID: "s1" }, 1))
    events.fail(new Error("transport broke"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The failure surfaced once; the pump did not die — the shared fake
    // stream is subscribed again (the failure stays sticky in the fixture,
    // so the exact retry count is not asserted here).
    expect(errors[0]).toEqual(new Error("transport broke"))
    expect(reports).toEqual([{ kind: "execution-started", sessionID: "s1", at: 1 }])
    subscription.dispose()
    events.close()
    await subscription.done
  })

  it("resubscribes onto a fresh stream after a transient error and keeps pumping (A4)", async () => {
    const events = resubscribeEvents()
    const reports: unknown[] = []
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      (report) => reports.push(report),
      (error) => errors.push(error),
      instant,
    )
    expect(events.subscriptions()).toBe(1)
    events.failFirst(new Error("hiccup"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors).toEqual([new Error("hiccup")])
    expect(events.subscriptions()).toBe(2)
    expect(events.signals()[1]).toBeInstanceOf(AbortSignal)
    events.deliver(sessionEvent("session.execution.started", { sessionID: "s1" }, 1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([{ kind: "execution-started", sessionID: "s1", at: 1 }])
    subscription.dispose()
    await subscription.done
  })

  it("resubscribes when the host closes the stream cleanly (A4)", async () => {
    const events = resubscribeEvents()
    const reports: unknown[] = []
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      (report) => reports.push(report),
      (error) => errors.push(error),
      instant,
    )
    events.closeFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.subscriptions()).toBe(2)
    expect(errors).toHaveLength(1)
    events.deliver(sessionEvent("session.execution.started", { sessionID: "s1" }, 1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([{ kind: "execution-started", sessionID: "s1", at: 1 }])
    subscription.dispose()
    await subscription.done
  })

  it("stays quiet when the stream errors after dispose (abort)", async () => {
    const events = fakeEvents()
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      () => undefined,
      (error) => errors.push(error),
    )
    subscription.dispose()
    events.fail(new Error("late failure"))
    await subscription.done
    expect(errors).toEqual([])
  })
  describe("resubscribe backoff (ADP-011: every retry loop is bounded)", () => {
    /** A source whose every subscribe fails, so the pump retries until disposed. */
    function failingSource(failures: number, then: () => AsyncIterable<unknown>): EventSource {
      let calls = 0
      return {
        subscribe: () => {
          calls += 1
          if (calls <= failures) {
            return {
              [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error(`down ${String(calls)}`)),
              }),
            }
          }
          return then()
        },
      } as unknown as EventSource
    }

    it("doubles the pause per consecutive failure and caps it at thirty seconds", async () => {
      const pauses: number[] = []
      let dispose: () => void = () => undefined
      const hold = (): AsyncIterable<unknown> => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      })
      const subscription = subscribeSessions(
        failingSource(9, hold),
        () => undefined,
        () => undefined,
        (ms) => {
          pauses.push(ms)
          if (pauses.length === 9) dispose()
          return Promise.resolve()
        },
      )
      dispose = () => {
        subscription.dispose()
      }
      await subscription.done
      expect(pauses).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000])
    })

    it("starts the climb over once a stream proved itself by delivering events", async () => {
      const pauses: number[] = []
      let calls = 0
      const source = {
        subscribe: () => {
          calls += 1
          const call = calls
          return {
            [Symbol.asyncIterator]: () => {
              let step = 0
              return {
                next: () => {
                  step += 1
                  // Calls 1-2 fail at once; call 3 delivers an event then
                  // fails; call 4 fails at once again.
                  if (call === 3 && step === 1) {
                    return Promise.resolve({
                      done: false,
                      value: sessionEvent("session.execution.started", { sessionID: "s1" }, 1),
                    })
                  }
                  return Promise.reject(new Error(`down ${String(call)}`))
                },
              }
            },
          }
        },
      } as unknown as EventSource
      const subscription = subscribeSessions(
        source,
        () => undefined,
        () => undefined,
        (ms) => {
          pauses.push(ms)
          if (pauses.length === 4) subscription.dispose()
          return Promise.resolve()
        },
      )
      await subscription.done
      expect(pauses).toEqual([1000, 2000, 1000, 2000])
    })
  })
})
