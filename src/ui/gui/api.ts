import type { OpenCodeClient } from "@opencode/client/promise"

import type { SettingsPatch } from "../../state/settings/index.js"
import type { Receipt } from "../../state/receipts/index.js"
import { adaptiveRpc } from "../../rpc.js"
import type { StatusSnapshot } from "../../rpc.js"

/**
 * Thin typed-RPC adapter for the GUI surface (ADP-034). Every call resolves to `undefined` (reads) or `false`
 * (writes) when the server is unreachable, so the page can render an explicit disconnected state instead of
 * throwing. The server stays the single source of truth (ADP-036): the GUI holds no local settings state.
 */
export interface GuiApi {
  status(): Promise<StatusSnapshot | undefined>
  receipts(): Promise<Receipt[] | undefined>
  update(patch: SettingsPatch): Promise<boolean>
  /** Calls back whenever settings change on the server. Returns the unsubscribe function. */
  watchSettings(onChange: () => void): () => void
}

export function adaptiveGuiApi(client: OpenCodeClient): GuiApi {
  const rpc = client.rpc(adaptiveRpc)
  return {
    status: () => rpc["status.get"]().catch(() => undefined),
    receipts: () => rpc["receipts.list"]().catch(() => undefined),
    update: async (patch) => {
      try {
        const result = await rpc["settings.set"](patch)
        return result.ok
      } catch {
        return false
      }
    },
    watchSettings: (onChange) =>
      rpc.events.on("settings-changed", () => {
        onChange()
      }),
  }
}
