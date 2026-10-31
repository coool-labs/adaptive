/**
 * Session hook registration (ADP-012/ADP-013/ADP-027). Registers the hooks the
 * supervisor needs on the host session domain and returns their registrations
 * for cleanup. Hooks MUTATE their inputs on the host — the retry handler owns
 * `input.decision`; the adapter passes the raw input through so wiring can
 * veto (`{ retry: false }`) or leave OpenCode's native retry untouched.
 *
 * Fail-open behavior (ADP-031) is applied by the wiring around these handlers;
 * the adapter itself never swallows errors, so wiring sees every failure.
 */
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionDomain, SessionRetry } from "@opencode/plugin/promise/session"

/** The session surface the hooks actually use (structural — fixture-friendly). */
export type SessionHookSource = Pick<SessionDomain, "hook">
import { contextModelRequest, hookModelRequest, mapHttpResponse } from "./report.js"
import type { HttpResponseReport, IdleReport, ModelRequestReport } from "./types.js"

export interface SessionHookHandlers {
  /** Raw retry hook input; wiring decides and mutates `input.decision`. */
  readonly onRetry: (input: SessionRetry) => Promise<void> | void
  readonly onModelRequest: (report: ModelRequestReport) => Promise<void> | void
  readonly onHttpResponse: (report: HttpResponseReport) => Promise<void> | void
  readonly onIdle: (report: IdleReport) => Promise<void> | void
}

/** Register supervisor hooks; resolves to all registrations (dispose in order). */
export async function registerSessionHooks(
  session: SessionHookSource,
  handlers: SessionHookHandlers,
): Promise<Registration[]> {
  const retry = await session.hook("retry", (input) => handlers.onRetry(input))
  const context = await session.hook("context", (input) =>
    handlers.onModelRequest(contextModelRequest(input)),
  )
  const modelRequest = await session.hook("model.request", (input) =>
    handlers.onModelRequest(hookModelRequest(input)),
  )
  const httpResponse = await session.hook("http.response", async (input) =>
    handlers.onHttpResponse(await mapHttpResponse(input)),
  )
  const idle = await session.hook("experimental.idle", (input) =>
    handlers.onIdle({ kind: "idle", sessionID: input.sessionID }),
  )
  return [retry, context, modelRequest, httpResponse, idle]
}
