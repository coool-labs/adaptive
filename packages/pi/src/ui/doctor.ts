export interface DoctorCheck {
  readonly state: "ok" | "warning" | "error"
  readonly message: string
  readonly action?: string
}

function parts(version: string): readonly [number, number, number] | undefined {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined
  const [major, minor, patch] = version.split(".")
  return [Number(major), Number(minor), Number(patch)]
}

function compare(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (const index of [0, 1, 2] as const) {
    const difference = a[index] - b[index]
    if (difference !== 0) return difference
  }
  return 0
}

export function versionChecks(
  version: string,
  minimum: string,
  testedUpTo: string | undefined,
): DoctorCheck[] {
  const actual = parts(version)
  const floor = parts(minimum)
  const tested = testedUpTo === undefined ? undefined : parts(testedUpTo)
  if (actual === undefined || floor === undefined)
    return [
      {
        state: "warning",
        message: `Pi ${version}: version support could not be checked`,
        action: "Pick a normal model and report this version.",
      },
    ]
  if (actual[0] !== 1 || compare(actual, floor) < 0)
    return [
      {
        state: "error",
        message: `Pi ${version} is unsupported (requires ≥${minimum} <2)`,
        action: "Install a supported Pi version or pick a normal model.",
      },
    ]
  const checks: DoctorCheck[] = [
    { state: "ok", message: `Pi ${version} (supported: ≥${minimum} <2)` },
  ]
  if (tested === undefined)
    checks.push({
      state: "warning",
      message: "Packed-host tested-up-to evidence is not recorded",
      action: "Run the complete Pi host matrix before release.",
    })
  else if (compare(actual, tested) > 0)
    checks.push({
      state: "warning",
      message: `Pi ${version} is newer than last tested ${String(testedUpTo)}`,
      action: "If routing misbehaves, pick a normal model and report it.",
    })
  else checks.push({ state: "ok", message: `Packed hosts tested up to ${String(testedUpTo)}` })
  return checks
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
