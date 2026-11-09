// covers: ["ADP-057", "ADP-058"]
import { sameModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
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

export function decisionNote(decision: Decision, tier: TierName): string {
  switch (decision.kind) {
    case "observe-only":
      return `Observing · would ${decisionNote(decision.would, tier)}`
    case "apply":
      return `${tier} → ${resourceLabel(decision.model)}`
    case "park":
      return `${tier} waiting · ${decision.reason} · /adaptive`
    case "defer":
      return `No routing change · ${decision.reason} · /adaptive why`
    case "escalate":
      return `Escalated to ${decision.tier} for this task → ${resourceLabel(decision.target)}`
  }
}
