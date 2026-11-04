/**
 * Receipt view models (ADP-030/033): one-line summaries and bounded detail
 * text for the `/adaptive` receipts browser. No secrets — receipt content is
 * already bounded at write time; this layer only formats.
 */
import type {
  ApplyReason,
  Decision,
  ParkReason,
  SchedulerDeferReason,
} from "../../core/scheduler/types.js"
import { resourceLabel } from "./tiers.js"
import type { Receipt, ReceiptOutcome } from "../../state/receipts/types.js"

export function summarizeDecision(decision: Decision): string {
  switch (decision.kind) {
    case "apply": {
      const tier = decision.tier === undefined ? "" : ` [${decision.tier}]`
      return `apply ${resourceLabel(decision.model)}${tier} (${decision.reason})`
    }
    case "defer": {
      const detail = decision.detail === undefined ? "" : ` — ${decision.detail}`
      return `defer: ${decision.reason}${detail}`
    }
    case "park": {
      const detail = decision.detail === undefined ? "" : ` — ${decision.detail}`
      return `park: ${decision.reason}${detail}`
    }
    case "escalate": {
      return `escalate ${decision.step} → ${resourceLabel(decision.target)} [${decision.tier}]`
    }
    case "observe-only": {
      return `observe: ${summarizeDecision(decision.would)}`
    }
  }
}

export function outcomeLine(outcome: ReceiptOutcome | undefined): string {
  if (outcome === undefined) return "pending"
  if (outcome.status === "succeeded") return "succeeded"
  if (outcome.status === "failed") return `failed (${outcome.category})`
  return `interrupted (${outcome.reason})`
}

export function receiptLine(receipt: Receipt): string {
  return `#${String(receipt.id)} ${summarizeDecision(receipt.decision)} — ${outcomeLine(receipt.outcome)}`
}

export function receiptDetail(receipt: Receipt, now: number = Date.now()): string {
  return [
    `id: ${String(receipt.id)}`,
    `when: ${relativeTime(receipt.at, now)} (${new Date(receipt.at).toISOString()})`,
    `session: ${receipt.sessionID}`,
    `unit: ${receipt.unitID ?? "-"}`,
    `tier: ${receipt.tier ?? "-"}`,
    `decision: ${summarizeDecision(receipt.decision)}`,
    `outcome: ${outcomeLine(receipt.outcome)}`,
    "",
    `What happened: ${whatHappened(receipt)}`,
  ].join("\n")
}

/** "just now" / "2m ago" / "3h ago" / "5d ago" for a receipt timestamp. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return `${String(Math.floor(hours / 24))}d ago`
}

/**
 * Plain-language explanation for a receipt, keyed on the finite reason
 * vocabulary (the maps are total over it).
 */
export function whatHappened(receipt: Receipt): string {
  const decision = receipt.decision
  switch (decision.kind) {
    case "apply":
      return applyExplanation[decision.reason]
    case "defer":
      return deferExplanation[decision.reason]
    case "park":
      return parkExplanation[decision.reason]
    case "escalate":
      return `This turn needed stronger capability, so Adaptive moved it to ${resourceLabel(decision.target)}.`
    case "observe-only":
      return "Adaptive is observing: this is what it would have done, without applying it."
  }
}

const applyExplanation: Record<ApplyReason, string> = {
  pin: "Adaptive routed to the resource you pinned.",
  preferred:
    "Adaptive chose this resource: it is the preferred resource for the tier and was available.",
  fallback:
    "The preferred resource was unavailable, so Adaptive moved the turn to the next resource in the tier.",
  probe:
    "Adaptive sent this turn as a recovery probe after an outage, to check whether the resource works again.",
  draining: "Adaptive routed to this resource while its provider was draining capacity.",
}

const deferExplanation: Record<SchedulerDeferReason, string> = {
  "routing-defer": "No routing rule applied to this turn, so Adaptive left the choice to OpenCode.",
  "adaptive-off": "Adaptive is switched off, so every turn runs on OpenCode's own choice.",
  "pin-unverifiable":
    "The pinned resource could not be verified as available, so Adaptive left the choice to OpenCode.",
  "pin-incompatible":
    "The pinned resource does not fit this turn's requirements, so Adaptive left the choice to OpenCode.",
  "escalation-not-justified":
    "No structured capability evidence justified escalation, so Adaptive kept the current capability.",
  "escalation-budget-exhausted":
    "This unit has used its escalation budget; no further escalation is allowed.",
  "escalation-ceiling":
    "Adaptive is already at the highest capability tier; no stronger tier is configured.",
  "escalation-no-candidate":
    "No stronger resource was eligible to escalate to (unavailable, blocked, or not configured).",
}

const parkExplanation: Record<ParkReason, string> = {
  "all-blocked":
    "Every resource in the tier is currently unavailable, so the turn ran without Adaptive routing.",
  "no-candidates":
    "There are no models configured for this tier, so the turn ran without Adaptive routing.",
  "no-compatible-resource":
    "No configured resource fits this turn's requirements, so the turn ran without Adaptive routing.",
  "pin-blocked": "The pinned resource is unavailable and no fallback is allowed while pinned.",
}

/** Receipts shown per dialog page (bounded view). */
export const RECEIPTS_PAGE_SIZE = 20

export function receiptPage(receipts: readonly Receipt[]): Receipt[] {
  return receipts.slice(0, RECEIPTS_PAGE_SIZE)
}
