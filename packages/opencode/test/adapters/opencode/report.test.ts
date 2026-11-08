// covers: ["ADP-001", "ADP-027"]
import { describe, expect, it } from "vitest"
import {
  BODY_EXCERPT_LENGTH,
  MAX_CAPTURED_HEADERS,
  MAX_CAPTURED_VALUE_LENGTH,
  contextModelRequest,
  hookModelRequest,
  mapHttpResponse,
  mapSessionEvent,
  modelRefOf,
} from "../../../src/adapters/opencode/report.js"
import type { SessionEvent } from "../../../src/adapters/opencode/report.js"
import { sessionEvent, wireRef } from "./helpers.js"

describe("modelRefOf", () => {
  it("maps provider and id without variant", () => {
    expect(modelRefOf(wireRef("openai", "gpt-5"))).toEqual({ providerID: "openai", id: "gpt-5" })
  })

  it("maps variant when present", () => {
    expect(modelRefOf(wireRef("openai", "gpt-5", "high"))).toEqual({
      providerID: "openai",
      id: "gpt-5",
      variant: "high",
    })
  })
})

describe("mapSessionEvent", () => {
  it("maps execution.started with envelope time", () => {
    expect(
      mapSessionEvent(sessionEvent("session.execution.started", { sessionID: "s1" }, 5)),
    ).toEqual({
      kind: "execution-started",
      sessionID: "s1",
      at: 5,
    })
  })

  it("maps execution.succeeded", () => {
    expect(
      mapSessionEvent(sessionEvent("session.execution.succeeded", { sessionID: "s1" }, 6)),
    ).toEqual({
      kind: "execution-succeeded",
      sessionID: "s1",
      at: 6,
    })
  })

  it("maps execution.failed with the structured error", () => {
    const error = { type: "ProviderRequestError", message: "boom", status: 429 }
    expect(
      mapSessionEvent(sessionEvent("session.execution.failed", { sessionID: "s1", error }, 7)),
    ).toEqual({
      kind: "execution-failed",
      sessionID: "s1",
      at: 7,
      error,
    })
  })

  it("maps execution.interrupted with its reason", () => {
    expect(
      mapSessionEvent(
        sessionEvent("session.execution.interrupted", { sessionID: "s1", reason: "user" }, 8),
      ),
    ).toEqual({ kind: "execution-interrupted", sessionID: "s1", at: 8, reason: "user" })
  })

  it("maps model.selected including variant", () => {
    expect(
      mapSessionEvent(
        sessionEvent(
          "session.model.selected",
          { sessionID: "s1", model: wireRef("p", "m1", "high") },
          9,
        ),
      ),
    ).toEqual({
      kind: "model-selected",
      sessionID: "s1",
      at: 9,
      model: { providerID: "p", id: "m1", variant: "high" },
    })
  })

  it("ignores unsubscribed event shapes defensively", () => {
    const stray = { type: "session.status", created: 1, data: {} } as unknown as SessionEvent
    expect(mapSessionEvent(stray)).toBeNull()
  })
})

describe("model request reports", () => {
  it("context hook always reports the primary kind", () => {
    expect(contextModelRequest({ sessionID: "s1", model: wireRef("p", "m1") })).toEqual({
      kind: "model-request",
      sessionID: "s1",
      model: { providerID: "p", id: "m1" },
      requestKind: "primary",
    })
  })

  it("model.request hook preserves the request kind", () => {
    expect(
      hookModelRequest({ sessionID: "s1", model: wireRef("p", "m1"), kind: "compaction" }),
    ).toMatchObject({ requestKind: "compaction" })
  })

  it("carries the agent when the hook input has one", () => {
    expect(
      contextModelRequest({ sessionID: "s1", model: wireRef("p", "m1"), agent: "reviewer" }),
    ).toEqual({
      kind: "model-request",
      sessionID: "s1",
      model: { providerID: "p", id: "m1" },
      requestKind: "primary",
      agent: "reviewer",
    })
    expect(
      hookModelRequest({
        sessionID: "s1",
        model: wireRef("p", "m1"),
        kind: "generate",
        agent: "code",
      }),
    ).toMatchObject({ requestKind: "generate", agent: "code" })
  })
})

