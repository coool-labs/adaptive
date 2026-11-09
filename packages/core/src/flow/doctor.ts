/**
 * Doctor report (ADP-062): host checks plus the checks every host can derive
 * from the status snapshot, rendered problems-first so the first screen
 * answers "is anything wrong, and what do I do".
 */
import { TIERS } from "../routing/tier-policy/types.js"
import type { StatusSnapshot } from "../status.js"
import { healthEntries } from "./status.js"
import { resourceLabel } from "./tiers.js"

export interface DoctorCheck {
  readonly state: "ok" | "warning" | "error"
  readonly message: string
  /** Absent (never undefined): checks cross the RPC boundary as JSON. */
  readonly action?: string
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`
}

/** Empty tiers, limited models and parked work, from one status snapshot. */
export function statusChecks(snapshot: StatusSnapshot): DoctorCheck[] {
  const empty: DoctorCheck[] = TIERS.filter((tier) => snapshot.tiers[tier].length === 0).map(
    (tier) => ({
      state: "warning",
      message: `${tier}: no configured models`,
      action: "Open /adaptive tiers to add a model.",
    }),
  )
  // A model listed in two tiers is one resource with one health state.
  const limited = new Set(
    healthEntries(snapshot)
      .filter(({ status }) => status.health !== "healthy")
      .map(({ status }) => resourceLabel(status.ref)),
  ).size
  return [
    ...empty,
    limited === 0
      ? { state: "ok", message: "Health: no models limited" }
      : {
          state: "ok",
          message: `Health: ${plural(limited, "model")} limited`,
          action: "Inspect /adaptive health; reset only after checking the provider.",
        },
    snapshot.parked === 0
      ? { state: "ok", message: "No parked work" }
      : {
          state: "ok",
          message: plural(snapshot.parked, "parked task"),
          action: "Use /adaptive resume or /adaptive cancel in the waiting session.",
        },
  ]
}

const LABELS: Record<DoctorCheck["state"], string> = { ok: "OK", warning: "CHECK", error: "FIX" }

const SEVERITY: readonly DoctorCheck["state"][] = ["error", "warning", "ok"]

/** Problems first: the first screen answers "is anything wrong, and what do I do". */
export function doctorLines(checks: readonly DoctorCheck[]): string[] {
  const count = (state: DoctorCheck["state"]) =>
    checks.filter((check) => check.state === state).length
  const problems = count("error") + count("warning")
  return [
    problems === 0
      ? `All ${String(checks.length)} checks OK`
      : `${String(count("error"))} to fix · ${String(count("warning"))} to check · ${String(count("ok"))} OK`,
    ...SEVERITY.flatMap((state) => checks.filter((check) => check.state === state)).flatMap(
      (check) => [
        `${LABELS[check.state]} ${check.message}`,
        ...(check.action === undefined ? [] : [`  ${check.action}`]),
      ],
    ),
  ]
}
