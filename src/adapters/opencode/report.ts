/**
 * Event/hook → report mappers. Pure observation, no policy: the adapter
 * normalizes verified host payloads into `EventReport` shapes the supervisor
 * consumes. Timestamps come from the host event envelope (`created`, epoch
 * milliseconds) — work units are clock-free.
 */
import type { Model } from "@opencode/plugin"
import type { SessionHttpResponse } from "@opencode/plugin/promise/session"
import type { ModelRef } from "../../core/work-unit/types.js"
import type {
  AdapterStructuredError,
  ExecutionReport,
  HttpResponseReport,
  ModelRequestReport,
} from "./types.js"

/**
 * Response bodies are bounded here (and bounded again by the classifier) so a
 * hostile provider payload can never inflate memory or receipts.
 */
export const BODY_EXCERPT_LENGTH = 512

/** Capture bounds for wiring-selected telemetry headers. */
export const MAX_CAPTURED_HEADERS = 16
export const MAX_CAPTURED_VALUE_LENGTH = 64

/** Convert a host `Model.Ref` into the supervisor's `ModelRef` shape. */
export function modelRefOf(ref: Model.Ref): ModelRef {
  return {
    providerID: ref.providerID,
    id: ref.id,
    ...(ref.variant !== undefined ? { variant: ref.variant } : {}),
  }
}

/** Structural session event the mapper accepts (host payloads are assignable). */
export type SessionEvent =
  | { type: "session.execution.started"; created: number; data: { sessionID: string } }
  | { type: "session.execution.succeeded"; created: number; data: { sessionID: string } }
  | {
      type: "session.execution.failed"
      created: number
      data: { sessionID: string; error: AdapterStructuredError }
    }
  | {
      type: "session.execution.interrupted"
      created: number
      data: { sessionID: string; reason: string }
    }
  | {
      type: "session.model.selected"
      created: number
      data: { sessionID: string; model: Model.Ref }
    }

/**
 * Map one subscribed session event into its report. Returns `null` for event
 * types the supervisor does not consume (defensive — the subscription filters
 * types, so this branch only fires if the host ever widens the stream).
 */
export function mapSessionEvent(event: SessionEvent): ExecutionReport | null {
  switch (event.type) {
    case "session.execution.started":
      return { kind: "execution-started", sessionID: event.data.sessionID, at: event.created }
    case "session.execution.succeeded":
      return { kind: "execution-succeeded", sessionID: event.data.sessionID, at: event.created }
    case "session.execution.failed":
      return {
        kind: "execution-failed",
        sessionID: event.data.sessionID,
        at: event.created,
        error: event.data.error,
      }
    case "session.execution.interrupted":
      return {
        kind: "execution-interrupted",
        sessionID: event.data.sessionID,
        at: event.created,
        reason: event.data.reason,
      }
    case "session.model.selected":
      return {
        kind: "model-selected",
        sessionID: event.data.sessionID,
        at: event.created,
        model: modelRefOf(event.data.model),
      }
    default:
      return null
  }
}

/** Model request report from the `context` hook — the agent loop is `primary`. */
export function contextModelRequest(input: {
  sessionID: string
  model: Model.Ref
  agent?: string
}): ModelRequestReport {
  return {
    kind: "model-request",
    sessionID: input.sessionID,
    model: modelRefOf(input.model),
    requestKind: "primary",
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  }
}

/** Model request report from the `model.request` hook (carries the request kind). */
export function hookModelRequest(input: {
  sessionID: string
  model: Model.Ref
  kind: "primary" | "compaction" | "title" | "generate"
  agent?: string
}): ModelRequestReport {
  return {
    kind: "model-request",
    sessionID: input.sessionID,
    model: modelRefOf(input.model),
    requestKind: input.kind,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  }
}

/**
 * Map an `http.response` hook input. The response body is cloned EXACTLY ONCE
 * and only the bounded excerpt of the clone is read — the original body stays
 * untouched for the host (verified one-shot body limitation). If the body
 * cannot be cloned (already consumed, streaming error), the report degrades
 * to status/header evidence.
 *
 * `capture` is an optional allowlist predicate over lowercase header names
 * (quota telemetry only — never `authorization`, cookies, or any other
 * credential-bearing header). Captured entries are bounded in count and value
 * length; capture never throws.
 */
export async function mapHttpResponse(
  input: SessionHttpResponse,
  options?: { capture?: (lowercaseName: string) => boolean },
): Promise<HttpResponseReport> {
  const retryAfterHeader = input.response.headers.get("retry-after")
  let bodyExcerpt: string | undefined
  try {
    const clone = input.response.clone()
    const text = await clone.text()
    const excerpt = text.slice(0, BODY_EXCERPT_LENGTH)
    bodyExcerpt = excerpt === "" ? undefined : excerpt
  } catch {
    // Body unreadable — status + headers evidence remains available.
  }
  let capturedHeaders: Record<string, string> | undefined
  if (options?.capture !== undefined) {
    const captured: Record<string, string> = {}
    for (const [name, value] of input.response.headers) {
      if (Object.keys(captured).length >= MAX_CAPTURED_HEADERS) {
        break
      }
      if (options.capture(name.toLowerCase())) {
        captured[name] = value.slice(0, MAX_CAPTURED_VALUE_LENGTH)
      }
    }
    if (Object.keys(captured).length > 0) {
      capturedHeaders = captured
    }
  }
  return {
    kind: "http-response",
    sessionID: input.sessionID,
    status: input.response.status,
    ...(retryAfterHeader !== null ? { retryAfterHeader } : {}),
    ...(bodyExcerpt !== undefined ? { bodyExcerpt } : {}),
    ...(capturedHeaders !== undefined ? { capturedHeaders } : {}),
  }
}
