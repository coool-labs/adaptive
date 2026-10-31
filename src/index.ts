import { Plugin } from "@opencode/plugin"

/**
 * Plugin id as required by GOAL.md: must not collide with the `opencode.*`
 * namespace and must stay stable across releases (referenced by settings
 * storage keys and receipts).
 */
export const PLUGIN_ID = "coool.adaptive"

/**
 * Entry point wired into OpenCode via `opencode.json(c)`.
 * Supervision wiring (admission hooks, event subscriptions, RPC surface) is
 * added incrementally in T-14/T-17; until then the plugin activates with
 * nothing to tear down.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  setup() {
    return
  },
})
