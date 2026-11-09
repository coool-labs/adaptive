// covers: ["ADP-008", "ADP-009", "ADP-013", "ADP-014", "ADP-022", "ADP-026", "ADP-064", "ADP-065"]
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

function dispatches(path: string): string[] {
  const events: unknown[] = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
  return events.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "kind" in entry &&
    entry.kind === "dispatch" &&
    "model" in entry &&
    typeof entry.model === "string"
      ? [entry.model]
      : [],
  )
}

export async function exerciseJson(options: {
  node: string
  cli: string
  cwd: string
  agentDir: string
  fixture: string
  env: Record<string, string>
  run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<string>
}): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"]
  assert.ok(trace)
  for (const scenario of ["default", "success", "503", "429", "quota", "auth"]) {
    writeFileSync(trace, "")
    // A fresh child discovers the globally installed package; no Adaptive -e override.
    const model = scenario === "success" ? "quick" : "auto"
    const args = [
      options.cli,
      "--print",
      "--mode",
      "json",
      "--offline",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-session",
      "-e",
      options.fixture,
      ...(scenario === "default" ? [] : ["--model", `adaptive/${model}`]),
      "--",
      "Exercise packed CLI",
    ]
    const output = await options.run(options.node, args, options.cwd, {
      ...options.env,
      PI_MATRIX_SCENARIO: scenario,
    })
    writeFileSync(join(options.cwd, `json-${scenario}.log`), output)
    let expected = ["standard", "standard-b"]
    if (scenario === "default" || scenario === "auth") expected = ["standard"]
    if (scenario === "success") expected = ["quick"]
    assert.deepEqual(dispatches(trace), expected)
    assert.equal(output.includes("MATRIX_OK"), scenario !== "auth")
    const jsonEvents: unknown[] = output
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
    assert.ok(
      jsonEvents.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          entry.type === "agent_end",
      ),
      "CLI did not emit agent_end",
    )
    const health = readFileSync(join(options.agentDir, "adaptive/health.json"), "utf8")
    if (scenario === "429") {
      assert.ok(health.includes("rate_limited"), "real 429 outcome was not persisted")
      writeFileSync(trace, "")
      const child = await options.run(options.node, args, options.cwd, {
        ...options.env,
        PI_MATRIX_SCENARIO: "success",
      })
      writeFileSync(join(options.cwd, "json-shared-health-child.log"), child)
      assert.ok(child.includes("MATRIX_OK standard-b"))
      assert.deepEqual(dispatches(trace), ["standard-b"], "a fresh child ignored shared health")
    }
    if (scenario === "quota")
      assert.ok(health.includes("quota_exhausted"), "real quota outcome was not persisted")
    // Each scripted scenario starts healthy in this matrix-owned sandbox.
    writeFileSync(join(options.agentDir, "adaptive/health.json"), '{"version":1,"records":[]}')
  }
}
