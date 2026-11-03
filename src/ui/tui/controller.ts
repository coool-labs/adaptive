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
import type { SettingsPatch, SettingsV1 } from "../../state/settings/index.js"
import type { PatchResult } from "../../state/settings/types.js"
import type { SessionModeSetResult } from "../../state/session-modes/index.js"
import type { TierRequestSetResult } from "../../rpc/handlers.js"
import type { Receipt } from "../../state/receipts/types.js"
import type { StatusSnapshot } from "../../rpc/status.js"
import { STATUS_EMPTY_MESSAGE, statusTable } from "./status.js"
import {
  mainMenuOptions,
  modeOptions,
  modeTargetOptions,
  sessionModeOptions,
  sessionTierOptions,
  type MainMenuChoice,
} from "./menu.js"
import {
  modelPickerOptions,
  moveResource,
  moveResourceToTop,
  removeResource,
  resourceLabel,
  tierEditorOptions,
  tierMenuOptions,
  variantOptions,
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
  /** A select with footer actions (page flips): the action closes the
   * dialog and is reported separately from an option pick. */
  selectPaged<Value>(spec: {
    title: string
    options: readonly SelectOption<Value>[]
    actions: readonly { title: string; value: string; bind: string }[]
  }): Promise<{ picked: Value | undefined; action: string | undefined }>
  confirm(options: {
    title: string
    message: string
    label?: { confirm?: string; cancel?: string }
  }): Promise<boolean | undefined>
  alert(options: { title: string; message: string }): Promise<void>
  /** A column-aligned text table (header row first); Escape closes it. */
  table(spec: { title: string; lines: string[] }): Promise<void>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): void
}

export interface AdaptiveApi {
  settings: () => Promise<SettingsV1>
  setSettings: (patch: SettingsPatch) => Promise<PatchResult>
  status: () => Promise<StatusSnapshot>
  receipts: () => Promise<Receipt[]>
  /** The session's mode override (`null` = follows the global mode). */
  sessionMode: (sessionID: string) => Promise<OperatingMode | null>
  setSessionMode: (sessionID: string, mode: OperatingMode | null) => Promise<SessionModeSetResult>
  /** The session's pinned tier request (`null` = follows the routing ladder). */
  tierRequest: (sessionID: string) => Promise<TierName | null>
  setTierRequest: (sessionID: string, tier: string | null) => Promise<TierRequestSetResult>
}

export type ModelLister = () => readonly ModelSummary[]

