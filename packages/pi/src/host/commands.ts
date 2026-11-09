import { ADAPTIVE_SUBCOMMANDS, runAdaptiveCommand } from "@coool/adaptive-core/flow/command"
import type { AdaptiveEnv } from "@coool/adaptive-core/flow/controller"

interface CommandContext {
  readonly hasUI: boolean
  readonly ui: { notify(message: string, type: "warning" | "error" | "info"): void }
}
interface CommandOptions<C> {
  env(ctx: C): Promise<AdaptiveEnv>
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
  await runAdaptiveCommand(await options.env(ctx), args)
}

export function registerCommands<C extends CommandContext>(
  pi: CommandHost<C>,
  options: CommandOptions<C>,
): void {
  pi.registerCommand("adaptive", {
    description: "Adaptive settings, decisions and diagnostics",
    getArgumentCompletions: (prefix) =>
      ADAPTIVE_SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
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
