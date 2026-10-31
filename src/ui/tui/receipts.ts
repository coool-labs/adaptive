/**
 * Receipt view models (ADP-030/033): one-line summaries and bounded detail
 * text for the `/adaptive` receipts browser. No secrets — receipt content is
 * already bounded at write time; this layer only formats.
 */
import type { Decision } from "../../core/scheduler/types.js"
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

export function receiptDetail(receipt: Receipt): string {
  return [
    `id: ${String(receipt.id)}`,
    `at: ${new Date(receipt.at).toISOString()}`,
    `session: ${receipt.sessionID}`,
    `unit: ${receipt.unitID ?? "-"}`,
    `tier: ${receipt.tier ?? "-"}`,
    `decision: ${summarizeDecision(receipt.decision)}`,
    `outcome: ${outcomeLine(receipt.outcome)}`,
  ].join("\n")
}

/** Receipts shown per dialog page (bounded view). */
export const RECEIPTS_PAGE_SIZE = 20

export function receiptPage(receipts: readonly Receipt[]): Receipt[] {
  return receipts.slice(0, RECEIPTS_PAGE_SIZE)
}