export interface AdaptiveEnv {
  api: AdaptiveApi
  view: AdaptiveView
  models: ModelLister
  /**
   * The session the command was opened from (ADP-054). Present only when the
   * palette command ran inside a session screen — the mode menu then steers
   * that session's override instead of the global mode.
   */
  sessionID?: string | undefined
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

/**
 * Persist one session-mode override; alert on errors, toast on success. Same
 * once-toast semantics as `applySettings` — the success toast is shown only
 * on the first successful save of a dialog session.
 */
async function applySessionMode(
  env: AdaptiveEnv,
  sessionID: string,
  mode: OperatingMode | null,
  feedback: SaveFeedback,
): Promise<SessionModeSetResult | undefined> {
  const result = await tryApi(env, () => env.api.setSessionMode(sessionID, mode))
  if (result === undefined) return undefined
  if (!result.ok) {
    await env.view.alert({ title: "Invalid settings", message: result.errors.join("; ") })
    return undefined
  }
  if (!feedback.once) {
    env.view.toast("Settings saved", "success")
    feedback.once = true
  }
  return result
}

/**
 * Persist one session tier request; alert on errors, toast on success. Same
 * once-toast semantics as `applySettings` — the success toast is shown only
 * on the first successful save of a dialog session.
 */
async function applyTierRequest(
  env: AdaptiveEnv,
  sessionID: string,
  tier: string | null,
  feedback: SaveFeedback,
): Promise<TierRequestSetResult | undefined> {
  const result = await tryApi(env, () => env.api.setTierRequest(sessionID, tier))
  if (result === undefined) return undefined
  if (!result.ok) {
    await env.view.alert({ title: "Invalid tier request", message: result.errors.join("; ") })
    return undefined
  }
  if (!feedback.once) {
    env.view.toast("Settings saved", "success")
    feedback.once = true
  }
  return result
}

export async function runAdaptive(env: AdaptiveEnv): Promise<void> {
  const loaded = await tryApi(env, () => env.api.settings())
  if (loaded === undefined) return
  let settings = loaded
  const feedback: SaveFeedback = { once: false }
  const sessionID = env.sessionID
  // The session's current override: fetched once when the flow starts inside
  // a session; a failure degrades to "follow global" (the menu still works).
  let override: OperatingMode | null =
    sessionID === undefined
      ? null
      : ((await tryApi(env, () => env.api.sessionMode(sessionID))) ?? null)
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
    // Fresh status and settings on every pass: the menu rows pair the two,
    // and the server is the single source of truth (ADP-036). A failed read
    // degrades silently to the last known values — the menu descriptions
    // must not spam a toast on every loop iteration (the flows that need
    // status toast through tryApi themselves).
    const [freshSettings, status] = await Promise.all([
      env.api.settings().catch(() => undefined),
      env.api.status().catch(() => undefined),
    ])
    if (freshSettings !== undefined) settings = freshSettings
    // The session's pinned tier request: fetched per loop so the entry
    // description tracks the latest request; a failure degrades to the
    // generic description (the menu still works).
    const tierPinned =
      sessionID === undefined
        ? undefined
        : await env.api.tierRequest(sessionID).catch(() => undefined)
    const choice = await env.view.select({
      title: `Adaptive (${override ?? settings.mode})`,
      options: mainMenuOptions(settings, status, tierPinned, override ?? settings.mode),
    })
    if (choice === undefined) return
    if (choice === "status") {
      await runStatusView(env)
      continue
    }
    if (choice === "models") {
      settings = (await runTierEditor(env, feedback)) ?? settings
      continue
    }
    if (choice === "mode") {
      const next = await runModeMenu(env, settings, feedback, sessionID, override)
      if (next !== undefined) {
        settings = next.settings
        override = next.override
      }
      continue
    }
    if (choice === "tier") {
      if (sessionID === undefined) {
        // The tier request only exists inside a session; on home the pick is
        // explained (not silently dropped) and the menu re-opens.
        await env.view.alert({
          title: "This session",
          message:
            "This session's tier request can only be changed inside a session. Open a session and run /adaptive from there.",
        })
        continue
      }
      await runTierRequestMenu(env, sessionID, feedback)
      continue
    }
    if (choice === "pin") {
      settings = (await runPinMenu(env, settings, feedback)) ?? settings
      continue
    }
    await runReceiptsView(env)
  }
}

/** What one mode-menu pass changed (settings and/or the session override). */
interface ModeMenuOutcome {
  settings: SettingsV1
  override: OperatingMode | null
}

async function runModeMenu(
  env: AdaptiveEnv,
  settings: SettingsV1,
  feedback: SaveFeedback,
  sessionID: string | undefined,
  override: OperatingMode | null,
): Promise<ModeMenuOutcome | undefined> {
  // Every screen gets the same first question — which mode to steer — so a
  // user who opens the menu on home learns the two-level structure before
  // they ever run the command inside a session.
  for (;;) {
    const target = await env.view.select({
      title: "Operating mode",
      options: modeTargetOptions(settings.mode, override ?? settings.mode),
    })
    if (target === undefined) return undefined
    if (target === "global") {
      const pick = await env.view.select({
        title: "Global mode",
        options: modeOptions(settings.mode),
      })
      if (pick === undefined || pick === settings.mode) return undefined
      const applied = await applySettings(env, { mode: pick }, feedback)
      // The session override is deliberately untouched: changing the global
      // default must not rewrite what a session was pinned to.
      return applied === undefined ? undefined : { settings: applied, override }
    }
    if (sessionID === undefined) {
      // The session override only exists inside a session; on home the pick
      // is explained (not silently dropped) and the target question repeats.
      await env.view.alert({
        title: "This session",
        message:
          "This session's mode can only be changed inside a session. Open a session and run /adaptive from there.",
      })
      continue
    }
    const pick = await env.view.select({
      title: "This session's mode",
      options: sessionModeOptions({
        global: settings.mode,
        override,
        effective: override ?? settings.mode,
      }),
    })
    if (pick === undefined) return undefined
    if (pick.kind === "global") {
      if (override === null) return undefined
      const saved = await applySessionMode(env, sessionID, null, feedback)
      return saved === undefined ? undefined : { settings, override: null }
    }
    if (pick.mode === (override ?? settings.mode)) return undefined
    const saved = await applySessionMode(env, sessionID, pick.mode, feedback)
    return saved === undefined ? undefined : { settings, override: pick.mode }
  }
}

