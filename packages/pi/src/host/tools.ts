// covers: ["ADP-015", "ADP-055"]
import {
  ESCALATION_TOOL_NAME,
  MAX_ESCALATIONS_PER_TASK,
  parseEscalationRequest,
} from "@coool/adaptive-core/execution/escalation/index"
import { isTierName, nextTier } from "@coool/adaptive-core/routing/tier-policy/types"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { VIRTUAL_IDS, type VirtualID } from "../router.js"
import { branchState, TIER_TOOL, type BranchEntry } from "../task.js"

/** The structural subset of Pi's `ExtensionToolContext` the tools read. */
export interface ToolContext {
  readonly model: { readonly provider: string; readonly id: string } | undefined
  readonly sessionManager: { getBranch(): readonly BranchEntry[] }
}

interface ToolResult {
  readonly content: [{ readonly type: "text"; readonly text: string }]
  readonly details: Record<string, unknown>
  readonly isError?: true
}

function reply(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details }
}

function rejected(text: string): ToolResult {
  return { ...reply(text), isError: true }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

/** The Adaptive virtual entry the user selected, if any. */
export function selectedVirtual(model: ToolContext["model"]): VirtualID | undefined {
  return model?.provider === "adaptive" ? VIRTUAL_IDS.find((id) => id === model.id) : undefined
}

/**
 * Why Adaptive will not act on an agent's request in this session, or
 * `undefined` when Adaptive Auto routes it. Manual intent wins: a physical
 * model, a pinned virtual tier, or a pinned model ignore agent requests.
 */
function notRouting(settings: SettingsV1, model: ToolContext["model"]): string | undefined {
  const id = selectedVirtual(model)
  if (id === undefined) return "Adaptive is not routing this session: the user picked a model."
  if (id !== "auto") return `The user pinned Adaptive ${id}.`
  if (settings.pin !== null) return `The user pinned ${settings.pin.providerID}/${settings.pin.id}.`
  return undefined
}

export function tierTool(settings: () => Promise<SettingsV1>) {
  return {
    name: TIER_TOOL,
    label: "Adaptive tier",
    description:
      "Declare the capability tier of the task you are starting: quick (routine edits, mechanical steps), standard (the default), or advanced (multi-step design, broad refactors, hard debugging). The declaration applies from the next user prompt and stays in force for this session until you declare a different tier. Only declare when the task's tier differs from the default; never use this to work around unavailability.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["quick", "standard", "advanced"],
          description: "The tier the task needs.",
        },
      },
      required: ["tier"],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const requested = field(params, "tier")
      if (typeof requested !== "string" || !isTierName(requested))
        return rejected("adaptive_tier rejected: tier must be quick, standard, or advanced.")
      const current = await settings()
      const ignored = notRouting(current, ctx.model)
      if (ignored !== undefined) return reply(`${ignored} The tier request was not recorded.`)
      const observing =
        current.mode === "active"
          ? ""
          : ` Adaptive is in ${current.mode} mode, so it will not change models.`
      return reply(
        `Tier request recorded: ${requested}. It applies from the next user prompt.${observing}`,
        { tier: requested },
      )
    },
  }
}

export function escalationTool(settings: () => Promise<SettingsV1>) {
  return {
    name: ESCALATION_TOOL_NAME,
    label: "Adaptive escalate",
    description:
      "Request stronger model capability for the current task. Provide a short reason and the concrete evidence (what failed or was blocked). Adaptive records the request and weighs it only if this run then fails on a capability gap (for example context overflow or a content-policy rejection), within a finite budget; recording alone does not switch models. This is not a planning or task-management tool.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description: "Short reason why the current task needs stronger capability.",
        },
        evidence: {
          type: "string",
          minLength: 1,
          description: "Concrete evidence of the capability gap: what failed or was blocked.",
        },
      },
      required: ["reason", "evidence"],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const request = parseEscalationRequest(params)
      if (request === undefined)
        return rejected(
          "adaptive_escalate rejected: reason and evidence are required non-empty strings.",
        )
      const current = await settings()
      const ignored = notRouting(current, ctx.model)
      if (ignored !== undefined)
        return reply(
          `${ignored} Adaptive will not escalate; tell the user if you need a stronger model.`,
        )
      if (current.mode !== "active")
        return reply(
          `Adaptive is in ${current.mode} mode and will not escalate; tell the user if you need a stronger model.`,
        )
      const state = branchState(ctx.sessionManager.getBranch(), "auto")
      const tier = state?.tier ?? "standard"
      const used = state?.escalations ?? 0
      const next = nextTier(tier)
      const details = { reason: request.reason, evidence: request.evidence }
      if (next === undefined)
        return reply(
          `Recorded, but ${tier} is already the strongest tier; tell the user if you need a stronger model.`,
          details,
        )
      if (used >= MAX_ESCALATIONS_PER_TASK)
        return reply(
          `Recorded, but this task already used its ${String(MAX_ESCALATIONS_PER_TASK)} escalations.`,
          details,
        )
      return reply(
        `Recorded. If this run fails on a capability gap, the task continues on ${next} (${String(used)} of ${String(MAX_ESCALATIONS_PER_TASK)} escalations used).`,
        details,
      )
    },
  }
}
