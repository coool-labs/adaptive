/**
 * The typed escalation tool (T-18, ADP-015): the smallest Adaptive-owned
 * mechanism for an agent to request stronger capability. The schema requires
 * a reason and evidence (validated by the standard-schema `~standard`
 * contract and re-validated defensively in `execute` — model-produced JSON is
 * untrusted). The tool is deliberately not a planning or task-management API.
 */
import { ESCALATION_TOOL_NAME, parseEscalationRequest } from "../../execution/escalation/index.js"

export { ESCALATION_TOOL_NAME }

/** Records the request against the session's current work unit. */
export type EscalationRecorder = (sessionID: string, reason: string, evidence: string) => boolean

const TOOL_DESCRIPTION =
  "Request stronger model capability for the current work unit. Provide a short reason and " +
  "the concrete evidence (what failed or was blocked). Adaptive records the request and " +
  "applies it at the next safe boundary within a finite budget. This is not a planning or " +
  "task-management tool."

/**
 * The tool's input schema as a Standard Schema v1 implementation: the host
 * can describe/validate it, while `execute` still re-validates defensively.
 */
const escalationInputSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "coool.adaptive",
    validate: (
      value: unknown,
    ): { value: unknown; issues?: undefined } | { issues: { message: string }[] } => {
      const request = parseEscalationRequest(value)
      if (request === undefined) {
        return { issues: [{ message: "reason and evidence are required non-empty strings" }] }
      }
      return { value: request }
    },
  },
}

/** Build the plugin tool registration for the escalation request surface. */
export function escalationTool(record: EscalationRecorder): {
  name: typeof ESCALATION_TOOL_NAME
  description: string
  input: typeof escalationInputSchema
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
} {
  return {
    name: ESCALATION_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: escalationInputSchema,
    execute: (input: unknown, context: { sessionID: string }) => {
      const request = parseEscalationRequest(input)
      if (request === undefined) {
        return Promise.resolve({ content: "reason and evidence are required non-empty strings" })
      }
      const recorded = record(context.sessionID, request.reason, request.evidence)
      return Promise.resolve(
        recorded
          ? { content: "escalation request recorded for the current work unit" }
          : { content: "no active work unit; the request was not recorded" },
      )
    },
  }
}
