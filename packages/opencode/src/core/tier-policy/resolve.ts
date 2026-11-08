/**
 * Routing priority ladder (ADP-002):
 *
 *   explicit user/model pin
 *   → explicit tier request
 *   → supported agent role hint
 *   → deterministic local request evidence (auxiliary kinds)
 *   → default `standard`
 *
 * Ambiguity within a level resolves to `standard`. An explicit signal whose
 * tier has no configured resources is NOT silently downgraded to another
 * tier (that would borrow across tiers — GOAL tenet 4): the router defers
 * instead (ADP-003), keeping OpenCode's model choice. No LLM call and no
 * keyword classifier participates (ADP-004) — every input is a structured
 * field.
 */
import {
  AUXILIARY_TIER,
  DEFAULT_TIER,
  isAuxiliary,
  type RoutingDecision,
  type RoutingInput,
  type RoutingSource,
  type TierName,
} from "./types.js"

export function resolveRouting(input: RoutingInput): RoutingDecision {
  if (input.pin !== undefined) {
    return { kind: "pin", model: input.pin }
  }

  if (input.tierRequest !== undefined) {
    return byConfiguration(input.tierRequest.tier, "tier-request", input.configuredTiers)
  }

  // Role level: an agent-name hint from user policy and deterministic
  // auxiliary-request evidence. Conflict inside the level is ambiguity
  // (ADP-002) and resolves to `standard`; agreement keeps the tier.
  const agentTier =
    input.agent !== undefined &&
    input.agent.length > 0 &&
    input.agentTiers !== undefined &&
    Object.hasOwn(input.agentTiers, input.agent)
      ? input.agentTiers[input.agent]
      : undefined
  const auxiliaryTier =
    input.requestKind !== undefined && isAuxiliary(input.requestKind) ? AUXILIARY_TIER : undefined

  if (agentTier !== undefined && auxiliaryTier !== undefined && agentTier !== auxiliaryTier) {
    return byConfiguration(DEFAULT_TIER, "ambiguity", input.configuredTiers)
  }
  if (agentTier !== undefined) {
    return byConfiguration(agentTier, "agent-role", input.configuredTiers)
  }
  if (auxiliaryTier !== undefined) {
    return byConfiguration(auxiliaryTier, "auxiliary-request", input.configuredTiers)
  }

  return byConfiguration(DEFAULT_TIER, "default", input.configuredTiers)
}

function byConfiguration(
  tier: TierName,
  source: RoutingSource,
  configuredTiers: readonly TierName[],
): RoutingDecision {
  if (!configuredTiers.includes(tier)) {
    return { kind: "defer", tier, reason: "tier-not-configured" }
  }
  return { kind: "tier", tier, source }
}
