/**
 * Resource key helpers: scope derivation and canonical identity.
 */
import type { ResourceKey, ResourceScope } from "./types.js"

/** The scope a key is attributed at: the most specific present field. */
export function resourceScope(key: ResourceKey): ResourceScope {
  if (key.variantID !== undefined) {
    return "variant"
  }
  if (key.modelID !== undefined) {
    return "model"
  }
  if (key.accountID !== undefined) {
    return "account"
  }
  return "provider"
}

/** Canonical string identity for map keys and receipts. */
export function resourceKeyID(key: ResourceKey): string {
  return JSON.stringify([
    key.providerID,
    key.accountID ?? null,
    key.modelID ?? null,
    key.variantID ?? null,
  ])
}

/**
 * The chain of scopes implied by `key`, ordered widest → narrowest. Each level
 * keeps the narrower fields that are present, so a key without an account
 * (OpenCode model references carry only provider and model) still yields a
 * model-level entry. Health assessment walks this chain because a blocked
 * ancestor blocks every descendant (e.g. a provider-wide rate limit skips all
 * of its models). A variant field without a model field is degenerate and
 * contributes no level of its own.
 */
export function resourceChain(key: ResourceKey): ResourceKey[] {
  const chain: ResourceKey[] = [{ providerID: key.providerID }]
  if (key.accountID !== undefined) {
    chain.push({ providerID: key.providerID, accountID: key.accountID })
  }
  if (key.modelID !== undefined) {
    chain.push(
      key.accountID === undefined
        ? { providerID: key.providerID, modelID: key.modelID }
        : { providerID: key.providerID, accountID: key.accountID, modelID: key.modelID },
    )
  }
  if (key.modelID !== undefined && key.variantID !== undefined) {
    chain.push(
      key.accountID === undefined
        ? { providerID: key.providerID, modelID: key.modelID, variantID: key.variantID }
        : {
            providerID: key.providerID,
            accountID: key.accountID,
            modelID: key.modelID,
            variantID: key.variantID,
          },
    )
  }
  return chain
}
