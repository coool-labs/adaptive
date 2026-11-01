/**
 * The `/adaptive` keyboard-flow controller (ADP-033): a pure-ish state machine
 * over two seams — the typed RPC API and the host dialogs/toasts. It holds no
 * local settings state: every mutation goes through `settings.set` and the
 * returned snapshot becomes the new local view (the server is the single
 * source of truth, ADP-036).
 *
 * Flow contract: `undefined` selections always mean "cancel this step" — the
 * menu loop continues or exits; API failures toast and keep the loop alive.
 */
import type { OperatingMode } from "../../core/scheduler/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import { TIERS } from "../../core/tier-policy/types.js"
import type { ModelRef } from "../../core/work-unit/types.js"
import { sameModelRef } from "../../core/work-unit/types.js"
import type { SettingsPatch, SettingsV1 } from "../../state/settings/index.js"
import type { PatchResult } from "../../state/settings/types.js"
import type { Receipt } from "../../state/receipts/types.js"
import type { StatusSnapshot } from "../../rpc/status.js"
import {
  HEALTH_EMPTY_MESSAGE,
  healthDetail,
  healthEntries,
  healthOverview,
  type HealthEntry,
} from "./status.js"
import { mainMenuOptions, modeOptions, type MainMenuChoice } from "./menu.js"
import {
  modelPickerOptions,
  moveResource,
  moveResourceToTop,
  removeResource,
  resourceLabel,
  tierEditorOptions,
  tierMenuOptions,
  variantOptions,
  healthTag,
  type ModelSummary,
} from "./tiers.js"
import { errorText, type SelectOption } from "./options.js"
import { receiptDetail, receiptLine, receiptPage, RECEIPTS_PAGE_SIZE } from "./receipts.js"

export interface AdaptiveView {
  select<Value>(options: {
    title: string
    placeholder?: string
    options: readonly SelectOption<Value>[]
    current?: Value
    search?: (
      query: string,
      options: readonly SelectOption<Value>[],
    ) => readonly SelectOption<Value>[]
  }): Promise<Value | undefined>
  confirm(options: {
    title: string
    message: string
    label?: { confirm?: string; cancel?: string }
  }): Promise<boolean | undefined>
  alert(options: { title: string; message: string }): Promise<void>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): void
}

export interface AdaptiveApi {
  settings: () => Promise<SettingsV1>
  setSettings: (patch: SettingsPatch) => Promise<PatchResult>
  status: () => Promise<StatusSnapshot>
  receipts: () => Promise<Receipt[]>
}

export type ModelLister = () => readonly ModelSummary[]

export interface AdaptiveEnv {
  api: AdaptiveApi
  view: AdaptiveView
  models: ModelLister
}

export const INVITE_TITLE = "OpenCode Adaptive"
export const INVITE_MESSAGE =
  "Adaptive starts in Observe mode: routing decisions are recorded as receipts, " +
  "but no model is switched. Open /adaptive to configure tiers or switch to Active."

/** Tracks whether this dialog session already showed the save toast. */
export interface SaveFeedback {
  once: boolean
}

/** Run one API call; on failure toast and return undefined. */
async function tryApi<T>(env: AdaptiveEnv, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    env.view.toast(errorText(error), "error")
    return undefined
  }
}

/**
 * Apply one patch; alert on validation errors, toast on success. The host
 * never auto-dismisses toasts, so the success toast is shown only on the
 * first successful save of a dialog session — later saves stay silent
 * (the updated menu already reflects them).
 */
async function applySettings(
  env: AdaptiveEnv,
  patch: SettingsPatch,
  feedback: SaveFeedback,
): Promise<SettingsV1 | undefined> {
  const result = await tryApi(env, () => env.api.setSettings(patch))
  if (result === undefined) return undefined
  if (!result.ok) {
    await env.view.alert({ title: "Invalid settings", message: result.errors.join("; ") })
    return undefined
  }
  if (!feedback.once) {
    env.view.toast("Settings saved", "success")
    feedback.once = true
  }
  return result.settings
}

export async function runAdaptive(env: AdaptiveEnv): Promise<void> {
  const loaded = await tryApi(env, () => env.api.settings())
  if (loaded === undefined) return
  let settings = loaded
  const feedback: SaveFeedback = { once: false }
  if (!settings.inviteDismissed) {
    await env.view.confirm({ title: INVITE_TITLE, message: INVITE_MESSAGE })
    const pick = await env.view.select({
      title: INVITE_TITLE,
      options: [
        { title: "Open the menu now", value: true },
        { title: "Later", value: false },
      ],
    })
    const dismissed = await applySettings(env, { inviteDismissed: true }, feedback)
    if (dismissed !== undefined) settings = dismissed
    if (pick !== true) return
  }
  for (;;) {
    // The menu descriptions degrade silently: a failing status read must not
    // spam a toast on every loop iteration (the flows that need status toast
    // through tryApi themselves).
    const status = await env.api.status().catch(() => undefined)
    const choice = await env.view.select({
      title: `Adaptive (${settings.mode})`,
      options: mainMenuOptions(settings, status),
    })
    if (choice === undefined) return
    if (choice === "health") {
      settings = (await runHealthView(env, feedback)) ?? settings
      continue
    }
    if (choice === "models") {
      settings = (await runTierEditor(env, settings, feedback)) ?? settings
      continue
    }
    if (choice === "mode") {
      settings = (await runModeMenu(env, settings, feedback)) ?? settings
      continue
    }
    if (choice === "pin") {
      settings = (await runPinMenu(env, settings, feedback)) ?? settings
      continue
    }
    await runReceiptsView(env)
  }
}

