import type { OpenCodeClient } from "@opencode/client/promise"

import type { SettingsPatch } from "@coool/adaptive-core/state/settings/index"
import type { Receipt } from "@coool/adaptive-core/state/receipts/index"
import { waitingSessions } from "@coool/adaptive-core/flow/waiting"
import { adaptiveRpc } from "../../rpc.js"
import type { StatusSnapshot } from "../../rpc.js"

/**
 * Thin typed-RPC adapter for the GUI surface (ADP-034). Every call resolves to `undefined` (reads) or `false`
 * (writes) when the server is unreachable, so the page can render an explicit disconnected state instead of
 * throwing. `at` supplies the per-call location (see `rpcLocation`). The server stays the single source of truth (ADP-036): the GUI holds no local settings state.
 */
export interface GuiApi {
  status(): Promise<StatusSnapshot | undefined>
  /** Waiting sessions by id, each with when it resumes (`null`: unknown). */
  waiting(): Promise<Record<string, number | null> | undefined>
  receipts(): Promise<Receipt[] | undefined>
  update(patch: SettingsPatch): Promise<boolean>
  /** Calls back whenever settings change on the server. Returns the unsubscribe function. */
  watchSettings(onChange: () => void): () => void
}

export function adaptiveGuiApi(
  client: OpenCodeClient,
  at: () => { location?: { directory: string } },
): GuiApi {
  const rpc = client.rpc(adaptiveRpc)
  const unreachable = (): undefined => undefined
  return {
    status: () => rpc["status.get"](undefined, at()).catch(unreachable),
    // A snapshot from a server older than waiting sessions has none to read.
    waiting: () => rpc["status.get"](undefined, at()).then(waitingSessions).catch(unreachable),
    receipts: () => rpc["receipts.list"](undefined, at()).catch(unreachable),
    update: async (patch) => {
      try {
        const result = await rpc["settings.set"](patch, at())
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
