import { Plugin } from "@opencode/plugin"
import { isCodexHeaderName } from "./adapters/codex-capacity/index.js"
import {
  escalationTool,
  registerSessionHooks,
  subscribeSessions,
} from "./adapters/opencode/index.js"
import { Supervisor, logFailOpen } from "./supervisor/index.js"

/**
 * Plugin id as required by GOAL.md: must not collide with the `opencode.*`
 * namespace and must stay stable across releases (referenced by settings
 * storage keys and receipts).
 */
export const PLUGIN_ID = "coool.adaptive"

/**
 * Entry point wired into OpenCode via `opencode.json(c)`. Setup glues the
 * adapter touchpoints (session hooks, event subscription, storage) to the
 * supervisor and returns a cleanup that disposes every registration.
 * All supervision errors are fail-open (ADP-031): the supervisor's public
 * entry points never throw; the event pump's stream errors are logged.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    const supervisor = new Supervisor({
      session: context.session,
      model: context.model,
      storage: context.storage,
      clock: () => Date.now(),
    })
    const hooks = await registerSessionHooks(
      context.session,
      {
        onRetry: async (input) => {
          await supervisor.handleRetry(input)
        },
        onModelRequest: async (report) => {
          await supervisor.handleReport(report)
        },
        onHttpResponse: async (report) => {
          await supervisor.handleReport(report)
        },
        onIdle: async (report) => {
          await supervisor.handleReport(report)
        },
      },
      { capture: isCodexHeaderName },
    )
    const subscription = subscribeSessions(
      context.event,
      (report) => {
        void supervisor.handleReport(report)
      },
      (error) => {
        logFailOpen("events", error)
      },
    )
    // The typed escalation tool (T-18, ADP-015): the agent's self-report
    // surface for stronger capability, applied at the next safe boundary.
    const toolRegistration = await context.tool.transform((editor) => {
      editor.add(
        escalationTool((sessionID, reason, evidence) =>
          supervisor.noteEscalationRequest(sessionID, reason, evidence),
        ),
      )
    })
    return () => {
      for (const registration of hooks) {
        void registration.dispose()
      }
      subscription.dispose()
      void toolRegistration.dispose()
    }
  },
})
