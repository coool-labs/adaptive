/**
 * Session operations seam (ADP-013/ADP-014/ADP-023/ADP-028). Implements the
 * supervisor's `ContinuationOps` on the host session domain: settle on the
 * host's experimental wait, switch model, deliver a prompt. Never replays a
 * failed request — prompting after a failure starts a NEW execution that
 * continues from session state (prompt strategy chosen by the supervisor).
 *
 * Switch self-tagging (verified limitation: `session.model.selected` fires for
 * manual AND plugin switches): `beforeSwitch` is invoked BEFORE the host
 * switch so the supervisor can record its own pending attribution note; the
 * resulting selection event is then attributed to Adaptive, never to the user.
 */
import type { SessionDomain } from "@opencode/plugin/promise/session"

/** The session surface the ops actually use (structural — fixture-friendly). */
export type SessionOpsSource = Pick<SessionDomain, "wait" | "switchModel" | "prompt">
import type { ContinuationOps } from "../../execution/continuation/types.js"
import type { ModelRef } from "../../core/work-unit/types.js"

export interface SessionOpsHooks {
  /**
   * Called before every host `switchModel` this adapter performs, so wiring
   * can tag the switch as Adaptive's own (`noteOwnSwitch`).
   */
  readonly beforeSwitch?: (sessionID: string, model: ModelRef) => void
  /**
   * Called before the adapter prompts a continuation, so wiring can mark the
   * upcoming prompt-hook admission as owned (the continuation belongs to the
   * active unit and must not re-admit).
   */
  readonly beforePrompt?: (sessionID: string) => void
  /**
   * Called when the prompted call settles (success or failure), whether or
   * not the prompt hook fired — the counterpart that bounds the ownership
   * mark's lifetime.
   */
  readonly afterPrompt?: (sessionID: string) => void
}

/** Build the supervisor's continuation ops on top of the host session domain. */
export function sessionOps(session: SessionOpsSource, hooks?: SessionOpsHooks): ContinuationOps {
  return {
    settle: (sessionID) => session.wait({ sessionID }),
    switchModel: (sessionID, model) => {
      hooks?.beforeSwitch?.(sessionID, model)
      return session.switchModel({
        sessionID,
        model: {
          providerID: model.providerID,
          id: model.id,
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
        },
      })
    },
    prompt: async (sessionID, text) => {
      hooks?.beforePrompt?.(sessionID)
      try {
        await session.prompt({ sessionID, text })
      } finally {
        // The ownership mark is consumed by the prompt hook; if the prompt
        // never reaches the hook (session gone, host error), the mark must
        // not outlive the attempt and swallow a later user prompt.
        hooks?.afterPrompt?.(sessionID)
      }
    },
  }
}
