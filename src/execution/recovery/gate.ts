export const UNIT_PHASES = ["admission", "busy", "settling", "idle"] as const
export type UnitPhase = (typeof UNIT_PHASES)[number]

export type RecoveryWindow = { kind: "open" } | { kind: "closed"; reason: "busy" | "settling" }

/**
 * Safe-boundary gate for applying a recovered preferred resource (ADP-016/
 * ADP-018). A unit's model is only ever changed at a safe boundary:
 * - `admission`: the unit is starting; routing decides fresh.
 * - `idle`: between episodes; parked resumes and re-routes may proceed.
 * - `busy`: mid-work — running work is never pulled to another resource.
 * - `settling`: a failed execution has not settled yet — Adaptive never
 *    switches or prompts while the session is settling (settle-first is
 *    enforced by the continuation executor; this gate is the second guard).
 */
export function recoveryWindow(phase: UnitPhase): RecoveryWindow {
  switch (phase) {
    case "busy":
      return { kind: "closed", reason: "busy" }
    case "settling":
      return { kind: "closed", reason: "settling" }
    case "admission":
    case "idle":
      return { kind: "open" }
  }
}
