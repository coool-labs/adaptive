import { Plugin } from "@opencode/plugin"
import { isCodexHeaderName } from "./adapters/codex-capacity/index.js"
import {
  adaptiveCommand,
  escalationTool,
  registerSessionHooks,
  subscribeSessions,
  tierTool,
} from "./adapters/opencode/index.js"
import { PLUGIN_ID } from "./plugin-id.js"
import { adaptiveRpc } from "./rpc/definition.js"
import { adaptiveRpcHandlers, patchSettings } from "./rpc/handlers.js"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { AdaptiveRpcEmit } from "./rpc/handlers.js"
import { Supervisor, logFailOpen } from "./supervisor/index.js"

export { PLUGIN_ID } from "./plugin-id.js"

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
    // Every disposal settles independently: a failing dispose is logged, never
    // allowed to mask the other disposals or (during rollback) the original
    // setup error. Disposals are awaited so a late rejection cannot land after
    // the host considers the plugin gone.
    const disposals: { name: string; dispose: () => void | Promise<void> }[] = []
    const settled = async (name: string, dispose: () => void | Promise<void>): Promise<void> => {
      try {
        await dispose()
      } catch (error) {
        logFailOpen(name, error)
      }
    }
    const settledAll = async (): Promise<void> => {
      for (const { name, dispose } of disposals) {
        await settled(name, dispose)
      }
    }
    for (const [index, hookRegistration] of hooks.entries()) {
      disposals.push({ name: `hook ${String(index)}`, dispose: () => hookRegistration.dispose() })
    }
    disposals.push({
      name: "events",
      dispose: () => {
        subscription.dispose()
      },
    })
    // The typed escalation tool (T-18, ADP-015): the agent's self-report
    // surface for stronger capability, applied at the next safe boundary.
    // The tier tool (ADP-055): the agent declares the task's tier; the
    // declaration steers the session's next admissions until cleared.
    // Typed RPC (ADP-034/036): the only channel to the control surfaces.
    // The settings-changed emitter resolves the registration lazily: handlers
    // only run after `register` resolves, so the holder is always populated.
    const rpcHolder: { registration?: RpcRegistration<typeof adaptiveRpc> } = {}
    const emit: AdaptiveRpcEmit = (...args) =>
      // The correlated tuple pairing is checked by the handler types; the
      // registration forwards it to the host emitter untouched.
      rpcHolder.registration?.events.emit(...args)
    try {
      const toolRegistration = await context.tool.transform((editor) => {
        editor.add(
          escalationTool((sessionID, reason, evidence) =>
            supervisor.noteEscalationRequest(sessionID, reason, evidence),
          ),
        )
        editor.add(tierTool((sessionID, tier) => supervisor.noteTierRequest(sessionID, tier)))
      })
      disposals.push({ name: "tools", dispose: () => toolRegistration.dispose() })
      const rpcRegistration = await context.rpc.register(
        adaptiveRpc,
        adaptiveRpcHandlers(supervisor, emit),
      )
      rpcHolder.registration = rpcRegistration
      disposals.push({ name: "rpc", dispose: () => rpcRegistration.dispose() })
      // The web UI never mounts plugin GUI bundles, but it lists server
      // commands in the composer's slash menu (ADP-034).
      const commandRegistration = await context.command.transform((editor) => {
        editor.add(
          adaptiveCommand(
            {
              status: () => supervisor.status(),
              setMode: (mode) => patchSettings(supervisor, emit, { mode }),
            },
            // The web timeline shows a synthetic message as a notice only when
            // it has a description, and labels it with that description.
            (sessionID, text) =>
              context.session.synthetic({ sessionID, text, description: text, resume: false }),
          ),
        )
      })
      disposals.push({ name: "command", dispose: () => commandRegistration.dispose() })
    } catch (error) {
      // Roll back everything already registered so a failure at the tool or
      // rpc stage does not leak live hooks and the event pump.
      await settledAll()
      throw error
    }
    return () => settledAll()
  },
})
