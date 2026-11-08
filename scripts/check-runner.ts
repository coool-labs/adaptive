import type { CheckStep } from "./check-plan.js"

export interface StepResult {
  status: number
  output: string
  milliseconds: number
}

export interface CheckEffects {
  execute(step: CheckStep): StepResult
  saveLog(path: string, output: string): void
  print(message: string): void
}

export function executeChecks(
  command: string,
  steps: readonly CheckStep[],
  selected: readonly string[],
  skipped: readonly string[],
  effects: CheckEffects,
): boolean {
  const skips = skipped.length === 0 ? "none" : skipped.join(", ")
  for (const step of steps) {
    const result = effects.execute(step)
    const path = `test-artifacts/run/${step.workspace}/${step.script.replaceAll(":", "-")}.log`
    effects.saveLog(path, result.output)
    if (result.status !== 0) {
      effects.print(`✗ ${step.workspace} ${step.script} — see ${path}`)
      effects.print(result.output.split("\n").slice(-40).join("\n"))
      effects.print(`${command}: FAILED at ${step.script} (${step.workspace}; skipped: ${skips})`)
      return false
    }
    effects.print(`✓ ${step.workspace} ${step.script} ${(result.milliseconds / 1000).toFixed(1)}s`)
  }
  const scope = selected.length === 0 ? "no affected workspaces" : selected.join(", ")
  effects.print(`${command}: ok (${scope}; skipped: ${skips})`)
  return true
}