/** The per-session tier-request menu (ADP-055): pin a tier or clear it. */
async function runTierRequestMenu(
  env: AdaptiveEnv,
  sessionID: string,
  feedback: SaveFeedback,
): Promise<void> {
  const pinned = await tryApi(env, () => env.api.tierRequest(sessionID))
  if (pinned === undefined) return
  const pick = await env.view.select({
    title: "This session's tier",
    options: sessionTierOptions({ pinned }),
  })
  if (pick === undefined) return
  const next = pick.kind === "ladder" ? null : pick.tier
  if (next === pinned) return
  await applyTierRequest(env, sessionID, next, feedback)
}

/**
 * The status view: every configured model with its state as a column-aligned
 * table (header row, tier order, priority order within tiers). No
 * per-resource selection step — the table IS the view; Escape returns to the
 * menu.
 */
async function runStatusView(env: AdaptiveEnv): Promise<void> {
  const snapshot = await tryApi(env, () => env.api.status())
  if (snapshot === undefined) return
  const configured = TIERS.some((tier) => snapshot.tiers[tier].length > 0)
  if (!configured) {
    await env.view.alert({ title: "Status", message: STATUS_EMPTY_MESSAGE })
    return
  }
  await env.view.table({ title: "Status", lines: statusTable(snapshot) })
}

type TierEditorOutcome = SettingsV1 | undefined

async function runTierEditor(env: AdaptiveEnv, feedback: SaveFeedback): Promise<TierEditorOutcome> {
  // The last confirmed server snapshot from this editor session, returned
  // when the editor closes so the menu view stays in sync with the server.
  let saved: SettingsV1 | undefined
  for (;;) {
    // The server is the single source of truth (ADP-036): settings are
    // re-fetched on every editor pass — entering the editor and after each
    // save — so the rows pair fresh settings with fresh status and an edit
    // can never clobber a change made outside this dialog.
    const settings = await tryApi(env, () => env.api.settings())
    if (settings === undefined) return saved
    const status = await tryApi(env, () => env.api.status())
    if (status === undefined) return saved
    const tier = await env.view.select({ title: "Tier", options: tierMenuOptions(status) })
    if (tier === undefined) return saved
    const choice = await env.view.select({
      title: `Tier: ${tier}`,
      options: tierEditorOptions(settings, tier, status),
    })
    if (choice === undefined) continue
    if (choice.kind === "add") {
      const next = await runAddModel(env, settings, tier, feedback)
      if (next !== undefined) saved = next
      continue
    }
    const next = await runResourceMenu(env, settings, tier, choice.index, feedback)
    if (next !== undefined) saved = next
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
        description: "route every turn to this resource, even in active mode",
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

async function runReceiptsView(env: AdaptiveEnv): Promise<void> {
  const all = await tryApi(env, () => env.api.receipts())
  if (all === undefined) return
  if (all.length === 0) {
    await env.view.alert({
      title: "Receipts",
      message: "No decisions recorded yet.",
    })
    return
  }
  // Paginated browse: every page is a bounded view, and the page flips are
  // footer actions (not list items) — they close the dialog and the loop
  // reopens it at the new offset. Viewing a detail returns to the same
  // page; Escape (no pick, no action) leaves the browser.
  for (let offset = 0; ;) {
    const page = receiptPage(all.slice(offset))
    const hasNext = offset + RECEIPTS_PAGE_SIZE < all.length
    const result = await env.view.selectPaged({
      title: `Receipts (${String(all.length)}, newest first)`,
      options: page.map((receipt) => ({ title: receiptLine(receipt), value: receipt })),
      actions: [
        ...(offset > 0 ? [{ title: "Previous page", value: "prev", bind: "ctrl+b" }] : []),
        ...(hasNext ? [{ title: "Next page", value: "next", bind: "ctrl+f" }] : []),
      ],
    })
    if (result.action === "next") {
      offset += RECEIPTS_PAGE_SIZE
      continue
    }
    if (result.action === "prev") {
      offset = Math.max(0, offset - RECEIPTS_PAGE_SIZE)
      continue
    }
    const pick = result.picked
    if (pick === undefined) return
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
