/**
 * TUI entrypoint (ADP-033): registers the `/adaptive` slash command and
 * drives the dialog-based flows through typed RPC. The TUI is a thin view —
 * no local settings state, no rendering of its own (the host dialogs render).
 *
 * Deliberately JSX-free: every surface is a host dialog, so the entry only
 * adapts the plugin context to the controller seams. Import the plugin define
 * from the `tui/plugin` subpath to avoid pulling the optional Solid peers.
 */
import { define } from "@opencode/plugin/tui/plugin"
import type { Context } from "@opencode/plugin/tui/plugin"
import { PLUGIN_ID } from "./plugin-id.js"
import { adaptiveRpc } from "./rpc/definition.js"
import { runAdaptive } from "./ui/tui/controller.js"
import type { AdaptiveApi, AdaptiveView } from "./ui/tui/controller.js"
import type { ModelSummary } from "./ui/tui/tiers.js"

export default define({
  id: PLUGIN_ID,
  setup(context: Context) {
    const client = context.client.rpc(adaptiveRpc)
    const api: AdaptiveApi = {
      settings: () => client["settings.get"](),
      setSettings: (patch) => client["settings.set"](patch),
      status: () => client["status.get"](),
      receipts: () => client["receipts.list"](),
    }
    const view: AdaptiveView = {
      select: (options) => context.ui.dialog.select(options),
      confirm: (options) => context.ui.dialog.confirm(options),
      alert: (options) => context.ui.dialog.alert(options),
      toast: (message, variant) => {
        context.ui.toast.show({ message, variant })
      },
    }
    // Real OpenCode models for the tier editor search (ADP-033); structural
    // summaries keep the view models free of client types.
    const models = (): readonly ModelSummary[] => {
      const list = context.data.location.model.list(context.location)
      return (list ?? []).map((info) => ({
        providerID: info.providerID,
        modelID: info.modelID,
        name: info.name,
        variants: info.variants.map((variant) => variant.id),
      }))
    }
    context.keymap.layer(() => ({
      commands: [
        {
          id: "coool.adaptive.menu",
          title: "Adaptive",
          group: "Adaptive",
          palette: true,
          slash: { name: "adaptive" },
          run: () => {
            void runAdaptive({ api, view, models }).catch((error: unknown) => {
              view.toast(error instanceof Error ? error.message : String(error), "error")
            })
          },
        },
      ],
    }))
  },
})
