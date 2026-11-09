/**
 * `/adaptive <subcommand>`, shared by every host (ADP-062): one parser, one
 * copy, so a subcommand typed in Pi behaves the same in OpenCode. Action-backed
 * subcommands exist only where the host wires the action.
 */
import {
  cancelHere,
  resumeHere,
  runDoctor,
  runHealthReset,
  type AdaptiveActions,
} from "./actions.js"
import { runAdaptive, type AdaptiveEnv } from "./controller.js"
import { receiptDetail } from "./receipts.js"

export const ADAPTIVE_SUBCOMMANDS = [
  "status",
  "why",
  "tiers",
  "tools",
  "health",
  "resume",
  "cancel",
  "observe on",
  "observe off",
  "doctor",
] as const
export type AdaptiveSubcommand = (typeof ADAPTIVE_SUBCOMMANDS)[number]

const REQUIRES: Partial<Record<AdaptiveSubcommand, keyof AdaptiveActions>> = {
  tools: "tools",
  health: "resetHealth",
  resume: "resume",
  cancel: "cancel",
  doctor: "doctor",
}

/** The subcommands a host with these actions can run, in menu order. */
export function adaptiveSubcommands(actions: AdaptiveActions | undefined): AdaptiveSubcommand[] {
  return ADAPTIVE_SUBCOMMANDS.filter((command) => {
    const needs = REQUIRES[command]
    return needs === undefined || actions?.[needs] !== undefined
  })
}

/** Runs `/adaptive <input>`; an empty input opens the menu. API failures propagate to the host. */
export async function runAdaptiveCommand(env: AdaptiveEnv, input: string): Promise<void> {
  const command = input.trim().replace(/\s+/g, " ")
  const { resetHealth, resume, cancel, tools, doctor } = env.actions ?? {}
  switch (command) {
    case "":
      await runAdaptive(env)
      return
    case "status":
      await runAdaptive(env, "status")
      return
    case "tiers":
      await runAdaptive(env, "models")
      return
    case "why": {
      const latest = (await env.api.receipts()).find(
        (receipt) => receipt.sessionID === env.sessionID,
      )
      await env.view.alert({
        title: "Latest decision",
        message:
          latest === undefined
            ? "No decisions recorded in this session yet."
            : receiptDetail(latest, env.copy, (env.clock ?? Date.now)()),
      })
      return
    }
    case "observe on":
    case "observe off": {
      const result = await env.api.setSettings({
        mode: command === "observe on" ? "observe" : "off",
      })
      env.view.toast(
        result.ok
          ? "Observation setting saved. Your selected model is unchanged."
          : result.errors.join("; "),
        result.ok ? "success" : "error",
      )
      return
    }
    case "tools":
      if (tools === undefined) break
      await tools()
      return
    case "health":
      if (resetHealth === undefined) break
      await runHealthReset(env, resetHealth)
      return
    case "resume":
      if (resume === undefined) break
      await resumeHere(env, resume)
      return
    case "cancel":
      if (cancel === undefined) break
      await cancelHere(env, cancel)
      return
    case "doctor":
      if (doctor === undefined) break
      await runDoctor(env, doctor)
      return
  }
  env.view.toast(
    `Unknown adaptive command. Use: ${adaptiveSubcommands(env.actions).join(", ")}.`,
    "error",
  )
}
