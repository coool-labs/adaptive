// covers: ["ADP-001"]
import { describe, expect, it } from "vitest"
import { SESSION_EVENT_TYPES, subscribeSessions } from "../../../src/adapters/opencode/events.js"
import { fakeEvents, sessionEvent, wireRef } from "./helpers.js"

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
    events.close()
    await subscription.done
    expect(reports).toEqual([])
    expect(errors).toEqual([])
  })

  it("reports pump errors to onError", async () => {
    const events = fakeEvents()
    const errors: unknown[] = []
    const subscription = subscribeSessions(
      events.source,
      () => undefined,
      (error) => errors.push(error),
    )
    events.push(sessionEvent("session.execution.started", { sessionID: "s1" }, 1))
    events.fail(new Error("transport broke"))
    await subscription.done
    expect(errors).toEqual([new Error("transport broke")])
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
})