async function runModeMenu(
  env: AdaptiveEnv,
  settings: SettingsV1,
  feedback: SaveFeedback,
): Promise<SettingsV1 | undefined> {
  const pick = await env.view.select({
    title: "Operating mode",
    options: modeOptions(settings.mode),
  })
  if (pick === undefined || pick === settings.mode) return undefined
  return applySettings(env, { mode: pick }, feedback)
}

type HealthOutcome = SettingsV1 | undefined

/**
 * The browsable health view: one option per configured resource (with its
 * live health tag), opening into a detail alert plus actions (pin, filtered
 * receipts). Settings change only through the pin action.
 */
async function runHealthView(env: AdaptiveEnv, feedback: SaveFeedback): Promise<HealthOutcome> {
  const snapshot = await tryApi(env, () => env.api.status())
  if (snapshot === undefined) return undefined
  const entries = healthEntries(snapshot)
  if (entries.length === 0) {
    await env.view.alert({ title: "Health", message: HEALTH_EMPTY_MESSAGE })
    return undefined
  }
  // The overview comes first: every resource's state on a single screen.
  // The per-resource drill-down below is for detail and actions, not the
  // only way to see health.
  await env.view.alert({ title: "Health", message: healthOverview(snapshot) })
  for (;;) {
    const options: SelectOption<HealthEntry | "back">[] = entries.map((entry) => ({
      title: `${resourceLabel(entry.status.ref)}${healthTag(entry.status)}`,
      description: `tier ${entry.tier}`,
      value: entry,
    }))
    options.push({ title: "Back", value: "back" })
    const pick = await env.view.select({ title: "Inspect a resource", options })
    if (pick === undefined || pick === "back") return undefined
    await env.view.alert({
      title: `Health: ${resourceLabel(pick.status.ref)}`,
      message: healthDetail(pick, snapshot),
    })
    const action = await env.view.select({
      title: resourceLabel(pick.status.ref),
      options: [
        {
          title: "Pin this resource",
          value: "pin",
          description: "always route to this resource when it's available",
        },
        { title: "Show receipts for this resource", value: "receipts" },
        { title: "Back", value: "back" },
      ],
    })
    if (action === "pin") {
      const next = await applySettings(env, { pin: pick.status.ref }, feedback)
      if (next !== undefined) return next
    }
    if (action === "receipts") {
      await runReceiptsView(env, pick.status.ref)
    }
  }
}

type TierEditorOutcome = SettingsV1 | undefined

async function runTierEditor(
  env: AdaptiveEnv,
  settings: SettingsV1,
  feedback: SaveFeedback,
): Promise<TierEditorOutcome> {
  for (;;) {
    const status = await tryApi(env, () => env.api.status())
    if (status === undefined) return undefined
    const tier = await env.view.select({ title: "Tier", options: tierMenuOptions(status) })
    if (tier === undefined) return undefined
    const choice = await env.view.select({
      title: `Tier: ${tier}`,
      options: tierEditorOptions(settings, tier, status),
    })
    if (choice === undefined || choice.kind === "back") continue
    if (choice.kind === "add") {
      const next = await runAddModel(env, settings, tier, feedback)
      if (next !== undefined) settings = next
      continue
    }
    const next = await runResourceMenu(env, settings, tier, choice.index, feedback)
    if (next !== undefined) settings = next
  }
}

async function runAddModel(
  env: AdaptiveEnv,
  settings: SettingsV1,
  tier: TierName,
  feedback: SaveFeedback,
): Promise<SettingsV1 | undefined> {
  const models = env.models()
  const pick = await env.view.select({
    title: "Add model",
    placeholder: "Search provider / model / name",
    options: modelPickerOptions(models, ""),
    search: (query) => modelPickerOptions(models, query),
  })
  if (pick === undefined) return undefined
  const info = models.find((m) => m.providerID === pick.providerID && m.modelID === pick.modelID)
  const variants = info?.variants ?? []
  let variant: string | undefined
  if (variants.length > 0) {
    const choice = await env.view.select({
      title: `Variant: ${pick.providerID}/${pick.modelID}`,
      options: variantOptions(variants),
    })
    if (choice === undefined) return undefined
    variant = choice.variant
  }
  const ref: ModelRef =
    variant === undefined
      ? { providerID: pick.providerID, id: pick.modelID }
      : { providerID: pick.providerID, id: pick.modelID, variant }
  const list = [...settings.tiers[tier], ref]
  return applySettings(env, { tiers: { ...settings.tiers, [tier]: list } }, feedback)
}

