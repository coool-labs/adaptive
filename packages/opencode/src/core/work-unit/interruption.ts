/**
 * Why an OpenCode execution was interrupted. Values mirror the verified
 * `session.execution.interrupted` event payload (`reason`), which OpenCode
 * guarantees to be one of these four.
 */
export const INTERRUPT_REASONS = [
  "user",
  "shutdown",
  "superseded",
  "inactivity",
] as const satisfies readonly string[]

export type InterruptReason = (typeof INTERRUPT_REASONS)[number]
