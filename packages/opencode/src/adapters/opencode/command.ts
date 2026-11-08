import { OPERATING_MODES } from "../../core/scheduler/types.js"
import type { OperatingMode } from "../../core/scheduler/types.js"
import type { StatusSnapshot } from "../../rpc/status.js"
import { logFailOpen } from "../../supervisor/log.js"
import { modeDescription } from "../../ui/flow/menu.js"
import { healthEntries, stateCell } from "../../ui/flow/status.js"
import { resourceLabel } from "../../ui/flow/tiers.js"

const COMMAND_NAME = "web-adaptive"

/** `on` is the everyday word for `active`. */
const MODE_WORDS = ["on", "off", "observe", "active"] as const

const USAGE = `Usage: /${COMMAND_NAME} [status | ${MODE_WORDS.join(" | ")}]`

/** How to switch, appended to the status so the next step is on screen. */
const HELP = [
  "Switch the mode:",
  ...OPERATING_MODES.map(
    (mode) => `/${COMMAND_NAME} ${mode === "active" ? "on" : mode} — ${modeDescription(mode)}`,
  ),
  `/${COMMAND_NAME} — show this status again`,
]

export interface CommandSource {
  status(): Promise<StatusSnapshot>
  setMode(
    mode: OperatingMode,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }>
}

type Action = { kind: "status" } | { kind: "mode"; mode: OperatingMode } | { kind: "usage" }

function parse(text: string): Action {
  const argument = text
    .trim()
    .replace(new RegExp(`^/${COMMAND_NAME}\\b\\s*`, "i"), "")
    .trim()
    .toLowerCase()
  if (argument === "" || argument === "status") return { kind: "status" }
  if (argument === "on") return { kind: "mode", mode: "active" }
  const mode = OPERATING_MODES.find((candidate) => candidate === argument)
  return mode === undefined ? { kind: "usage" } : { kind: "mode", mode }
}

function modeLine(prefix: string, mode: OperatingMode): string {
  return `${prefix} ${mode} — ${modeDescription(mode)}.`
}

/** One model as `provider/model (tier, health[, window, usage, pin])`. */
function modelLine(entry: ReturnType<typeof healthEntries>[number], pin: StatusSnapshot["pin"]) {
  const state = stateCell(entry.status, pin)
  const detail = state === "-" ? entry.status.health : `${entry.status.health}, ${state}`
  return `${resourceLabel(entry.status.ref)} (${entry.tier}, ${detail})`
}

function statusLines(snapshot: StatusSnapshot): string[] {
  const entries = healthEntries(snapshot)
  const models =
    entries.length === 0
      ? ["No models configured yet."]
      : entries.map((entry) => modelLine(entry, snapshot.pin))
  return [modeLine("Adaptive:", snapshot.mode), ...models, ...HELP]
}

async function reply(source: CommandSource, text: string): Promise<string[]> {
  const action = parse(text)
  switch (action.kind) {
    case "usage":
      return [USAGE]
    case "status":
      return statusLines(await source.status())
    case "mode": {
      const result = await source.setMode(action.mode)
      return [
        result.ok
          ? modeLine("Adaptive switched to", action.mode)
          : `Adaptive could not switch mode: ${result.errors.join("; ")}`,
      ]
    }
  }
}

/**
 * The web UI's way to see and switch the mode (ADP-034). The host's browser
 * app never mounts plugin GUI bundles, but it lists server commands in the
 * composer's slash menu, so this is the one channel that reaches it. The name
 * differs from the TUI's `/adaptive` on purpose: a same-named server command
 * appears twice in the TUI palette. Replies are plain text posted without
 * waking the model, one message per line: the web timeline shows each message
 * as a single truncated row, so a long reply would hide its end.
 */
export function adaptiveCommand(
  source: CommandSource,
  say: (sessionID: string, text: string) => Promise<unknown>,
) {
  return {
    name: COMMAND_NAME,
    description: `Adaptive mode and status: /${COMMAND_NAME} | on | off | observe | active`,
    execute: async (input: { sessionID: string; prompt: { text: string } }): Promise<void> => {
      const lines = await reply(source, input.prompt.text).catch((error: unknown) => {
        logFailOpen("command", error)
        return ["Adaptive could not complete that command."]
      })
      for (const line of lines) await say(input.sessionID, line)
    },
  }
}
