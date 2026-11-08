import type { Workspace } from "./affected.js"

export interface CheckOptions {
  command: "check" | "verify"
  all: boolean
  packages: Workspace[]
  skip: string[]
}

export interface CheckStep {
  workspace: Workspace | "root"
  script: string
}

const ROOT_STEPS = ["format:check", "lint", "lint:biome", "typecheck:tooling", "coverage:tooling"]
const PACKAGE_STEPS = ["typecheck", "coverage"]
const RELEASE_STEPS = [
  "build",
  "pack:check",
  "plugin-test",
  "e2e:runtime",
  "e2e:gui",
  "e2e:web",
  "e2e:tui",
  "traceability",
]

export function parseCheckOptions(
  args: readonly string[],
  available: readonly Workspace[],
): CheckOptions {
  const command = args[0]
  if (command !== "check" && command !== "verify") throw new Error("Expected check or verify")
  const options: CheckOptions = { command, all: false, packages: [], skip: [] }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--all") {
      options.all = true
    } else if (arg === "--pkg") {
      const value = args[++index]
      const workspace = available.find((entry) => entry === value)
      if (workspace === undefined) throw new Error(`Unknown --pkg: ${String(value)}`)
      if (!options.packages.includes(workspace)) options.packages.push(workspace)
    } else if (arg === "--skip") {
      const value = args[++index]
      if (
        value === undefined ||
        ![...ROOT_STEPS, ...PACKAGE_STEPS, ...RELEASE_STEPS].includes(value)
      ) {
        throw new Error(`Unknown --skip step: ${String(value)}`)
      }
      if (!options.skip.includes(value)) options.skip.push(value)
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`)
    }
  }
  if (options.all && options.packages.length > 0) throw new Error("Use --all or --pkg, not both")
  return options
}

/** Script availability keeps private workspaces free of fake pack/E2E commands. */
export function planChecks(
  options: CheckOptions,
  selected: readonly Workspace[],
  scripts: Readonly<Record<Workspace, readonly string[]>>,
): CheckStep[] {
  if (selected.length === 0) return []
  const steps: CheckStep[] = ROOT_STEPS.map((script) => ({ workspace: "root", script }))
  const packageSteps =
    options.command === "verify" ? [...PACKAGE_STEPS, ...RELEASE_STEPS] : PACKAGE_STEPS
  for (const script of packageSteps) {
    for (const workspace of selected) {
      if (scripts[workspace].includes(script)) steps.push({ workspace, script })
    }
  }
  return steps.filter((step) => !options.skip.includes(step.script))
}
