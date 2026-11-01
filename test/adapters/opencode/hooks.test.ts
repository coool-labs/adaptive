import { describe, expect, it } from "vitest"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import { registerSessionHooks } from "../../../src/adapters/opencode/hooks.js"
import { FakeHookSession, wireRef } from "./helpers.js"

const HOOK_NAMES = [
  "retry",
  "context",
  "model.request",
  "http.response",
  "experimental.idle",
  "prompt",
] as const

describe("registerSessionHooks", () => {
  it("registers exactly the five supervisor hooks", async () => {
    const session = new FakeHookSession()
    const registrations = await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: () => undefined,
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    expect([...session.registered.keys()].sort()).toEqual([...HOOK_NAMES].sort())
    expect(registrations).toHaveLength(HOOK_NAMES.length)
  })

  it("disposes every registration", async () => {
    const session = new FakeHookSession()
    const registrations = await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: () => undefined,
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    for (const registration of registrations) {
      await registration.dispose()
    }
    expect(session.disposed).toHaveLength(HOOK_NAMES.length)
  })

  it("passes the raw retry input so the supervisor can mutate the decision", async () => {
    const session = new FakeHookSession()
    const seen: SessionRetry[] = []
    await registerSessionHooks(session.source, {
      onRetry: (input) => {
        seen.push(input)
        input.decision = { retry: false }
      },
      onModelRequest: () => undefined,
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    const input = {
      sessionID: "s1",
      agent: "build",
      model: wireRef("p1", "m1"),
      error: { type: "ProviderRequestError", message: "boom", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 1000 },
    } as unknown as SessionRetry
    await session.call("retry", input)
    expect(seen).toEqual([input])
    expect(input.decision).toEqual({ retry: false })
  })

  it("reports context-hook requests as primary", async () => {
    const session = new FakeHookSession()
    const reports: unknown[] = []
    await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: (report) => {
        reports.push(report)
      },
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    await session.call("context", { sessionID: "s1", model: wireRef("p1", "m1") })
    expect(reports).toEqual([
      {
        kind: "model-request",
        sessionID: "s1",
        model: { providerID: "p1", id: "m1" },
        requestKind: "primary",
      },
    ])
  })

  it("reports model.request-hook requests with their kind", async () => {
    const session = new FakeHookSession()
    const reports: unknown[] = []
    await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: (report) => {
        reports.push(report)
      },
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    await session.call("model.request", {
      sessionID: "s1",
      model: wireRef("p1", "m1"),
      kind: "title",
    })
    expect(reports[0]).toMatchObject({ requestKind: "title" })
  })

  it("maps http.response through the clone-once mapper", async () => {
    const session = new FakeHookSession()
    const reports: unknown[] = []
    await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: () => undefined,
      onHttpResponse: (report) => {
        reports.push(report)
      },
      onIdle: () => undefined,
      onPrompt: () => undefined,
    })
    await session.call("http.response", {
      sessionID: "s1",
      response: new Response("boom", { status: 429, headers: { "retry-after": "3" } }),
    })
    expect(reports).toEqual([
      {
        kind: "http-response",
        sessionID: "s1",
        status: 429,
        retryAfterHeader: "3",
        bodyExcerpt: "boom",
      },
    ])
  })

  it("reports the idle boundary", async () => {
    const session = new FakeHookSession()
    const reports: unknown[] = []
    await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: () => undefined,
      onHttpResponse: () => undefined,
      onIdle: (report) => {
        reports.push(report)
      },
      onPrompt: () => undefined,
    })
    await session.call("experimental.idle", { sessionID: "s1", background: [] })
    expect(reports).toEqual([{ kind: "idle", sessionID: "s1" }])
  })
})

describe("prompt hook", () => {
  it("reports the prompt as the awaited admission boundary report", async () => {
    const session = new FakeHookSession()
    const reports: unknown[] = []
    await registerSessionHooks(session.source, {
      onRetry: () => undefined,
      onModelRequest: () => undefined,
      onHttpResponse: () => undefined,
      onIdle: () => undefined,
      onPrompt: (report) => {
        reports.push(report)
      },
    })
    await session.call("prompt", { sessionID: "s1" })
    expect(reports).toEqual([{ kind: "prompt", sessionID: "s1" }])
  })
})