type ResourceMenuChoice = "top" | "up" | "down" | "remove"

function resourceMenuOptions(): SelectOption<ResourceMenuChoice>[] {
  return [
    { title: "Move to top", value: "top", description: "Make this the primary resource" },
    { title: "Move up", value: "up", description: "Higher priority within the tier" },
    { title: "Move down", value: "down", description: "Lower priority within the tier" },
    { title: "Remove", value: "remove" },
  ]
}

async function runResourceMenu(
  env: AdaptiveEnv,
  settings: SettingsV1,
  tier: TierName,
  index: number,
  feedback: SaveFeedback,
): Promise<SettingsV1 | undefined> {
  const ref = settings.tiers[tier][index]
  if (ref === undefined) return undefined
  const pick = await env.view.select({
    title: `Resource: ${resourceLabel(ref)}`,
    options: resourceMenuOptions(),
  })
  if (pick === undefined) return undefined
  if (pick === "remove") {
    const confirmed = await env.view.confirm({
      title: "Remove resource",
      message: `Remove ${resourceLabel(ref)} from ${tier}?`,
    })
    if (confirmed !== true) return undefined
    return applySettings(
      env,
      { tiers: { ...settings.tiers, [tier]: removeResource(settings.tiers[tier], index) } },
      feedback,
    )
  }
  const list =
    pick === "top"
      ? moveResourceToTop(settings.tiers[tier], index)
      : moveResource(settings.tiers[tier], index, pick === "up" ? -1 : 1)
  return applySettings(env, { tiers: { ...settings.tiers, [tier]: list } }, feedback)
}

type PinChoice = { kind: "clear" } | { kind: "pin"; ref: ModelRef }

function pinOptions(settings: SettingsV1): SelectOption<PinChoice>[] {
  const options: SelectOption<PinChoice>[] = [
    { title: "No pin", value: { kind: "clear" }, description: "clear the pin" },
  ]
  for (const tier of TIERS) {
    for (const ref of settings.tiers[tier]) {
      options.push({
        title: `${resourceLabel(ref)} (${tier})`,
        description: "always route to this resource when it's available",
        value: { kind: "pin", ref },
      })
    }
  }
  return options
}

async function runPinMenu(
  env: AdaptiveEnv,
  settings: SettingsV1,
  feedback: SaveFeedback,
): Promise<SettingsV1 | undefined> {
  const configured = TIERS.some((tier) => settings.tiers[tier].length > 0)
  if (!configured) {
    await env.view.alert({ title: "Pin", message: "(no configured resources to pin)" })
    return undefined
  }
  const pick = await env.view.select({ title: "Pin", options: pinOptions(settings) })
  if (pick === undefined) return undefined
  return applySettings(env, { pin: pick.kind === "clear" ? null : pick.ref }, feedback)
}

/** Does this receipt describe a decision about `ref`? */
function receiptMatches(receipt: Receipt, ref: ModelRef): boolean {
  const decision = receipt.decision
  if (decision.kind === "apply") return sameModelRef(decision.model, ref)
  if (decision.kind === "escalate") return sameModelRef(decision.target, ref)
  if (decision.kind === "observe-only")
    return receiptMatches({ ...receipt, decision: decision.would }, ref)
  return false
}

async function runReceiptsView(env: AdaptiveEnv, filter?: ModelRef): Promise<void> {
  const all = await tryApi(env, () => env.api.receipts())
  if (all === undefined) return
  const list = filter === undefined ? all : all.filter((receipt) => receiptMatches(receipt, filter))
  if (list.length === 0) {
    await env.view.alert({
      title: "Receipts",
      message:
        filter === undefined
          ? "No decisions recorded yet."
          : `No decisions recorded for ${resourceLabel(filter)}.`,
    })
    return
  }
  // Paginated browse: every page is a bounded view, and "Next page" reaches
  // the rest of the list the title count promises. Viewing a detail returns
  // to the same page; Escape (undefined pick) leaves the browser.
  for (let offset = 0; ;) {
    const page = receiptPage(list.slice(offset))
    const hasNext = offset + RECEIPTS_PAGE_SIZE < list.length
    const options: SelectOption<Receipt | "next">[] = page.map((receipt) => ({
      title: receiptLine(receipt),
      value: receipt,
    }))
    if (hasNext) options.push({ title: "Next page", value: "next" })
    const pick = await env.view.select({
      title: `Receipts (${String(list.length)}, newest first)`,
      options,
    })
    if (pick === undefined) return
    if (pick === "next") {
      offset += RECEIPTS_PAGE_SIZE
      continue
    }
    await env.view.alert({ title: `Receipt #${String(pick.id)}`, message: receiptDetail(pick) })
  }
}

/** Exported for tests: the receipts page size used by the receipts browser. */
export { RECEIPTS_PAGE_SIZE }

export type {
  MainMenuChoice,
  OperatingMode,
  StatusSnapshot,
  SettingsV1,
  SettingsPatch,
  PatchResult,
  Receipt,
}
