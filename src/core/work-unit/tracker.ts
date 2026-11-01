/**
 * Episode tracker (ADP-001): a deterministic, clock-free state machine over
 * normalized work-unit events, keyed by session. All timestamps come from the
 * events themselves, so behavior is fully reproducible.
 *
 * Self-switch attribution: `session.model.selected` fires for both manual and
 * plugin-made switches. Before performing `session.switchModel` our adapter
 * calls `noteOwnSwitch`; the next `model-selected` event for that session
 * matching the noted reference is attributed `selected-adaptive` and consumes
 * the note. A non-matching selection clears the note, so a stale note can
 * never claim a later user pick — the failure direction is always
 * "our switch looks external" (treated as a manual pick, left alone), never
 * the reverse. At most one note per session is kept: a newer note replaces an
 * unconsumed older one, and the older switch's event (if it ever arrives) is
 * then attributed external — again the safe direction, since the adapter
 * serializes per-session switches.
 */
import {
  sameModelRef,
  type ActiveUnit,
  type ApplyResult,
  type ClosedUnit,
  type ModelRef,
  type ModelSource,
  type ModelTransition,
  type OpenedResult,
  type WorkUnitEvent,
} from "./types.js"

export class WorkUnitTracker {
  readonly #active = new Map<string, ActiveUnit>()
  readonly #episodes = new Map<string, number>()
  readonly #lastModel = new Map<string, ModelTransition>()
  readonly #pendingOwn = new Map<string, ModelRef>()

  /**
   * Arms the pending own-switch note consumed by the next matching
   * `model-selected` event for this session.
   */
  noteOwnSwitch(sessionID: string, model: ModelRef): void {
    this.#pendingOwn.set(sessionID, model)
  }

  /**
   * Raises each session's episode floor. Used at startup: unit ids are
   * durable keys (`${sessionID}#${episode}`) persisted in receipts and
   * parked work, so after a restart the counters must never re-mint an id
   * a persisted record already carries — a collision would replace parked
   * work and misattribute receipt outcomes.
   */
  seedEpisodes(seeds: ReadonlyMap<string, number>): void {
    for (const [sessionID, episode] of seeds) {
      if (episode > (this.#episodes.get(sessionID) ?? 0)) this.#episodes.set(sessionID, episode)
    }
  }

  /** Apply an execution-started event; the tracker always opens a unit. */
  apply(event: Extract<WorkUnitEvent, { kind: "execution-started" }>): OpenedResult
  apply(event: WorkUnitEvent): ApplyResult
  apply(event: WorkUnitEvent): ApplyResult {
    switch (event.kind) {
      case "execution-started": {
        const previous = this.#active.get(event.sessionID)
        if (previous !== undefined) this.#active.delete(event.sessionID)
        // A new execution on a session that still has an active unit means
        // the previous execution was superseded (matches OpenCode's
        // `interrupted{reason:"superseded"}` semantics).
        const superseded: ClosedUnit | undefined = previous && {
          ...previous,
          kind: "interrupted",
          closedAt: event.at,
          reason: "superseded",
        }
        const episode = (this.#episodes.get(event.sessionID) ?? 0) + 1
        this.#episodes.set(event.sessionID, episode)
        const unit: ActiveUnit = {
          kind: "active",
          id: `${event.sessionID}#${String(episode)}`,
          sessionID: event.sessionID,
          episode,
          startedAt: event.at,
          model: this.#lastModel.get(event.sessionID)?.model,
          transitions: [],
        }
        this.#active.set(event.sessionID, unit)
        return superseded ? { kind: "opened", unit, superseded } : { kind: "opened", unit }
      }
      case "execution-succeeded":
      case "execution-failed":
      case "execution-interrupted": {
        const current = this.#active.get(event.sessionID)
        if (current === undefined)
          return { kind: "ignored", reason: "terminal-without-active-unit" }
        this.#active.delete(event.sessionID)
        const base = { ...current, closedAt: event.at }
        const unit: ClosedUnit =
          event.kind === "execution-succeeded"
            ? { ...base, kind: "succeeded" }
            : event.kind === "execution-failed"
              ? { ...base, kind: "failed", error: event.error }
              : { ...base, kind: "interrupted", reason: event.reason }
        return { kind: "closed", unit }
      }
      case "model-selected": {
        const adaptive = this.#consumePendingOwn(event.sessionID, event.model)
        return this.#trackModel(
          event.sessionID,
          event.at,
          event.model,
          adaptive ? "selected-adaptive" : "selected-external",
        )
      }
      case "model-request":
        // Context-hook observations never consume the pending note: only
        // actual selection events resolve it.
        return this.#trackModel(event.sessionID, event.at, event.model, "request")
    }
  }

  /** The open unit for a session, if any. */
  active(sessionID: string): ActiveUnit | undefined {
    return this.#active.get(sessionID)
  }

  /** All currently open units, in insertion order. */
  activeAll(): ActiveUnit[] {
    return [...this.#active.values()]
  }

  /** Last model known to be in effect for a session, across episodes. */
  lastModel(sessionID: string): ModelTransition | undefined {
    return this.#lastModel.get(sessionID)
  }

  /**
   * Returns whether the pending note matched. The note is consumed on any
   * selection event: matched → `selected-adaptive`; unmatched (or absent) →
   * `selected-external` with the note dropped.
   */
  #consumePendingOwn(sessionID: string, model: ModelRef): boolean {
    const pending = this.#pendingOwn.get(sessionID)
    this.#pendingOwn.delete(sessionID)
    return pending !== undefined && sameModelRef(pending, model)
  }

  #trackModel(sessionID: string, at: number, model: ModelRef, source: ModelSource): ApplyResult {
    const transition: ModelTransition = { at, model, source }
    this.#lastModel.set(sessionID, transition)
    const current = this.#active.get(sessionID)
    if (current === undefined) return { kind: "model-noted", transition }
    const unit: ActiveUnit = {
      ...current,
      model,
      transitions: [...current.transitions, transition],
    }
    this.#active.set(sessionID, unit)
    return { kind: "model-tracked", unit, transition }
  }
}
