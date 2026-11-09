// covers: ["ADP-032", "ADP-063"]
import {
  runAdaptive,
  type AdaptiveApi,
  type AdaptiveEnv,
  type AdaptiveView,
} from "@coool/adaptive-core/flow/controller"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import { proposeTiers, type ProposalModel } from "../ui/proposal.js"
import { migrateSettings } from "@coool/adaptive-core/state/settings/parse"
import { buildStatus } from "@coool/adaptive-core/status"

/** The shared tier editor writes a local draft; only the wizard commits it. */
export async function editTierProposal(env: AdaptiveEnv, initial: SettingsV1): Promise<SettingsV1> {
  let draft = initial
  await runAdaptive(
    {
      copy: env.copy,
      view: env.view,
      models: env.models,
      api: {
        ...env.api,
        settings: () => Promise.resolve(draft),
        setSettings: (patch) => {
          draft = migrateSettings({ ...draft, ...patch })
          return Promise.resolve({ ok: true, settings: draft })
        },
        status: () =>
          Promise.resolve(
            buildStatus({
              settings: draft,
              health: [],
              capacity: {},
              parked: 0,
              waiting: [],
              receipts: 0,
            }),
          ),
      },
    },
    "models",
  )
  return draft
}

export interface OnboardingOptions {
  readonly hasUI: boolean
  readonly api: Pick<AdaptiveApi, "settings" | "setSettings">
  readonly view: AdaptiveView
  readonly models: () => readonly ProposalModel[]
  readonly edit: (draft: SettingsV1) => Promise<SettingsV1>
  readonly activate: () => Promise<boolean>
  readonly log: (message: string) => void
}

export async function runOnboarding(options: OnboardingOptions): Promise<void> {
  const current = await options.api.settings()
  if (current.inviteDismissed) return
  if (!options.hasUI) {
    options.log(
      "Adaptive observes by default. Configure tiers with /adaptive in an interactive session.",
    )
    return
  }
  let draft = {
    ...current,
    mode: "observe" as const,
    inviteDismissed: true,
    tiers: TIERS.some((tier) => current.tiers[tier].length > 0)
      ? current.tiers
      : proposeTiers(options.models()),
  }
  for (;;) {
    const summary = TIERS.map(
      (tier) =>
        `${tier}: ${draft.tiers[tier].map(resourceLabel).join(" · ") || "no models available"}`,
    ).join("\n")
    const choice = await options.view.select({
      title: `Adaptive is installed\n${summary}\nTool support must be confirmed separately; /adaptive doctor checks it.`,
      options: [
        { title: "Save tiers and use Adaptive this session", value: "use" },
        { title: "Save tiers, keep my current model", value: "save" },
        { title: "Edit suggested tiers…", value: "edit" },
        { title: "Not now", value: "later" },
      ],
    })
    if (choice === "edit") {
      draft = { ...(await options.edit(draft)), mode: "observe", inviteDismissed: true }
      continue
    }
    if (choice !== "save" && choice !== "use") {
      await options.api.setSettings({ inviteDismissed: true })
      return
    }
    const confirmed = await options.view.confirm({
      title: "Save these tiers?",
      message: `${summary}\nGlobal mode stays Observe. Nothing changes until you confirm.`,
    })
    if (confirmed !== true) continue
    const saved = await options.api.setSettings({
      tiers: draft.tiers,
      mode: "observe",
      inviteDismissed: true,
    })
    if (!saved.ok) {
      await options.view.alert({ title: "Could not save tiers", message: saved.errors.join("; ") })
      return
    }
    options.view.toast("Tiers saved", "success")
    if (choice === "use" && !(await options.activate()))
      options.view.toast(
        "Tiers saved, but Adaptive could not be selected. Open Pi's model picker.",
        "error",
      )
    return
  }
}
