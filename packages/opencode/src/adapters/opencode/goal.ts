/**
 * Host goal surface (ADP-015/ADP-028). Reads a session's goal through the
 * host's own `opencode.goal` RPC and resumes a paused goal through the
 * host's `/goal` server command — the command is the supported write path:
 * it re-arms the goal engine's idle watcher and delivers the goal's own
 * continuation. The supervisor fail-opens around any error here, so no
 * swallowing beyond letting throws propagate is needed.
 */
import type { RpcDomain } from "@opencode/plugin/promise/rpc"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { Goal } from "@opencode/schema/goal"
import type { GoalSurface } from "../../supervisor/types.js"

/** The session surface the goal surface actually uses (structural — fixture-friendly). */
export type GoalCommandSource = Pick<SessionDomain, "command">

/** Build the supervisor's goal surface on top of the host rpc and session domains. */
export function goalSurface(rpc: RpcDomain, session: GoalCommandSource): GoalSurface {
  return {
    get: async (sessionID) => {
      const state = await rpc(Goal.Definition).get({ sessionID })
      if (state === null) return null
      return {
        status: state.status,
        ...(state.reason !== undefined ? { reason: state.reason } : {}),
      }
    },
    resume: (sessionID) => session.command({ sessionID, name: "goal", text: "resume" }),
  }
}
