/**
 * Tier-policy types (ADP-002..006). Tier names are an ecosystem proposal —
 * OpenCode has no native capability-tier API — so every tier semantic lives
 * in this module and nowhere else.
 */
import type { ModelRef } from "../work-unit/types.js"

export const TIERS = ["quick", "standard", "advanced"] as const satisfies readonly string[]

export type TierName = (typeof TIERS)[number]

/**
 * Request kinds the OpenCode `context` hook exposes for the executing
 * request. Auxiliary kinds are trivial host-internal requests (title,
 * compaction, generate) that must not consume an unnecessarily expensive
 * tier — this is structured host evidence, not prompt keyword matching
 * (ADP-004).
 */
export const AUXILIARY_KINDS = [
  "compaction",
  "title",
  "generate",
] as const satisfies readonly string[]

export type AuxiliaryKind = (typeof AUXILIARY_KINDS)[number]

export type RequestKind = "primary" | AuxiliaryKind

/** Auxiliary requests route to `quick`. */
export const AUXILIARY_TIER: TierName = "quick"

/** Unambiguous fallback tier (ADP-002). */
export const DEFAULT_TIER: TierName = "standard"

/** How an explicit tier request reached the plugin (provenance for receipts). */
export const TIER_REQUEST_VIAS = [
  "manual-command",
  "session-setting",
] as const satisfies readonly string[]

export type TierRequestVia = (typeof TIER_REQUEST_VIAS)[number]

export interface TierRequest {
  readonly tier: TierName
  readonly via: TierRequestVia
}

/**
 * Everything the ladder may look at, all optional except the configuration
 * view. Every signal is a structured field supplied by the adapter — never
 * text mined from a prompt.
 */
export interface RoutingInput {
  /** Explicit user/model pin (manual control); always wins (ADP-002). */
  readonly pin?: ModelRef | undefined
  /** Explicit tier request (manual command or session setting). */
  readonly tierRequest?: TierRequest | undefined
  /** OpenCode agent name of the executing request, when the host supplies one. */
  readonly agent?: string | undefined
  /** Request kind from the `context` hook, when known. */
  readonly requestKind?: RequestKind | undefined
  /** User-configured agent-name → tier mapping (role hints are user policy). */
  readonly agentTiers?: Readonly<Record<string, TierName>> | undefined
  /**
   * Tiers that currently have at least one configured resource (ADP-005).
   * A tier without resources can never be honored — Adaptive does not
   * invent resources and never borrows across tiers (GOAL tenet 4).
   */
  readonly configuredTiers: readonly TierName[]
}

/** Why the ladder produced a tier decision (receipt provenance). */
export const ROUTING_SOURCES = [
  "pin",
  "tier-request",
  "agent-role",
  "auxiliary-request",
  "ambiguity",
  "default",
] as const satisfies readonly string[]

export type RoutingSource = (typeof ROUTING_SOURCES)[number]

export const DEFER_REASONS = ["tier-not-configured"] as const satisfies readonly string[]

export type DeferReason = (typeof DEFER_REASONS)[number]

/**
 * Routing outcome (ADP-002/003):
 * - `pin` — route to the pinned resource.
 * - `tier` — route within the named tier.
 * - `defer` — Adaptive has no reason to override ordinary OpenCode behavior;
 *   the unit keeps OpenCode's model choice. `tier` records which tier the
 *   ladder resolved to before the configuration gate blocked it.
 */
export type RoutingDecision =
  | { readonly kind: "pin"; readonly model: ModelRef }
  | { readonly kind: "tier"; readonly tier: TierName; readonly source: RoutingSource }
  | { readonly kind: "defer"; readonly tier: TierName; readonly reason: DeferReason }

/** True only for the trivial auxiliary request kinds. */
export function isAuxiliary(kind: RequestKind): boolean {
  return kind !== "primary"
}

/**
 * Escalation ladder order (GOAL capability escalation): `quick` → `standard`
 * → `advanced`. `advanced` is the last tier — there is no next.
 */
export function nextTier(tier: TierName): TierName | undefined {
  const index = TIERS.indexOf(tier)
  return TIERS[index + 1]
}
