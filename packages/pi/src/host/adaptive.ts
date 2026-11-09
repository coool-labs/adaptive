import type {
  ExtensionAPI,
  ExtensionContext,
  ModelChangeEntry,
} from "@earendil-works/pi-coding-agent"
import type { AdaptiveEnv } from "@coool/adaptive-core/flow/controller"
import { waitingLabel } from "@coool/adaptive-core/flow/waiting"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { readSharedHealth, resetResourceHealth } from "../health-actions.js"
import { effectiveMode } from "../session.js"
import { readSettings, updateSettings } from "../settings.js"
import type { JsonFile } from "../store.js"
import { PI_COPY } from "../ui/copy.js"
import { doctorLines } from "../ui/doctor.js"
import { DEFAULT_MODEL_HELP, healthAction, preferencesAction } from "./actions.js"
import { registerCommands } from "./commands.js"
import { controlApi } from "./control.js"
import { doctorChecks } from "./doctor.js"
import type { AdaptiveSources } from "./extension.js"
import { availablePhysicalModels, modelSummaries, proposalModels } from "./inventory.js"
import { editTierProposal, runOnboarding } from "./onboarding.js"
import type { parkingHandlers } from "./parking.js"
import { readParked, readStatus } from "./status.js"
import { piView } from "./view.js"

/** What only the packaged entry knows: the settings file and the Pi version. */
export interface HostSources {
  readonly settings: JsonFile
  readonly version: string
  readonly minimum: string
  readonly testedUpTo: string | undefined
}

type Host = Pick<ExtensionAPI, "registerCommand" | "registerShortcut" | "appendEntry" | "setModel">

/** The `/adaptive` command, its shortcut, and the one-time first-run offer. */
export function adaptiveSurface(
  pi: Host,
  sources: AdaptiveSources,
  host: HostSources,
  parking: Pick<ReturnType<typeof parkingHandlers>, "resume" | "cancel">,
  feedback: (ctx: ExtensionContext) => () => Promise<void>,
): { onboard(ctx: ExtensionContext): Promise<void> } {
  const select = async (ctx: ExtensionContext, ref: ModelRef): Promise<boolean> => {
    const model = ctx.modelRegistry.find(ref.providerID, ref.id)
    return model !== undefined && (await pi.setModel(model))
  }
  const environment = (ctx: ExtensionContext): Promise<AdaptiveEnv> => {
    const session = ctx.sessionManager.getSessionId()
    const refresh = async (): Promise<void> => {
      // A successful mode change may select a model and invalidate the old
      // footer binding. Rebind to the resulting model, but never a new session.
      if (ctx.sessionManager.getSessionId() === session) await feedback(ctx)()
    }
    const view = piView(ctx)
    const branch = () => ctx.sessionManager.getBranch()
    const control = controlApi({
      settings: host.settings,
      receipts: sources.receipts,
      sessionID: ctx.sessionManager.getSessionId(),
      branch,
      model: () => ctx.model,
      manualModel: () => {
        const change = branch().findLast(
          (entry): entry is ModelChangeEntry =>
            entry.type === "model_change" && entry.provider !== "adaptive",
        )
        return change === undefined
          ? undefined
          : { providerID: change.provider, id: change.modelId }
      },
      selectModel: (ref) => select(ctx, ref),
      append: (type, data) => {
        pi.appendEntry(type, data)
      },
      idle: () => ctx.isIdle(),
      status: () =>
        readStatus({
          settings: () => readSettings(host.settings),
          health: sources.health,
          capacity: sources.capacity,
          receipts: sources.receipts,
          parked: sources.parking.file,
          effectiveMode: (global) => effectiveMode(ctx.model, global, branch()),
        }),
    })
    const api = {
      ...control,
      async setSettings(patch: Parameters<typeof control.setSettings>[0]) {
        const result = await control.setSettings(patch)
        if (result.ok) await refresh()
        return result
      },
      async setSessionMode(...args: Parameters<typeof control.setSessionMode>) {
        const result = await control.setSessionMode(...args)
        if (result.ok) await refresh()
        return result
      },
    }
    const configured = async () => {
      const settings = await readSettings(host.settings)
      return TIERS.flatMap((tier) => [...settings.tiers[tier]])
    }
    return Promise.resolve({
      copy: PI_COPY,
      api,
      view,
      models: () => modelSummaries(availablePhysicalModels(ctx.modelRegistry)),
      sessionID: ctx.sessionManager.getSessionId(),
      actions: {
        health: async () => {
          await healthAction(view, await configured(), (ref) =>
            resetResourceHealth(sources.health.file, ref),
          )
        },
        parked: async () => {
          const { waiting } = await api.status()
          const now = sources.parking.clock()
          await view.alert({
            title: "Parked work",
            message:
              waiting.length === 0
                ? "No parked work."
                : [
                    ...waiting.map(
                      (entry) =>
                        `${entry.sessionID === ctx.sessionManager.getSessionId() ? "This session" : entry.sessionID} · ${entry.tier} · ${waitingLabel(entry.resumeAt, now)}`,
                    ),
                    "Use /adaptive resume or /adaptive cancel in the waiting session.",
                  ].join("\n"),
          })
        },
        doctor: async () => {
          const checks = await doctorChecks({
            version: host.version,
            minimum: host.minimum,
            testedUpTo: host.testedUpTo,
            registry: ctx.modelRegistry,
            settings: () => readSettings(host.settings),
            capabilities: sources.capabilities,
            // An update that changes nothing still takes the exclusive lock.
            storage: () => host.settings.update(() => ({ next: undefined, result: undefined })),
            health: async () =>
              (await readSharedHealth(sources.health.file)).filter(
                (record) => record.health !== "healthy",
              ).length,
            parked: async () => (await readParked(sources.parking.file)).length,
          })
          await view.table({ title: "Adaptive doctor", lines: doctorLines(checks) })
        },
        preferences: () => preferencesAction(view, sources.preferences),
        defaults: () =>
          view.alert({ title: "Use Adaptive for new sessions", message: DEFAULT_MODEL_HELP }),
      },
    })
  }
  registerCommands<ExtensionContext>(pi, {
    env: environment,
    resume: (ctx) => parking.resume(ctx),
    cancel: (ctx) => parking.cancel(ctx),
    clock: sources.health.clock,
  })
  return {
    async onboard(ctx) {
      const env = await environment(ctx)
      await runOnboarding({
        hasUI: ctx.hasUI,
        api: {
          settings: () => readSettings(host.settings),
          setSettings: (patch) => updateSettings(host.settings, patch),
        },
        view: env.view,
        models: () => proposalModels(availablePhysicalModels(ctx.modelRegistry)),
        edit: (draft) => editTierProposal(env, draft),
        activate: () => select(ctx, { providerID: "adaptive", id: "auto" }),
      })
    },
  }
}
