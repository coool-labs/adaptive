import assert from "node:assert/strict"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { launchTerminal } from "@termwright/driver"
import type { HealthPayload } from "@coool/adaptive-core/state/health/types"
import { object, traceEvents, waitForTrace } from "../matrix/trace.js"

export interface PiTerminalOptions {
  node: string
  cli: string
  cwd: string
  env: Record<string, string>
  fixture: string
  columns?: number
  session?: string
  sessionDirectory?: string
  model?: string
  tools?: string
  trust?: boolean
}

export type PiTerminal = Awaited<ReturnType<typeof launchTerminal>>

export async function launchPi(options: PiTerminalOptions): Promise<PiTerminal> {
  mkdirSync(options.cwd, { recursive: true })
  const command: string[] = [
    options.node,
    options.cli,
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...(options.tools === undefined ? ["--no-tools"] : ["--tools", options.tools]),
  ]
  if (options.session !== undefined) command.push("--session", options.session)
  else if (options.sessionDirectory === undefined) command.push("--no-session")
  else command.push("--session-dir", options.sessionDirectory)
  command.push("-e", options.fixture)
  if (options.model !== undefined) command.push("--model", options.model)
  const terminal = await launchTerminal({
    command,
    cwd: options.cwd,
    env: options.env,
    columns: options.columns ?? 80,
    rows: 40,
    semanticNegotiationMs: 0,
  })
  if (options.trust === true) {
    await terminal.waitForText("Trust project folder?", { timeout: 20_000 })
    await terminal.press("Enter")
  }
  return terminal
}

export async function submit(terminal: PiTerminal, text: string): Promise<void> {
  await terminal.type(text)
  await terminal.press("Enter")
}

export async function selectModel(terminal: PiTerminal, model: string): Promise<void> {
  await terminal.press("Control+l")
  await terminal.waitForText("Enter to select", { timeout: 10_000 })
  await terminal.type(model)
  await terminal.waitForText("Enter to select", { timeout: 10_000 })
  await terminal.press("Enter")
  const split = model.indexOf("/")
  await terminal.waitForText(`(${model.slice(0, split)}) ${model.slice(split + 1)}`, {
    timeout: 10_000,
  })
}

export async function turn(terminal: PiTerminal, trace: string, prompt: string): Promise<void> {
  const settled = traceEvents(trace).filter((event) => event["kind"] === "settled").length
  await submit(terminal, prompt)
  await waitForTrace(
    trace,
    (events) => events.filter((event) => event["kind"] === "settled").length > settled,
  )
}

/** Only matrix-owned files are edited, atomically, while the host is idle or closed. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.matrix-next`, `${JSON.stringify(value)}\n`)
  renameSync(`${path}.matrix-next`, path)
}

export function settings(options: PiTerminalOptions, patch: Record<string, unknown>): void {
  const file = join(options.env["PI_CODING_AGENT_DIR"] ?? "", "adaptive/settings.json")
  const current: unknown = JSON.parse(readFileSync(file, "utf8"))
  assert.ok(object(current))
  writeJson(file, { ...current, inviteDismissed: true, ...patch })
}

export function limitStandard(
  options: PiTerminalOptions,
  until: number,
  ids = ["standard", "standard-b"],
): void {
  const payload: HealthPayload = {
    version: 1,
    records: ids.map((id) => ({
      key: { providerID: "adaptive-faux", modelID: id },
      health: "quota_exhausted",
      breaker: { state: "closed", failures: 0, openCount: 0 },
      window: { kind: "quota", until },
      updatedAt: Date.now(),
    })),
  }
  writeJson(join(options.env["PI_CODING_AGENT_DIR"] ?? "", "adaptive/health.json"), payload)
}
