import { describe, expect, it } from "vitest"
import { parseCheckOptions, planChecks } from "../check-plan.js"

describe("check planning", () => {
  const available = ["opencode", "pi"] as const
  const scripts = {
    core: [],
    testkit: [],
    opencode: ["typecheck", "coverage", "build", "e2e:runtime"],
    pi: ["typecheck", "coverage"],
  }

  it("defaults to affected scope", () => {
    expect(parseCheckOptions(["check"], available)).toEqual({
      command: "check",
      all: false,
      packages: [],
      skip: [],
    })
  })

  it("accepts forced scope and deduplicates options", () => {
    expect(parseCheckOptions(["verify", "--all"], available).all).toBe(true)
    expect(
      parseCheckOptions(
        ["check", "--pkg", "pi", "--pkg", "pi", "--skip", "lint", "--skip", "lint"],
        available,
      ),
    ).toEqual({ command: "check", all: false, packages: ["pi"], skip: ["lint"] })
  })

  it.each([
    [[], "Expected check or verify"],
    [["unknown"], "Expected check or verify"],
    [["check", "--pkg"], "Unknown --pkg"],
    [["check", "--pkg", "unknown"], "Unknown --pkg"],
    [["check", "--skip"], "Unknown --skip"],
    [["check", "--skip", "unknown"], "Unknown --skip"],
    [["check", "--unknown"], "Unknown argument"],
    [["check", "--all", "--pkg", "pi"], "Use --all or --pkg"],
  ])("rejects invalid arguments %j", (args, message) => {
    expect(() => parseCheckOptions(args, available)).toThrow(message)
  })

  it("runs root gates once then package gates in dependency order", () => {
    const options = parseCheckOptions(["check"], available)
    expect(planChecks(options, available, scripts)).toEqual([
      { workspace: "root", script: "format:check" },
      { workspace: "root", script: "lint" },
      { workspace: "root", script: "lint:biome" },
      { workspace: "root", script: "typecheck:tooling" },
      { workspace: "root", script: "coverage:tooling" },
      { workspace: "opencode", script: "typecheck" },
      { workspace: "pi", script: "typecheck" },
      { workspace: "opencode", script: "coverage" },
      { workspace: "pi", script: "coverage" },
    ])
    expect(planChecks(options, [], scripts)).toEqual([])
  })

  it("adds only supported release gates, with build before real-host tests", () => {
    const options = parseCheckOptions(["verify", "--skip", "lint"], available)
    const steps = planChecks(options, ["opencode"], scripts)
    expect(steps.map((step) => step.script)).toEqual([
      "format:check",
      "lint:biome",
      "typecheck:tooling",
      "coverage:tooling",
      "typecheck",
      "coverage",
      "build",
      "e2e:runtime",
    ])
  })

  it("runs the Pi SDK, full packed host matrix, and traceability gates in verify only", () => {
    const piScripts = {
      ...scripts,
      pi: [
        "typecheck",
        "coverage",
        "build",
        "pack:check",
        "e2e:runtime",
        "e2e:tui",
        "traceability",
      ],
    }
    const verify = planChecks(
      parseCheckOptions(["verify", "--pkg", "pi"], available),
      ["pi"],
      piScripts,
    )
    expect(verify.filter((step) => step.workspace === "pi").map((step) => step.script)).toEqual([
      "typecheck",
      "coverage",
      "build",
      "pack:check",
      "e2e:runtime",
      "e2e:tui",
      "traceability",
    ])
    const check = planChecks(
      parseCheckOptions(["check", "--pkg", "pi"], available),
      ["pi"],
      piScripts,
    )
    expect(check.filter((step) => step.workspace === "pi").map((step) => step.script)).toEqual([
      "typecheck",
      "coverage",
    ])
  })
})
