/**
 * Read-side parsing for persisted receipts. Every parser is total: it accepts
 * `unknown` and returns typed records, dropping anything invalid — a
 * corrupted receipts file can never take the plugin down (ADP-031). Reason
 * vocabularies are membership-checked (the write path is typed); free-text
 * fields are re-bounded. An older plugin reading newer receipts may drop
 * unknown-vocabulary entries — receipts are bounded diagnostics, eviction is
 * expected behavior, and the payload version guards the schema itself.
 */
import {
  APPLY_REASONS,
  ESCALATION_EVIDENCE_KINDS,
  ESCALATION_STEPS,
  PARK_REASONS,
  SKIP_REASONS,
  SCHEDULER_DEFER_REASONS,
} from "../../routing/scheduler/types.js"
import type {
  ApplyDecision,
  DeferDecision,
  Decision,
  EscalateDecision,
  EscalationEvidence,
  ObserveOnlyDecision,
  ParkDecision,
  SkippedCandidate,
} from "../../routing/scheduler/types.js"
import { TIERS } from "../../routing/tier-policy/types.js"
import type { TierName } from "../../routing/tier-policy/types.js"
import { INTERRUPT_REASONS } from "../../routing/work-unit/interruption.js"
import { FAILURE_CATEGORIES } from "../../health/classifier/types.js"
import { parseModelRef } from "../settings/parse.js"
import { boundText } from "./bound.js"
import { MAX_RECEIPTS, RECEIPTS_VERSION } from "./types.js"
import type { Receipt, ReceiptOutcome } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundString(raw: unknown): string | undefined {
  return typeof raw === "string" ? boundText(raw) : undefined
}

function isFiniteNonNegative(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
}

function parseVocab<V extends readonly string[]>(
  raw: unknown,
  vocabulary: V,
): V[number] | undefined {
  if (typeof raw !== "string") return undefined
  return vocabulary.find((entry) => entry === raw)
}

function parseTier(raw: unknown): TierName | undefined {
  if (typeof raw !== "string") return undefined
  return TIERS.find((tier) => tier === raw)
}

function parseOptionalBounded(raw: unknown): string | undefined {
  const value = boundString(raw)
  return value === "" ? undefined : value
}

/** Free-text detail keeps empty strings (round-trips through the store). */
function parseDetailBounded(raw: unknown): string | undefined {
  return boundString(raw) ?? undefined
}

function parseApplyEvidence(raw: unknown): ApplyDecision["evidence"] | undefined {
  if (!isRecord(raw)) return undefined
  const skippedRaw = raw["skipped"]
  if (!Array.isArray(skippedRaw)) return undefined
  const skipped: SkippedCandidate[] = []
  for (const entry of skippedRaw.slice(0, 8)) {
    if (!isRecord(entry)) continue
    const ref = parseModelRef(entry["ref"])
    const why = parseVocab(entry["why"], SKIP_REASONS)
    if (ref === undefined || why === undefined) continue
    skipped.push({ ref, why })
  }
  const probeId = parseDetailBounded(raw["probeId"])
  return { skipped, ...(probeId !== undefined ? { probeId } : {}) }
}

function parseApply(raw: Record<string, unknown>): ApplyDecision | undefined {
  const model = parseModelRef(raw["model"])
  const reason = parseVocab(raw["reason"], APPLY_REASONS)
  const evidence = parseApplyEvidence(raw["evidence"])
  if (model === undefined || reason === undefined || evidence === undefined) {
    return undefined
  }
  const tier = parseTier(raw["tier"])
  return {
    kind: "apply",
    model,
    ...(tier !== undefined ? { tier } : {}),
    reason,
    evidence,
  }
}

function parseDefer(raw: Record<string, unknown>): DeferDecision | undefined {
  const reason = parseVocab(raw["reason"], SCHEDULER_DEFER_REASONS)
  if (reason === undefined) return undefined
  const detail = parseDetailBounded(raw["detail"])
  return { kind: "defer", reason, ...(detail !== undefined ? { detail } : {}) }
}

function parsePark(raw: Record<string, unknown>): ParkDecision | undefined {
  const reason = parseVocab(raw["reason"], PARK_REASONS)
  if (reason === undefined) return undefined
  const detail = parseDetailBounded(raw["detail"])
  return { kind: "park", reason, ...(detail !== undefined ? { detail } : {}) }
}

