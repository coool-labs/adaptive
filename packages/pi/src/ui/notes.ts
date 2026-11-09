// covers: ["ADP-057", "ADP-058"]
import { sameModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import type { Decision, ParkReason } from "@coool/adaptive-core/routing/scheduler/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { NoteVerbosity } from "../preferences.js"

export interface AdaptiveNote {
  readonly version: 1
  readonly text: string
  readonly receiptID?: number
}

function base(decision: Decision): Decision {
  return decision.kind === "observe-only" ? base(decision.would) : decision
}

export function shouldWriteNote(
  verbosity: NoteVerbosity,
  decision: Decision,
  previous: Decision | undefined,
): boolean {
  if (verbosity === "quiet") return false
  if (verbosity === "all" || previous === undefined) return true
  const current = base(decision)
  const last = base(previous)
  return (
    current.kind !== "apply" ||
    last.kind !== "apply" ||
    current.reason === "fallback" ||
    current.reason === "probe" ||
    decision.kind !== previous.kind ||
    !sameModelRef(current.model, last.model)
  )
}

const PARKED: Record<ParkReason, string> = {
  "all-blocked": "all models unavailable",
  "no-candidates": "no models configured",
  "no-compatible-resource": "no compatible model",
  "pin-blocked": "pinned model unavailable",
}
const APPLIED: Partial<Record<Extract<Decision, { kind: "apply" }>["reason"], string>> = {
  fallback: " · fallback",
  probe: " · testing recovery",
}

/** Written when the user leaves an Adaptive model: routing stops until they come back. */
export function pausedNote(model: { readonly provider: string; readonly id: string }): string {
  return `Paused · you picked ${model.provider}/${model.id}`
}

export function decisionNote(decision: Decision, tier: TierName, retry = false): string {
  switch (decision.kind) {
    case "observe-only":
      return `Observing · would ${decisionNote(decision.would, tier, retry)}`
    case "apply":
      return `${tier} → ${resourceLabel(decision.model)}${retry ? " · retry" : (APPLIED[decision.reason] ?? "")}`
    case "park":
      return `${tier} waiting · ${PARKED[decision.reason]}`
    case "defer":
      return `Not routing · ${decision.reason.replaceAll("-", " ")} · /adaptive why`
    case "escalate":
      return `Escalated to ${decision.tier} for this task → ${resourceLabel(decision.target)}`
  }
}
