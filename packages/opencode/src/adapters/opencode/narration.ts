/**
 * Model-facing narration for orchestrators (ADP-031/ADP-052).
 *
 * A parent session learns about a subagent only through the host's terminal
 * task result, and that result is delivered before Adaptive's recovery lands.
 * The field failure this closes: the parent saw "subagent quota exhausted",
 * concluded the worker had died without edits, and re-dispatched it while the
 * original child was still running. Two bounded facts prevent that reading:
 * one standing note per orchestrator, and one notice per applied recovery.
 *
 * Structural session surface only — no host package import, so a fake exercises
 * the narration without branding.
 */

/** Key of the standing orchestrator note (idempotent per session). */
export const SUBAGENT_NOTE_KEY = "adaptive-subagents"

/**
 * One short note installed once per orchestrator. It states what the host
 * cannot: a report is a final result and a failed attempt may already have been
 * continued. It carries no routing metadata (ADP-052).
 */
export const SUBAGENT_NOTE =
  "Subagents run independently in their own sessions; their report is delivered when they finish. A failure report means that attempt ended, not that the work was lost — the environment may resume it on another model. Do not re-dispatch a subagent or take over its scope until it has reported a final result."

/** Provider/model/variant label as the user sees it in receipts. */
export function modelLabel(model: {
  readonly providerID: string
  readonly id: string
  readonly variant?: string | undefined
}): string {
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

/** Structural slice of `context.session` the narration needs. */
export interface NarrationSession {
  instructions: {
    entry: {
      put(input: { sessionID: string; key: string; value: string }): Promise<void>
    }
  }
  synthetic(input: {
    sessionID: string
    text: string
    description: string
    resume: boolean
  }): Promise<unknown>
}

/** The supervisor's parent-narration port over the host session domain. */
export interface ParentNarrationPort {
  instruct(parentID: string): Promise<void>
  resumed(
    parentID: string,
    model: {
      readonly providerID: string
      readonly id: string
      readonly variant?: string | undefined
    },
  ): Promise<void>
}

/**
 * Build the port. Both calls are awaited by the supervisor's fire-and-forget
 * wrapper, which logs and continues on failure: narration must never block or
 * undo a recovery.
 */
export function parentNarration(session: NarrationSession): ParentNarrationPort {
  return {
    async instruct(parentID) {
      await session.instructions.entry.put({
        sessionID: parentID,
        key: SUBAGENT_NOTE_KEY,
        value: SUBAGENT_NOTE,
      })
    },
    async resumed(parentID, model) {
      await session.synthetic({
        sessionID: parentID,
        text: `A subagent hit an availability limit and was resumed on ${modelLabel(model)}. It is still working; its report will arrive when it finishes.`,
        description: "Subagent resumed",
        resume: false,
      })
    },
  }
}
