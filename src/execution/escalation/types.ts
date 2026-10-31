/**
 * The Adaptive-owned escalation request surface (T-18, ADP-015..017). The
 * schema requires a reason and evidence — it is deliberately the smallest
 * typed mechanism for an agent to request stronger capability, and it is not
 * a planning or task-management API. The request is recorded against the
 * current work unit and applies at the next safe boundary within the finite
 * per-unit budget; a completing unit discards it (routing re-runs fresh).
 */

/** The tool name as registered with the host. */
export const ESCALATION_TOOL_NAME = "adaptive_escalate"

/** Each field is bounded — the request never carries unbounded prose. */
export const MAX_ESCALATION_FIELD_LENGTH = 256

export interface EscalationRequest {
  readonly reason: string
  readonly evidence: string
}

/**
 * Total parser for the tool input (the host forwards model-produced JSON, so
 * the runtime shape is untrusted even though the standard schema describes
 * it). Both fields are required, non-empty, and bounded.
 */
export function parseEscalationRequest(input: unknown): EscalationRequest | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  const reason = record["reason"]
  const evidence = record["evidence"]
  if (typeof reason !== "string" || reason.length === 0) return undefined
  if (typeof evidence !== "string" || evidence.length === 0) return undefined
  return {
    reason: reason.slice(0, MAX_ESCALATION_FIELD_LENGTH),
    evidence: evidence.slice(0, MAX_ESCALATION_FIELD_LENGTH),
  }
}

/** One-line summary recorded as escalation evidence (bounded). */
export function escalationDetail(request: EscalationRequest): string {
  return `${request.reason}: ${request.evidence}`
}
