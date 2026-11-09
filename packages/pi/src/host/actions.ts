import type { AdaptiveView } from "@coool/adaptive-core/flow/controller"
import { STATUS_EMPTY_MESSAGE } from "@coool/adaptive-core/flow/status"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { JsonFile } from "../store.js"
import { NOTE_VERBOSITIES, readPreferences, updatePreferences } from "../preferences.js"
import { updateToolCapability, type ToolCapability } from "../capabilities.js"

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

function declaredLabel(declared: readonly ToolCapability[], ref: ModelRef): string {
  const entry = declared.find((model) => model.providerID === ref.providerID && model.id === ref.id)
  if (entry === undefined) return "not declared · skipped on tool turns"
  return entry.tools ? "calls tools" : "no tool calls"
}

/**
 * Pi's catalog does not say which models call tools, and Adaptive never
 * guesses from a name: an undeclared model is skipped on every tool turn.
 */
export async function toolSupportAction(
  view: AdaptiveView,
  file: JsonFile,
  models: readonly ModelRef[],
  declared: readonly ToolCapability[],
): Promise<void> {
  // Tool support is declared per model, not per variant.
  const unique = [
    ...new Map(
      models.map((model) => [
        `${model.providerID}/${model.id}`,
        { providerID: model.providerID, id: model.id },
      ]),
    ),
  ]
  if (unique.length === 0) {
    await view.alert({ title: "Tool support", message: STATUS_EMPTY_MESSAGE })
    return
  }
  const ref = await view.select({
    title: "Tool support · select a model",
    options: unique.map(([label, model]) => ({
      title: label,
      value: model,
      description: declaredLabel(declared, model),
    })),
  })
  if (ref === undefined) return
  const tools = await view.select({
    title: `${ref.providerID}/${ref.id}`,
    options: [
      { title: "Calls tools", value: true, description: "eligible for tool turns" },
      { title: "No tool calls", value: false, description: "never routed to on tool turns" },
    ],
  })
  if (tools === undefined) return
  if (
    !(await view.confirm({
      title: "Confirm tool capability",
      message: `${ref.providerID}/${ref.id}: record tool support as ${tools ? "supported" : "unsupported"}? Only confirm this from provider documentation or a verified request.`,
    }))
  )
    return
  await updateToolCapability(file, ref, tools)
  view.toast("Tool capability saved", "success")
}
