/**
 * Work-unit model (ADP-001): one unit is exactly one OpenCode execution
 * episode — `session.execution.started` → `succeeded`/`failed`/`interrupted`.
 * Tool/step/text continuations never open, close, or split a unit (only the
 * execution events do); a subagent runs in its own session and therefore gets
 * its own units; a later continuation on the same session (e.g. a new /goal
 * round) is a new episode of that session.
 */
import type { InterruptReason } from "./interruption.js"

/** OpenCode model reference (`Model.Ref`): provider, model, optional variant. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string | undefined
}

/** Full-field equality; a variant change is a different reference. */
export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id && a.variant === b.variant
}

/**
 * How the model in effect became known. `selected-*` comes from the
 * `session.model.selected` event (which fires for both manual and
 * plugin-made switches — the tracker resolves which via pending own-switch
 * notes, see `WorkUnitTracker.noteOwnSwitch`); `request` comes from the
 * `context` hook and reports the model actually executing.
 */
export const MODEL_SOURCES = [
  "selected-adaptive",
  "selected-external",
  "request",
] as const satisfies readonly string[]

export type ModelSource = (typeof MODEL_SOURCES)[number]

export interface ModelTransition {
  readonly at: number
  readonly model: ModelRef
  readonly source: ModelSource
}

/**
 * Minimal shape of the wire `Session.StructuredError` carried by
 * `session.execution.failed` (`response.body` is deliberately dropped here —
 * the adapter folds it into bounded `ErrorEvidence` for the classifier).
 */
export interface ExecutionError {
  readonly type: string
  readonly message: string
  readonly status?: number | undefined
  readonly retryAfterMs?: number | undefined
}

/**
 * The episode lifecycle. `kind` doubles as status: `"active"` while the
 * execution runs, then the terminal kind it closed with.
 */
interface UnitBase {
  /** Stable per-episode identifier: `${sessionID}#${episode}`. */
  readonly id: string
  readonly sessionID: string
  /** 1-based count of episodes started for this session (tracker lifetime). */
  readonly episode: number
  readonly startedAt: number
  /**
   * Model in effect for the unit: seeded from the last known selection when
   * the unit opens, then updated by transitions.
   */
  readonly model?: ModelRef | undefined
  readonly transitions: readonly ModelTransition[]
}

export interface ActiveUnit extends UnitBase {
  readonly kind: "active"
}

export interface SucceededUnit extends UnitBase {
  readonly kind: "succeeded"
  readonly closedAt: number
}

export interface FailedUnit extends UnitBase {
  readonly kind: "failed"
  readonly closedAt: number
  readonly error: ExecutionError
}

export interface InterruptedUnit extends UnitBase {
  readonly kind: "interrupted"
  readonly closedAt: number
  readonly reason: InterruptReason
}

export type ClosedUnit = SucceededUnit | FailedUnit | InterruptedUnit

export type WorkUnit = ActiveUnit | ClosedUnit

/**
 * Normalized episode events. The OpenCode adapter unwraps host event payloads
 * (`event.data.*`) and forwards them here; `model-request` is fed from the
 * `context` session hook.
 */
export type WorkUnitEvent =
  | { readonly kind: "execution-started"; readonly sessionID: string; readonly at: number }
  | { readonly kind: "execution-succeeded"; readonly sessionID: string; readonly at: number }
  | {
      readonly kind: "execution-failed"
      readonly sessionID: string
      readonly at: number
      readonly error: ExecutionError
    }
  | {
      readonly kind: "execution-interrupted"
      readonly sessionID: string
      readonly at: number
      readonly reason: InterruptReason
    }
  | {
      readonly kind: "model-selected"
      readonly sessionID: string
      readonly at: number
      readonly model: ModelRef
    }
  | {
      readonly kind: "model-request"
      readonly sessionID: string
      readonly at: number
      readonly model: ModelRef
    }

/**
 * Why an event produced no state change. Only terminal events can be ignored
 * — they arrive without an active unit when the terminal was already handled
 * (duplicate delivery) or never preceded by `execution-started`.
 */
export const IGNORED_REASONS = ["terminal-without-active-unit"] as const satisfies readonly string[]

export type IgnoredReason = (typeof IGNORED_REASONS)[number]

/** Result of an execution-started event: the tracker always opens (possibly superseding). */
export type OpenedResult = Extract<ApplyResult, { kind: "opened" }>

export type ApplyResult =
  | {
      readonly kind: "opened"
      readonly unit: ActiveUnit
      readonly superseded?: ClosedUnit | undefined
    }
  | { readonly kind: "closed"; readonly unit: ClosedUnit }
  | {
      readonly kind: "model-tracked"
      readonly unit: ActiveUnit
      readonly transition: ModelTransition
    }
  /** Model knowledge recorded with no active unit; remembered for the next admission. */
  | { readonly kind: "model-noted"; readonly transition: ModelTransition }
  | { readonly kind: "ignored"; readonly reason: IgnoredReason }
