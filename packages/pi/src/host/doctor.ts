import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ToolCapability } from "../capabilities.js"
import { VIRTUAL_IDS } from "../router.js"
import { versionChecks, type DoctorCheck } from "../ui/doctor.js"

export interface DoctorOptions {
  readonly version: string
  readonly minimum: string
  readonly testedUpTo: string | undefined
  readonly registry: Pick<
    ModelRegistry,
    "getAll" | "find" | "hasConfiguredAuth" | "getRegisteredProviderConfig"
  >
  readonly settings: () => Promise<SettingsV1>
  readonly capabilities: () => Promise<readonly ToolCapability[]>
  readonly storage: () => Promise<void>
  readonly health: () => Promise<number>
  readonly parked: () => Promise<number>
}

/** Probe failures use fixed copy: upstream errors/configs may contain credentials. */
export async function doctorChecks(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks = versionChecks(options.version, options.minimum, options.testedUpTo)
  const missing = VIRTUAL_IDS.filter((id) => options.registry.find("adaptive", id) === undefined)
  checks.push(
    missing.length === 0
      ? { state: "ok", message: "All four Adaptive models registered" }
      : {
          state: "error",
          message: `Missing Adaptive models: ${missing.join(", ")}`,
          action: "Reload Pi with the Adaptive extension enabled.",
        },
  )
  try {
    const settings = await options.settings()
    const capabilities = await options.capabilities()
    const credentialed: string[] = []
    const undeclared = new Set<string>()
    for (const tier of TIERS) {
      if (settings.tiers[tier].length === 0)
        checks.push({
          state: "warning",
          message: `${tier}: no configured models`,
          action: "Open /adaptive tiers to add a model.",
        })
      for (const ref of settings.tiers[tier]) {
        const model = options.registry.find(ref.providerID, ref.id)
        if (model === undefined)
          checks.push({
            state: "error",
            message: `${resourceLabel(ref)} (${tier}): model missing`,
            action: "Refresh Pi's model catalog or remove this tier entry.",
          })
        else if (!options.registry.hasConfiguredAuth(model))
          checks.push({
            state: "error",
            message: `${resourceLabel(ref)} (${tier}): no credentials configured`,
            action: `Run /login ${ref.providerID}, or remove it from the tier.`,
          })
        else credentialed.push(resourceLabel(ref))
        if (
          !capabilities.some(
            (entry) => entry.providerID === ref.providerID && entry.id === ref.id && entry.tools,
          )
        )
          undeclared.add(resourceLabel(ref))
      }
    }
    if (credentialed.length > 0)
      checks.push({
        state: "ok",
        message: `Credentials configured for ${String(credentialed.length)} tier ${credentialed.length === 1 ? "model" : "models"}`,
      })
    if (undeclared.size > 0)
      checks.push({
        state: "warning",
        message: `Tool support not declared: ${[...undeclared].join(", ")}`,
        action: "List them in adaptive/capabilities.json; Adaptive never guesses from a name.",
      })
  } catch {
    checks.push({
      state: "error",
      message: "Settings or capabilities could not be read",
      action:
        "Inspect adaptive/settings.json and capabilities.json; corrupt files were not replaced.",
    })
  }
  try {
    await options.storage()
    checks.push({ state: "ok", message: "Shared storage writable; exclusive lock works" })
  } catch {
    checks.push({
      state: "error",
      message: "Shared storage or lock unavailable",
      action: "Check permissions and other Pi processes in the agent's adaptive directory.",
    })
  }
  const models = options.registry.getAll()
  const virtuals = models.filter(
    (model) => model.api === "pi-virtual" && model.provider !== "adaptive",
  )
  for (const model of virtuals)
    checks.push({
      state: "warning",
      message: `Other router model: ${model.provider}/${model.id}`,
      action: "Use one router for a session; do not put another virtual model in Adaptive tiers.",
    })
  for (const provider of new Set(models.map((model) => model.provider))) {
    if (provider === "adaptive") continue
    if (options.registry.getRegisteredProviderConfig(provider)?.streamSimple !== undefined)
      checks.push({
        state: "warning",
        message: `Custom request handler: ${provider}`,
        action:
          "If this handler routes requests too, use one router. No conflict is assumed from a handler alone.",
      })
  }
  try {
    const limited = await options.health()
    checks.push({
      state: "ok",
      message:
        limited === 0
          ? "Health: no resources limited"
          : `Health: ${String(limited)} ${limited === 1 ? "resource" : "resources"} limited`,
      ...(limited === 0
        ? {}
        : { action: "Inspect /adaptive health; reset only after checking the provider." }),
    })
  } catch {
    checks.push({
      state: "error",
      message: "Shared health could not be read",
      action: "Inspect adaptive/health.json; do not delete it while another Pi process is running.",
    })
  }
  try {
    const parked = await options.parked()
    checks.push({
      state: "ok",
      message:
        parked === 0
          ? "No parked work"
          : `${String(parked)} parked ${parked === 1 ? "task" : "tasks"}`,
      ...(parked === 0
        ? {}
        : { action: "Use /adaptive resume or /adaptive cancel in the waiting session." }),
    })
  } catch {
    checks.push({
      state: "error",
      message: "Parked work could not be read",
      action: "Inspect adaptive/parked.json before resuming; no task was dispatched.",
    })
  }
  return checks
}
