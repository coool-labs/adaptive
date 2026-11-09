import type { AdaptiveApi } from "@coool/adaptive-core/flow/controller"
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { isTierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { StatusSnapshot } from "@coool/adaptive-core/status"
import { readSettings, updateSettings } from "../settings.js"
import { readReceipts } from "../receipts.js"
import { effectiveMode, requestedTier, SESSION_ENTRY, sessionModeOverride } from "../session.js"
import type { BranchEntry } from "../task.js"
import type { JsonFile, JsonTransactionFile } from "../store.js"

export interface ControlOptions {
  readonly settings: JsonFile
  readonly receipts: JsonTransactionFile
  readonly sessionID: string
  readonly branch: () => readonly BranchEntry[]
  readonly model: () => { readonly provider: string; readonly id: string } | undefined
  readonly manualModel: () => ModelRef | undefined
  readonly selectModel: (model: ModelRef) => Promise<boolean>
  readonly append: (type: string, data: unknown) => void
  readonly idle: () => boolean
  readonly status: () => Promise<StatusSnapshot>
}

/** In-process binding of the shared flow; no second settings or routing state. */
export function controlApi(options: ControlOptions): AdaptiveApi {
  const validSession = (id: string) => id === options.sessionID && id.trim() !== ""
  return {
    settings: () => readSettings(options.settings),
    setSettings: (patch) => updateSettings(options.settings, patch),
    status: options.status,
    receipts: () => readReceipts(options.receipts),
    async sessionMode(id) {
      if (!validSession(id))
        throw new Error("Adaptive sessionID: this command belongs to another session")
      const settings = await readSettings(options.settings)
      return options.model()?.provider === "adaptive"
        ? effectiveMode(options.model(), settings.mode, options.branch())
        : sessionModeOverride(options.branch())
    },
    async setSessionMode(id, mode) {
      if (!validSession(id)) return { ok: false, errors: ["invalid sessionID"] }
      if (!options.idle())
        return { ok: false, errors: ["Wait for the current run before changing its mode."] }
      const settings = await readSettings(options.settings)
      const next: OperatingMode = mode ?? settings.mode
      const selected = options.model()
      let target: ModelRef | undefined
      if (next === "active") target = { providerID: "adaptive", id: "auto" }
      else if (selected?.provider === "adaptive") target = options.manualModel()
      if (next !== "active" && selected?.provider === "adaptive" && target === undefined)
        return {
          ok: false,
          errors: ["Pick a normal model in Pi's model picker to pause Adaptive."],
        }
      if (target !== undefined && !(await options.selectModel(target)))
        return {
          ok: false,
          errors: ["Model could not be selected. Check credentials with /adaptive doctor."],
        }
      options.append(SESSION_ENTRY, { version: 1, mode })
      return { ok: true }
    },
    tierRequest(id) {
      if (!validSession(id))
        return Promise.reject(
          new Error("Adaptive sessionID: this command belongs to another session"),
        )
      return Promise.resolve(requestedTier(options.branch()))
    },
    setTierRequest(id, tier) {
      if (!validSession(id)) return Promise.resolve({ ok: false, errors: ["invalid sessionID"] })
      if (tier !== null && !isTierName(tier))
        return Promise.resolve({
          ok: false,
          errors: ["invalid tier: expected quick, standard, advanced, or null"],
        })
      options.append(SESSION_ENTRY, { version: 1, tier })
      return Promise.resolve({ ok: true })
    },
  }
}
