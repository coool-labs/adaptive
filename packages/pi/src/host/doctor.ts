import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import { resourceLabel } from "@coool/adaptive-core/flow/tiers"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ToolCapability } from "../capabilities.js"
import { VIRTUAL_IDS } from "../router.js"
import { statusChecks, type DoctorCheck } from "@coool/adaptive-core/flow/doctor"
import type { StatusSnapshot } from "@coool/adaptive-core/status"
import { versionChecks } from "../ui/doctor.js"

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
  readonly status: () => Promise<StatusSnapshot>
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
        action: "Open /adaptive tools to declare them; Adaptive never guesses from a name.",
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
    checks.push(...statusChecks(await options.status()))
  } catch {
    checks.push({
      state: "error",
      message: "Health or parked work could not be read",
      action:
        "Inspect adaptive/health.json and parked.json; do not delete them while another Pi process is running.",
    })
  }
  return checks
}
