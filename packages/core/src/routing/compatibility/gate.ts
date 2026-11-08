import type { CandidateModel, Demand, IncompatibilityReason, Verdict } from "./types.js"

/** A finite, non-negative token count is assessable; anything else is unknown demand. */
function assessableTokens(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function supportsModalities(
  supported: readonly string[] | undefined,
  demanded: readonly string[],
): boolean {
  if (supported === undefined) {
    return false
  }
  return demanded.every((modality) => supported.includes(modality))
}

/**
 * Run every check and accumulate reasons in fixed order. A candidate is
 * compatible only when no reason applies; unknown candidate metadata never
 * satisfies a stated requirement.
 */
export function checkCompatibility(candidate: CandidateModel, demand: Demand): Verdict {
  const reasons: IncompatibilityReason[] = []

  if (candidate.providerEnabled !== true) {
    reasons.push("provider-unavailable")
  }
  if (candidate.enabled !== true) {
    reasons.push("model-unavailable")
  }
  if (candidate.variant !== undefined && candidate.variantAvailable !== true) {
    reasons.push("variant-unavailable")
  }

  if (demand.tools === true && candidate.capabilities?.tools !== true) {
    reasons.push("tool-use-unsupported")
  }
  if (
    demand.input !== undefined &&
    demand.input.length > 0 &&
    !supportsModalities(candidate.capabilities?.input, demand.input)
  ) {
    reasons.push("input-modality-unsupported")
  }
  if (
    demand.output !== undefined &&
    demand.output.length > 0 &&
    !supportsModalities(candidate.capabilities?.output, demand.output)
  ) {
    reasons.push("output-modality-unsupported")
  }

  if (assessableTokens(demand.contextTokens)) {
    const contextLimit = candidate.limit?.context
    if (!assessableTokens(contextLimit)) {
      reasons.push("context-capacity-unknown")
    } else if (contextLimit < demand.contextTokens) {
      reasons.push("context-capacity-insufficient")
    }
  }

  return { compatible: reasons.length === 0, reasons }
}
