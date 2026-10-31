/**
 * Operating-mode wrapper (GOAL operating modes). OBSERVE and CONTROL run the
 * identical core; OBSERVE wraps the result without applying it. OFF never
 * reaches the scheduler, but the total wrapper maps it to an explicit defer
 * so the union stays closed.
 */
import type { Decision, OperatingMode } from "./types.js"

export function forMode(decision: Decision, mode: OperatingMode): Decision {
  if (mode === "observe") {
    return { kind: "observe-only", would: decision }
  }
  if (mode === "control") {
    return decision
  }
  return { kind: "defer", reason: "adaptive-off" }
}
