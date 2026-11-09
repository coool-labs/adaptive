import type { AdaptiveEnv } from "@coool/adaptive-core/flow/controller"
import { runAdaptive } from "@coool/adaptive-core/flow/controller"
import { receiptDetail } from "@coool/adaptive-core/flow/receipts"
import { PI_COPY } from "../ui/copy.js"

export const SUBCOMMANDS = [
  "status",
  "why",
  "tiers",
  "health",
  "resume",
  "cancel",
  "observe on",
  "observe off",
  "doctor",
] as const
interface CommandContext {
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type: "warning" | "error" | "info"): void }
}
interface CommandOptions<C> {
  env(ctx: C): Promise<AdaptiveEnv>
  resume(ctx: C): Promise<void>
  cancel(ctx: C): Promise<void>
  clock(): number
}
interface CommandHost<C> {
  registerCommand(
    name: string,
    options: {
      description: string
      getArgumentCompletions(prefix: string): { value: string; label: string }[]
      handler(args: string, ctx: C & { waitForIdle(): Promise<void> }): Promise<void>
    },
  ): void
  registerShortcut(
    key: "ctrl+alt+a",
    options: {
      description: string
      handler(ctx: C & { isIdle(): boolean }): Promise<void>
    },
  ): void
}

export async function runCommand<C extends CommandContext>(
  args: string,
  ctx: C,
  options: CommandOptions<C>,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Open /adaptive in an interactive or RPC session.", "warning")
    return
  }
  const command = args.trim().replace(/\s+/g, " ")
  const env = await options.env(ctx)
  if (command === "resume") {
    await options.resume(ctx)
    return
  }
  if (command === "cancel") {
    await options.cancel(ctx)
    return
  }
  if (command === "doctor" || command === "health") {
    await env.actions?.[command]()
    return
  }
  if (command === "observe on" || command === "observe off") {
    const result = await env.api.setSettings({ mode: command === "observe on" ? "observe" : "off" })
    env.view.toast(
      result.ok
        ? "Observation setting saved. Your selected model is unchanged."
        : result.errors.join("; "),
      result.ok ? "success" : "error",
    )
    return
  }
  if (command === "why") {
    const latest = (await env.api.receipts()).find((receipt) => receipt.sessionID === env.sessionID)
    await env.view.alert({
      title: "Latest decision",
      message:
        latest === undefined
          ? "No decisions recorded in this session yet."
          : receiptDetail(latest, PI_COPY, options.clock()),
    })
    return
  }
  if (command === "" || command === "status" || command === "tiers") {
    if (command === "") await runAdaptive(env, undefined)
    else await runAdaptive(env, command === "tiers" ? "models" : "status")
    return
  }
  env.view.toast(`Unknown adaptive command. Use: ${SUBCOMMANDS.join(", ")}.`, "error")
}

export function registerCommands<C extends CommandContext>(
  pi: CommandHost<C>,
  options: CommandOptions<C>,
): void {
  pi.registerCommand("adaptive", {
    description: "Adaptive settings, decisions and diagnostics",
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
        value: command,
        label: command,
      })),
    async handler(args, ctx) {
      await ctx.waitForIdle()
      try {
        await runCommand(args, ctx, options)
      } catch {
        ctx.ui.notify(
          "Adaptive could not open. Run /adaptive doctor; your model is unchanged.",
          "error",
        )
      }
    },
  })
  pi.registerShortcut("ctrl+alt+a", {
    description: "Open Adaptive",
    async handler(ctx) {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current run before opening Adaptive.", "info")
        return
      }
      try {
        await runCommand("", ctx, options)
      } catch {
        ctx.ui.notify(
          "Adaptive could not open. Run /adaptive doctor; your model is unchanged.",
          "error",
        )
      }
    },
  })
}