function parseEscalate(raw: Record<string, unknown>): EscalateDecision | undefined {
  const target = parseModelRef(raw["target"])
  const step = parseVocab(raw["step"], ESCALATION_STEPS)
  const tier = parseTier(raw["tier"])
  const budgetRemainingRaw = raw["budgetRemaining"]
  if (
    target === undefined ||
    step === undefined ||
    tier === undefined ||
    !isFiniteNonNegative(budgetRemainingRaw)
  ) {
    return undefined
  }
  const evidenceRaw = raw["evidence"]
  if (!Array.isArray(evidenceRaw)) return undefined
  const evidence: EscalationEvidence[] = []
  for (const entry of evidenceRaw.slice(0, 4)) {
    if (!isRecord(entry)) continue
    const kind = parseVocab(entry["kind"], ESCALATION_EVIDENCE_KINDS)
    if (kind === undefined) continue
    const detail = parseDetailBounded(entry["detail"])
    evidence.push({ kind, ...(detail !== undefined ? { detail } : {}) })
  }
  return {
    kind: "escalate",
    target,
    step,
    tier,
    evidence,
    budgetRemaining: budgetRemainingRaw,
  }
}

/** Max `observe-only` nesting accepted on read (the scheduler produces ≤ 1). */
const MAX_PARSE_DEPTH = 2

function parseObserveOnly(
  raw: Record<string, unknown>,
  depth: number,
): ObserveOnlyDecision | undefined {
  if (depth >= MAX_PARSE_DEPTH) return undefined
  const would = parseDecision(raw["would"], depth + 1)
  return would === undefined ? undefined : { kind: "observe-only", would }
}

function parseDecision(raw: unknown, depth = 0): Decision | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw["kind"]) {
    case "apply":
      return parseApply(raw)
    case "defer":
      return parseDefer(raw)
    case "park":
      return parsePark(raw)
    case "escalate":
      return parseEscalate(raw)
    case "observe-only":
      return parseObserveOnly(raw, depth)
    default:
      return undefined
  }
}

function parseOutcome(raw: unknown): ReceiptOutcome | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw["status"]) {
    case "succeeded":
      return { status: "succeeded" }
    case "failed": {
      const category = parseVocab(raw["category"], FAILURE_CATEGORIES)
      return category === undefined ? undefined : { status: "failed", category }
    }
    case "interrupted": {
      const reason = parseVocab(raw["reason"], INTERRUPT_REASONS)
      return reason === undefined ? undefined : { status: "interrupted", reason }
    }
    default:
      return undefined
  }
}

function parseReceipt(raw: unknown): Receipt | undefined {
  if (!isRecord(raw)) return undefined
  const id = raw["id"]
  const at = raw["at"]
  const sessionID = parseOptionalBounded(raw["sessionID"])
  const decision = parseDecision(raw["decision"])
  if (
    !(isFiniteNonNegative(id) && Number.isInteger(id) && isFiniteNonNegative(at)) ||
    sessionID === undefined ||
    decision === undefined
  ) {
    return undefined
  }
  const unitID = parseOptionalBounded(raw["unitID"])
  const tier = parseTier(raw["tier"])
  // A present-but-invalid outcome invalidates the whole record: stripping
  // just the outcome would break first-outcome-wins across a restart (the
  // receipt would accept a later, different outcome as its first).
  let outcome: ReceiptOutcome | undefined
  if (raw["outcome"] !== undefined) {
    outcome = parseOutcome(raw["outcome"])
    if (outcome === undefined) return undefined
  }
  return {
    id,
    at,
    sessionID,
    ...(unitID !== undefined ? { unitID } : {}),
    ...(tier !== undefined ? { tier } : {}),
    decision,
    ...(outcome !== undefined ? { outcome } : {}),
  }
}

/**
 * Parse a persisted receipts payload. Accepts the versioned shape and a
 * versionless draft array; anything else yields no receipts.
 */
export function parseReceiptsPayload(raw: unknown): Receipt[] {
  let list: unknown
  if (isRecord(raw)) {
    const version = raw["version"]
    if (version !== RECEIPTS_VERSION && version !== undefined) return []
    list = raw["receipts"]
  } else if (Array.isArray(raw)) {
    list = raw
  }
  if (!Array.isArray(list)) return []
  const parsed = list
    .map(parseReceipt)
    .filter((receipt): receipt is Receipt => receipt !== undefined)
  return parsed.length > MAX_RECEIPTS ? parsed.slice(-MAX_RECEIPTS) : parsed
}
