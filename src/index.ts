import { Plugin } from "@opencode/plugin"
import { isCodexHeaderName } from "./adapters/codex-capacity/index.js"
import {
  escalationTool,
  registerSessionHooks,
  subscribeSessions,
  tierTool,
} from "./adapters/opencode/index.js"
import { PLUGIN_ID } from "./plugin-id.js"
import { adaptiveRpc } from "./rpc/definition.js"
import { adaptiveRpcHandlers } from "./rpc/handlers.js"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { AdaptiveRpcEmit } from "./rpc/handlers.js"
import { Supervisor, logFailOpen } from "./supervisor/index.js"

export { PLUGIN_ID } from "./plugin-id.js"

/**
 * Plugin id as required by GOAL.md: must not collide with the `opencode.*`
 * namespace and must stay stable across releases (referenced by settings
 * storage keys and receipts).
 */

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
        onPrompt: async (report) => {
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
    // The tier tool (ADP-055): the agent declares the task's tier; the
    // declaration steers the session's next admissions until cleared.
    const toolRegistration = await context.tool.transform((editor) => {
      editor.add(
        escalationTool((sessionID, reason, evidence) =>
          supervisor.noteEscalationRequest(sessionID, reason, evidence),
        ),
      )
      editor.add(tierTool((sessionID, tier) => supervisor.noteTierRequest(sessionID, tier)))
    })
    // Typed RPC (ADP-034/036): the only channel to the control surfaces.
    // The settings-changed emitter resolves the registration lazily: handlers
    // only run after `register` resolves, so the holder is always populated.
    const rpcHolder: { registration?: RpcRegistration<typeof adaptiveRpc> } = {}
    const emit: AdaptiveRpcEmit = (_name, data) => {
      // The handlers only ever pair an event name with its own payload shape,
      // so the payload discriminates the event to emit.
      if ("version" in data) {
        return rpcHolder.registration?.events.emit("settings-changed", { version: data.version })
      }
      return rpcHolder.registration?.events.emit("session-mode-changed", {
        sessionID: data.sessionID,
      })
    }
    const rpcRegistration = await context.rpc.register(
      adaptiveRpc,
      adaptiveRpcHandlers(supervisor, emit),
    )
    rpcHolder.registration = rpcRegistration
    return () => {
      for (const hookRegistration of hooks) {
        void hookRegistration.dispose()
      }
      subscription.dispose()
      void toolRegistration.dispose()
      void rpcRegistration.dispose()
    }
  },
})