describe("mapHttpResponse", () => {
  it("captures status, Retry-After, and a bounded body excerpt", async () => {
    const input = {
      sessionID: "s1",
      response: new Response("boom", { status: 429, headers: { "retry-after": "30" } }),
    }
    const report = await mapHttpResponse(input as never)
    expect(report).toEqual({
      kind: "http-response",
      sessionID: "s1",
      status: 429,
      retryAfterHeader: "30",
      bodyExcerpt: "boom",
    })
  })

  it("leaves the original body untouched (clone exactly once)", async () => {
    const response = new Response("original", { status: 503 })
    await mapHttpResponse({ sessionID: "s1", response } as never)
    await expect(response.text()).resolves.toBe("original")
  })

  it("truncates the excerpt to the body bound", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response("x".repeat(1000), { status: 500 }),
    } as never)
    expect(report.bodyExcerpt?.length).toBe(BODY_EXCERPT_LENGTH)
  })

  it("stops reading an endless body at the excerpt cap (A5)", async () => {
    let pulls = 0
    // An endless body: a full-buffering reader (clone().text()) would pull
    // forever and never resolve; the bounded reader must stop at the cap.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(100).fill(120)) // "x"
      },
    })
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response(stream, { status: 500 }),
    } as never)
    expect(report.bodyExcerpt?.length).toBe(BODY_EXCERPT_LENGTH)
    // Reading stops at the 512-char cap (6 chunks of 100); the clone's tee
    // may double the count. Either way the pulls are a constant bounded by
    // the cap — a full-body reader pulls proportionally to the endless body.
    expect(pulls).toBeLessThanOrEqual(2 * (BODY_EXCERPT_LENGTH / 100 + 1))
  })

  it("omits the excerpt for an empty body", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response("", { status: 502 }),
    } as never)
    expect("bodyExcerpt" in report).toBe(false)
  })

  it("swallows a cancel rejection from the capped read (A5)", async () => {
    // The fire-and-forget reader.cancel() must not surface a rejection as an
    // unhandled promise — vitest fails the run on those, so this test fails
    // if the swallow is ever removed. clone() tees the body, so the source's
    // cancel only runs once BOTH branches are canceled: the test cancels the
    // original after the mapped read, and the tee forwards the source's
    // rejection back to the clone branch's cancel promise.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(100).fill(121)) // "y"
      },
      cancel() {
        return Promise.reject(new Error("cancel refused"))
      },
    })
    const original = new Response(stream, { status: 500 })
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: original,
    } as never)
    expect(report.bodyExcerpt?.length).toBe(BODY_EXCERPT_LENGTH)
    // Both branches reject here; the production swallow handles the clone
    // branch (the one readBodyExcerpt canceled), the test handles the original.
    await original.body?.cancel().catch(() => undefined)
    // Let the rejected-cancel microtask settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it("omits the excerpt for a bodyless response (A5)", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response(null, { status: 500 }),
    } as never)
    expect("bodyExcerpt" in report).toBe(false)
  })

  it("returns a short body whole when it ends before the cap (A5)", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response("abc", { status: 500 }),
    } as never)
    expect(report.bodyExcerpt).toBe("abc")
  })

  it("omits retryAfterHeader when absent", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response("x", { status: 500 }),
    } as never)
    expect("retryAfterHeader" in report).toBe(false)
  })

  it("degrades to status/header evidence when the body cannot be cloned", async () => {
    const response = new Response("consumed", { status: 429, headers: { "retry-after": "5" } })
    await response.text()
    const report = await mapHttpResponse({ sessionID: "s1", response } as never)
    expect(report.status).toBe(429)
    expect(report.retryAfterHeader).toBe("5")
    expect("bodyExcerpt" in report).toBe(false)
  })

  it("exposes the excerpt bound constant", () => {
    expect(BODY_EXCERPT_LENGTH).toBe(512)
  })

  it("omits capturedHeaders when no capture predicate is given", async () => {
    const report = await mapHttpResponse({
      sessionID: "s1",
      response: new Response("x", {
        status: 200,
        headers: { "x-codex-primary-used-percent": "10" },
      }),
    } as never)
    expect("capturedHeaders" in report).toBe(false)
  })

  it("captures only headers the predicate allows (allowlist is wiring policy)", async () => {
    const report = await mapHttpResponse(
      {
        sessionID: "s1",
        response: new Response("x", {
          status: 200,
          headers: {
            "x-codex-primary-used-percent": "10",
            "X-Codex-Secondary-Used-Percent": "42",
            authorization: "Bearer secret",
            "set-cookie": "session=xyz",
            "retry-after": "30",
          },
        }),
      } as never,
      { capture: (name) => name.includes("x-codex-") },
    )
    // Undici normalizes header names to lowercase on the Headers instance.
    expect(report.capturedHeaders).toEqual({
      "x-codex-primary-used-percent": "10",
      "x-codex-secondary-used-percent": "42",
    })
    expect(Object.values(report.capturedHeaders ?? {})).not.toContain("secret")
  })

  it("omits capturedHeaders when nothing matches", async () => {
    const report = await mapHttpResponse(
      {
        sessionID: "s1",
        response: new Response("x", { status: 200, headers: { "retry-after": "1" } }),
      } as never,
      { capture: (name) => name.includes("x-codex-") },
    )
    expect("capturedHeaders" in report).toBe(false)
  })

  it("bounds captured entries and value length", async () => {
    const headers: Record<string, string> = {}
    for (let i = 0; i < 24; i++) {
      headers[`x-codex-entry-${String(i)}`] = "v".repeat(200)
    }
    const report = await mapHttpResponse(
      { sessionID: "s1", response: new Response("x", { status: 200, headers }) } as never,
      { capture: (name) => name.startsWith("x-codex-") },
    )
    const captured = Object.entries(report.capturedHeaders ?? {})
    expect(captured.length).toBe(MAX_CAPTURED_HEADERS)
    for (const [, value] of captured) {
      expect(value.length).toBe(MAX_CAPTURED_VALUE_LENGTH)
    }
  })

  it("exposes the capture bounds", () => {
    expect(MAX_CAPTURED_HEADERS).toBe(16)
    expect(MAX_CAPTURED_VALUE_LENGTH).toBe(64)
  })
})
