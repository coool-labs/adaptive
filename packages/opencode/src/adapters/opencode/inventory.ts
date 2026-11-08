/**
 * Model inventory mapping (ADP-005/ADP-006/ADP-017). Host `Model.Info` records
 * become supervisor `CandidateModel` views for the compatibility gate.
 *
 * `providerEnabled: true` is honest for `editor.list()` output: the verified
 * host contract is that `list()` returns candidates "from available providers"
 * (including models disabled by earlier transforms — the per-model `enabled`
 * flag distinguishes those). Pins are verified against the same editor via
 * `candidateFor`, which additionally checks variant existence (a variant the
 * model does not offer must not be switchable-to).
 */
import type { Model } from "@opencode/plugin"
import type { ModelDomain } from "@opencode/plugin/promise/model"
import type { CandidateModel } from "@coool/adaptive-core/routing/compatibility/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"

/** The model surface the inventory actually uses (structural — fixture-friendly). */
export type ModelSource = Pick<ModelDomain, "transform">

/** Map one host model record into a candidate view. */
export function mapModelInfo(info: Model.Info): CandidateModel {
  return {
    providerID: info.providerID,
    modelID: info.id,
    enabled: info.enabled,
    providerEnabled: true,
    capabilities: {
      tools: info.capabilities.tools,
      input: [...info.capabilities.input],
      output: [...info.capabilities.output],
    },
    limit: { context: info.limit.context },
  }
}

/** All inventory candidates, in host order. Each offered variant is an
 * additional explicit candidate so tier resources pinned to a variant
 * (`provider/model@variant`) are matchable by the scheduler. */
export async function listCandidates(model: ModelSource): Promise<CandidateModel[]> {
  const out: CandidateModel[] = []
  await model.transform((editor) => {
    for (const info of editor.list()) {
      out.push(mapModelInfo(info))
      for (const variant of info.variants) {
        out.push({ ...mapModelInfo(info), variant: variant.id, variantAvailable: true })
      }
    }
  })
  return out
}

/**
 * Resolve one exact resource reference (a pin) to its candidate, or `undefined`
 * when the model is not in the host inventory or the requested variant does
 * not exist. A resolved variant is reported as available so the compatibility
 * gate does not reject the very resource the user pinned.
 */
export async function candidateFor(
  model: ModelSource,
  ref: ModelRef,
): Promise<CandidateModel | undefined> {
  let found: CandidateModel | undefined
  await model.transform((editor) => {
    const info = editor.get(ref.providerID, ref.id)
    if (info === undefined) {
      return
    }
    if (ref.variant !== undefined && !info.variants.some((variant) => variant.id === ref.variant)) {
      return
    }
    const base = mapModelInfo(info)
    found =
      ref.variant !== undefined ? { ...base, variant: ref.variant, variantAvailable: true } : base
  })
  return found
}
