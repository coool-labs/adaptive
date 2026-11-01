/**
 * The typed escalation tool (T-18, ADP-015): the smallest Adaptive-owned
 * mechanism for an agent to request stronger capability. The input schema is
 * a plain JSON Schema — the host builds the model-facing tool definition by
 * converting the schema, and a Standard Schema implementation is silently
 * dropped ("Schema vendor does not support JSON Schema conversion", observed
 * on 2.2.5). The tool also opts out of the host's code-mode bundling: with
 * code mode enabled the host routes codemode-bundled tools through the
 * `execute` tool only, and a direct call fails with "No tool named ... is
 * currently available" (observed on 2.2.5). `execute` still re-validates
 * defensively: model-produced JSON is untrusted. The tool is deliberately
 * not a planning or task-management API.
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

/** The tool's input schema in JSON Schema form (host-convertible). */
const escalationInputSchema = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      description: "Short reason why the current work unit needs stronger capability.",
    },
    evidence: {
      type: "string",
      minLength: 1,
      description: "Concrete evidence of the capability gap: what failed or was blocked.",
    },
  },
  required: ["reason", "evidence"],
  additionalProperties: false,
}

/** Keeps the tool directly callable when the host's code mode is enabled. */
const escalationToolOptions = { codemode: false } as const

/** Build the plugin tool registration for the escalation request surface. */
export function escalationTool(record: EscalationRecorder): {
  name: typeof ESCALATION_TOOL_NAME
  description: string
  input: typeof escalationInputSchema
  options: typeof escalationToolOptions
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
} {
  return {
    name: ESCALATION_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: escalationInputSchema,
    options: escalationToolOptions,
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
