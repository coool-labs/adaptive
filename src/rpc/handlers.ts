/**
 * RPC handler binding (ADP-034/036): adapts the supervisor's state API to the
 * typed RPC methods. Handlers never throw for expected outcomes — an invalid
 * patch is a per-field `PatchResult`, and an internal failure degrades to
 * `{ ok: false }` (fail-open, ADP-031). Read methods propagate host errors so
 * surfaces can show them honestly.
 */
import { logFailOpen } from "../supervisor/log.js"
import type { PatchResult } from "../state/settings/types.js"
import type { SettingsPatch, SettingsV1 } from "../state/settings/index.js"
import type { Receipt } from "../state/receipts/types.js"
import type { StatusSnapshot } from "./status.js"

export interface AdaptiveRpcSource {
  settings(): Promise<SettingsV1>
  updateSettings(patch: SettingsPatch): Promise<PatchResult>
  status(): Promise<StatusSnapshot>
  receipts(): Promise<Receipt[]>
}

export type SettingsChangedEmit = (name: "settings-changed", data: { version: number }) => unknown

export function adaptiveRpcHandlers(
  source: AdaptiveRpcSource,
  emit?: SettingsChangedEmit,
): {
  "settings.get": (input: undefined) => Promise<SettingsV1>
  "settings.set": (input: SettingsPatch) => Promise<PatchResult>
  "status.get": (input: undefined) => Promise<StatusSnapshot>
  "receipts.list": (input: undefined) => Promise<Receipt[]>
} {
  return {
    "settings.get": () => source.settings(),
    "settings.set": async (patch) => {
      try {
        const result = await source.updateSettings(patch)
        if (result.ok && emit !== undefined) {
          try {
            await emit("settings-changed", { version: result.settings.version })
          } catch (error) {
            logFailOpen("rpc-emit", error)
          }
        }
        return result
      } catch (error) {
        logFailOpen("rpc-set", error)
        return { ok: false, errors: ["internal error"] }
      }
    },
    "status.get": () => source.status(),
    "receipts.list": () => source.receipts(),
  }
}
