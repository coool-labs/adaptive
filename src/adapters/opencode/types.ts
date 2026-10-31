/**
 * Adapter report types (ADP-025..ADP-031). The OpenCode adapter's only job is
 * to observe host events and hooks and forward them as plain reports; every
 * policy decision lives in the supervisor wiring. Report shapes mirror the
 * verified `@opencode/plugin@2.2.5` surfaces structurally, so the adapter
 * stays testable against typed fixtures without importing host internals
 * beyond types.
 */
import type { ModelRef } from "../../core/work-unit/types.js"
import type { RequestKind } from "../../core/tier-policy/types.js"

/**
 * Structural mirror of the wire `Session.StructuredError` (also the classifier
 * evidence source). Declared locally because `SessionError.Error` is not
 * re-exported by `@opencode/plugin` — the host payloads are assignable to
 * this shape.
 */
export interface AdapterStructuredError {
  readonly type: string
  readonly message: string
  readonly status?: number | undefined
  readonly response?: { readonly body: string } | undefined
  readonly retryAfterMs?: number | undefined
}

/** Work-unit lifecycle reports forwarded from `session.execution.*` events. */
export type ExecutionReport =
  | { kind: "execution-started"; sessionID: string; at: number }
  | { kind: "execution-succeeded"; sessionID: string; at: number }
  | { kind: "execution-failed"; sessionID: string; at: number; error: AdapterStructuredError }
  | { kind: "execution-interrupted"; sessionID: string; at: number; reason: string }
  | { kind: "model-selected"; sessionID: string; at: number; model: ModelRef }

/**
 * Model request reports from the `context` hook (the agent loop, always
 * `primary`) and the `model.request` hook (which carries the request kind for
 * auxiliary requests — ADP-027).
 */
export interface ModelRequestReport {
  kind: "model-request"
  sessionID: string
  model: ModelRef
  requestKind: RequestKind
  /** The agent the request runs under (ADP-002 role-hint routing evidence). */
  agent?: string
}

/**
 * HTTP response evidence from the `http.response` hook. The response body is
 * cloned exactly once and only a bounded excerpt is kept — the original body
 * stays untouched for the host. WebSocket-backed providers bypass this hook
 * entirely (verified limitation), so this evidence is never load-bearing.
 */
export interface HttpResponseReport {
  kind: "http-response"
  sessionID: string
  status: number
  /** Raw `Retry-After` header value; the supervisor parses it, not the adapter. */
  retryAfterHeader?: string | undefined
  bodyExcerpt?: string | undefined
  /**
   * Captured quota-telemetry headers selected by the wiring-supplied capture
   * predicate (an allowlist — no other header ever leaves the response, so
   * credentials and cookies cannot leak). Bounded in count and value length.
   */
  capturedHeaders?: Readonly<Record<string, string>> | undefined
}

/** Idle-boundary report from the `experimental.idle` hook (safe boundary). */
export interface IdleReport {
  kind: "idle"
  sessionID: string
}

/** Everything the adapter forwards to the supervisor. */
export type EventReport = ExecutionReport | ModelRequestReport | HttpResponseReport | IdleReport
