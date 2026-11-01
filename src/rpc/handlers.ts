/**
 * RPC handler binding (ADP-034/036): adapts the supervisor's state API to the
 * typed RPC methods. Handlers never throw for expected outcomes — an invalid
 * patch is a per-field `PatchResult`, and an internal failure degrades to
 * `{ ok: false }` (fail-open, ADP-031). Read methods propagate host errors so
 * surfaces can show them honestly.
 */
import { OPERATING_MODES } from "../core/scheduler/types.js"
import type { OperatingMode } from "../core/scheduler/types.js"
import { logFailOpen } from "../supervisor/log.js"
import { isValidSessionID } from "../state/session-modes/index.js"
import type { SessionModeSetResult } from "../state/session-modes/index.js"
import type { PatchResult } from "../state/settings/types.js"
import type { SettingsPatch, SettingsV1 } from "../state/settings/index.js"
import type { Receipt } from "../state/receipts/types.js"
import type { StatusSnapshot } from "./status.js"

export interface AdaptiveRpcSource {
  settings(): Promise<SettingsV1>
  updateSettings(patch: SettingsPatch): Promise<PatchResult>
  status(): Promise<StatusSnapshot>
  receipts(): Promise<Receipt[]>
  getSessionMode(sessionID: string): Promise<OperatingMode | null>
  setSessionMode(sessionID: string, mode: OperatingMode | null): Promise<void>
}

export type SettingsChangedEmit = (name: "settings-changed", data: { version: number }) => unknown

/**
 * Both RPC change events over one signature: each emit call site pairs the
 * event name with its own payload shape (the union is narrowed at the
 * registration site).
 */
export type AdaptiveRpcEmit = (
  name: "settings-changed" | "session-mode-changed",
  data: { version: number } | { sessionID: string },
) => unknown

/** Per-field errors for a session-mode patch, mirroring the settings contract. */
function sessionModeSetError(input: {
  sessionID: string
  mode: OperatingMode | null
}): string | undefined {
  if (!isValidSessionID(input.sessionID)) {
    return "sessionID must be a non-empty string of at most 128 characters"
  }
  if (input.mode !== null && !(OPERATING_MODES as readonly string[]).includes(input.mode)) {
    return `mode must be one of ${OPERATING_MODES.join(", ")} or null`
  }
  return undefined
}

export function adaptiveRpcHandlers(
  source: AdaptiveRpcSource,
  emit?: AdaptiveRpcEmit,
): {
  "settings.get": (input: undefined) => Promise<SettingsV1>
  "settings.set": (input: SettingsPatch) => Promise<PatchResult>
  "status.get": (input: undefined) => Promise<StatusSnapshot>
  "receipts.list": (input: undefined) => Promise<Receipt[]>
  "session-mode.get": (input: { sessionID: string }) => Promise<{ mode: OperatingMode | null }>
  "session-mode.set": (input: {
    sessionID: string
    mode: OperatingMode | null
  }) => Promise<SessionModeSetResult>
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
    "session-mode.get": (input) =>
      source.getSessionMode(input.sessionID).then((mode) => ({ mode })),
    "session-mode.set": async (input) => {
      const invalid = sessionModeSetError(input)
      if (invalid !== undefined) return { ok: false, errors: [invalid] }
      try {
        await source.setSessionMode(input.sessionID, input.mode)
      } catch (error) {
        logFailOpen("rpc-set", error)
        return { ok: false, errors: ["internal error"] }
      }
      if (emit !== undefined) {
        try {
          await emit("session-mode-changed", { sessionID: input.sessionID })
        } catch (error) {
          logFailOpen("rpc-emit", error)
        }
      }
      return { ok: true }
    },
  }
}
