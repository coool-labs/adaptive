/**
 * Maps a classified failure onto the resource scope it actually blocks.
 */
import type { FailureClassification } from "../classifier/types.js"
import type { HealthEvent, ResourceKey } from "./types.js"

/** Quota survives variantless host resolution; only shared-limit evidence blocks siblings. */
export function failureKey(key: ResourceKey, classification: FailureClassification): ResourceKey {
  if (classification.quotaScope === "provider") {
    // Host model refs expose the configured provider, not a credential/account id.
    return { providerID: key.providerID }
  }
  if (classification.category === "quota_exhausted" && key.variantID !== undefined) {
    return { providerID: key.providerID, modelID: key.modelID }
  }
  return key
}

/** Health failure event from a classification (bounded structured evidence). */
export function failureEvent(key: ResourceKey, classification: FailureClassification): HealthEvent {
  return {
    kind: "failure",
    key: failureKey(key, classification),
    category: classification.category,
    definitive: classification.definitive,
    ...(classification.retry.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retry.retryAfterMs }
      : {}),
  }
}
