import type { AdaptiveView } from "@coool/adaptive-core/flow/controller"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { JsonFile } from "../store.js"
import { NOTE_VERBOSITIES, readPreferences, updatePreferences } from "../preferences.js"
import { updateToolCapability } from "../capabilities.js"

export const DEFAULT_MODEL_HELP =
  'In Pi settings.json, set:\n{\n  "defaultProvider": "adaptive",\n  "defaultModel": "auto"\n}\nPi exposes no extension API to save this default. Your current model is unchanged.'

export async function preferencesAction(view: AdaptiveView, file: JsonFile): Promise<void> {
  const current = await readPreferences(file)
  const choice = await view.select({
    title: "Preferences",
    options: [
      { title: `Transcript notes: ${current.verbosity}`, value: "notes" },
      {
        title: `Escalate from a pinned tier: ${current.escalateFromPinned ? "on" : "off"}`,
        value: "escalate",
      },
    ],
  })
  if (choice === "notes") {
    const verbosity = await view.select({
      title: "Transcript notes",
      options: NOTE_VERBOSITIES.map((value) => ({ title: value, value })),
    })
    if (verbosity === undefined) return
    await updatePreferences(file, { verbosity })
  } else if (choice === "escalate") {
    const confirmed = await view.confirm({
      title: "Change pinned-tier escalation?",
      message: current.escalateFromPinned
        ? "Stop automatic capability escalation from pinned tiers?"
        : "Allow a failed task to move one tier above your pin, only with capability evidence and within the task budget?",
    })
    if (confirmed !== true) return
    await updatePreferences(file, { escalateFromPinned: !current.escalateFromPinned })
  } else return
  view.toast("Preferences saved", "success")
}

export async function healthAction(
  view: AdaptiveView,
  models: readonly ModelRef[],
  reset: (model: ModelRef) => Promise<void>,
): Promise<void> {
  const ref = await view.select({
    title: "Health · select a resource to reset",
    options: models.map((model) => ({
      title: resourceLabel(model),
      value: model,
      description: "Mark healthy (also clears inherited provider limits)",
    })),
  })
  if (ref === undefined) return
  if (
    !(await view.confirm({
      title: "Reset resource health?",
      message: `Reset ${resourceLabel(ref)} and its inherited provider limits? Other models on this provider may be affected. This does not restore actual provider quota.`,
    }))
  )
    return
  await reset(ref)
  view.toast("Health reset", "success")
}

export async function confirmToolCapability(
  view: AdaptiveView,
  file: JsonFile,
  ref: ModelRef,
  tools: boolean,
): Promise<void> {
  if (
    !(await view.confirm({
      title: "Confirm tool capability",
      message: `${resourceLabel(ref)}: record tool support as ${tools ? "supported" : "unsupported"}? Only confirm this from provider documentation or a verified request.`,
    }))
  )
    return
  await updateToolCapability(file, ref, tools)
  view.toast("Tool capability saved", "success")
}
