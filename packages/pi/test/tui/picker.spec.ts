// covers: ["ADP-054", "ADP-057", "ADP-064"]
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { launchTerminal } from "@termwright/driver"

export async function exercisePicker(options: {
  node: string
  cli: string
  cwd: string
  env: Record<string, string>
  fixture: string
  screenshot: string
}): Promise<void> {
  const terminal = await launchTerminal({
    command: [
      options.node,
      options.cli,
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
      "--models",
      "adaptive/quick,adaptive/standard,adaptive/advanced,adaptive/auto,adaptive-faux/manual-physical",
    ],
    cwd: options.cwd,
    env: options.env,
    columns: 100,
    rows: 32,
    semanticNegotiationMs: 0,
  })
  try {
    await terminal.waitForText("Trust project folder?", { timeout: 20_000 })
    await terminal.press("Enter")
    await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
    for (const id of ["quick", "standard", "advanced", "auto"]) {
      await terminal.press("Control+l")
      await terminal.waitForText("Enter to select", { timeout: 10_000 })
      await terminal.type(`adaptive/${id}`)
      await terminal.waitForText("[adaptive]", { timeout: 10_000 })
      await terminal.press("Enter")
      await terminal.waitForText(`(adaptive) ${id}`, { timeout: 10_000 })
    }
    for (const [provider, id] of [
      ["adaptive-faux", "manual-physical"],
      ["adaptive", "quick"],
      ["adaptive", "standard"],
      ["adaptive", "advanced"],
      ["adaptive", "auto"],
    ] as const) {
      await terminal.press("Control+p")
      await terminal.waitForText(`(${provider}) ${id}`, { timeout: 10_000 })
    }
    await terminal.type("Exercise packed Adaptive")
    await terminal.press("Enter")
    await terminal.waitForText("MATRIX_OK", { timeout: 15_000 })
    await terminal.press("Control+l")
    await terminal.waitForText("Enter to select", { timeout: 10_000 })
    await terminal.type("manual-physical")
    await terminal.press("Enter")
    await terminal.waitForText("(adaptive-faux) manual-physical", { timeout: 10_000 })
    await terminal.type("Exercise manual takeover")
    await terminal.press("Enter")
    // The footer is restored only after the second turn finishes.
    await terminal.waitForText("MATRIX_OK manual-physical", { timeout: 15_000 })
    const trace: unknown[] = readFileSync(options.env["PI_MATRIX_TRACE"] ?? "", "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
    const dispatches = trace.filter(
      (entry): entry is { kind: string; model: string } =>
        typeof entry === "object" &&
        entry !== null &&
        "kind" in entry &&
        entry.kind === "dispatch" &&
        "model" in entry &&
        typeof entry.model === "string",
    )
    assert.deepEqual(
      dispatches.map((entry) => entry.model),
      ["standard", "manual-physical"],
    )
    console.log(
      JSON.stringify({
        surface: "tui",
        picker: ["quick", "standard", "advanced", "auto"],
        dispatches,
        result: "PASS",
      }),
    )
  } finally {
    writeFileSync(options.screenshot, terminal.screen().text())
    await terminal.close()
  }
}
