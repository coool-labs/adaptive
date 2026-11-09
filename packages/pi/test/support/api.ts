import type { AdaptiveApi } from "@coool/adaptive-core/flow/controller"
import { buildStatus } from "@coool/adaptive-core/status"
import { defaultSettings, applyPatch } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsPatch, SettingsV1 } from "@coool/adaptive-core/state/settings/types"

export function fakeApi(initial: SettingsV1 = { ...defaultSettings(), inviteDismissed: true }) {
  let settings = initial
  const patches: SettingsPatch[] = []
  const api: AdaptiveApi = {
    settings: () => Promise.resolve(settings),
    setSettings: (patch) => {
      patches.push(patch)
      const result = applyPatch(settings, patch)
      if (result.ok) settings = result.settings
      return Promise.resolve(result)
    },
    status: () =>
      Promise.resolve(
        buildStatus({ settings, health: [], capacity: {}, parked: 0, waiting: [], receipts: 0 }),
      ),
    receipts: () => Promise.resolve([]),
    sessionMode: () => Promise.resolve(null),
    setSessionMode: () => Promise.resolve({ ok: true }),
    tierRequest: () => Promise.resolve(null),
    setTierRequest: () => Promise.resolve({ ok: true }),
  }
  return { api, patches }
}
