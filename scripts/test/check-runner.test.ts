import { describe, expect, it } from "vitest"
import { executeChecks } from "../check-runner.js"
import type { CheckStep } from "../check-plan.js"

describe("check execution", () => {
  const steps: CheckStep[] = [
    { workspace: "root", script: "format:check" },
    { workspace: "opencode", script: "coverage" },
  ]

  it("runs in order and writes a log per step", () => {
    const invoked: CheckStep[] = []
    const logs: string[] = []
    const printed: string[] = []
    expect(
      executeChecks("check", steps, ["opencode"], [], {
        execute(step) {
          invoked.push(step)
          return { status: 0, output: "passed", milliseconds: 1234 }
        },
        saveLog(path, output) {
          logs.push(`${path}: ${output}`)
        },
        print(message) {
          printed.push(message)
        },
      }),
    ).toBe(true)
    expect(invoked).toEqual(steps)
    expect(logs).toEqual([
      "test-artifacts/run/root/format-check.log: passed",
      "test-artifacts/run/opencode/coverage.log: passed",
    ])
    expect(printed).toEqual([
      "✓ root format:check 1.2s",
      "✓ opencode coverage 1.2s",
      "check: ok (opencode; skipped: none)",
    ])
  })

  it("stops on failure, shows only the last 40 lines, and reports skips", () => {
    const invoked: CheckStep[] = []
    const printed: string[] = []
    const output = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join("\n")
    expect(
      executeChecks("verify", steps, ["opencode"], ["e2e:tui"], {
        execute(step) {
          invoked.push(step)
          return { status: 1, output, milliseconds: 0 }
        },
        saveLog(path, saved) {
          expect(path).toContain("format-check.log")
          expect(saved).toBe(output)
        },
        print(message) {
          printed.push(message)
        },
      }),
    ).toBe(false)
    expect(invoked).toHaveLength(1)
    expect(printed[0]).toContain("✗ root format:check")
    expect(printed[1]?.split("\n")).toHaveLength(40)
    expect(printed[1]?.split("\n")[0]).toBe("line 10")
    expect(printed[2]).toBe("verify: FAILED at format:check (root; skipped: e2e:tui)")
  })

  it("reports an empty affected scope without running anything", () => {
    const printed: string[] = []
    expect(
      executeChecks("check", [], [], [], {
        execute() {
          throw new Error("must not execute")
        },
        saveLog() {
          throw new Error("must not write")
        },
        print(message) {
          printed.push(message)
        },
      }),
    ).toBe(true)
    expect(printed).toEqual(["check: ok (no affected workspaces; skipped: none)"])
  })
})
