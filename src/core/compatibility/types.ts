/**
 * Compatibility gate (ADP-017): filters candidates on context capacity,
 * tool use, modalities, and model/variant/provider availability BEFORE
 * health/preference ranking. Pure — adapters map OpenCode `Model.Info` /
 * `Provider.Info` into `CandidateModel`, this module never touches
 * `@opencode/plugin` types.
 *
 * Conservative rule: metadata the gate needs but cannot see is treated as
 * NOT satisfying the requirement (e.g. unknown `enabled`, unknown tool
 * support, unknown context limit). Only demand-side quantities that are
 * themselves unknown are skipped — there is nothing to check against.
 */

/** What the executing work needs from a resource. All demand fields are optional. */
export interface Demand {
  /** The unit needs tool use. `undefined`/`false` imposes no tool requirement. */
  readonly tools?: boolean | undefined
  /** Input modalities the unit carries (e.g. `"text"`, `"image"`). */
  readonly input?: readonly string[] | undefined
  /** Output modalities the unit must produce. */
  readonly output?: readonly string[] | undefined
  /** Known or estimated context need in tokens; `undefined` skips the capacity check. */
  readonly contextTokens?: number | undefined
}

/** Adapter-normalized view of one candidate resource. */
export interface CandidateModel {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string | undefined
  /** Model is enabled in the host inventory. Unknown ⇒ conservative reject. */
  readonly enabled?: boolean | undefined
  /** Provider is available in the host inventory. Unknown ⇒ conservative reject. */
  readonly providerEnabled?: boolean | undefined
  /** The requested variant exists for this model. Unknown ⇒ conservative reject. */
  readonly variantAvailable?: boolean | undefined
  readonly capabilities?:
    | {
        readonly tools?: boolean | undefined
        readonly input?: readonly string[] | undefined
        readonly output?: readonly string[] | undefined
      }
    | undefined
  readonly limit?: { readonly context?: number | undefined } | undefined
}

/**
 * Why a candidate failed the gate, in the fixed order the checks run:
 * availability → tools → input modalities → output modalities → context.
 */
export const INCOMPATIBILITY_REASONS = [
  "provider-unavailable",
  "model-unavailable",
  "variant-unavailable",
  "tool-use-unsupported",
  "input-modality-unsupported",
  "output-modality-unsupported",
  "context-capacity-insufficient",
  "context-capacity-unknown",
] as const satisfies readonly string[]

export type IncompatibilityReason = (typeof INCOMPATIBILITY_REASONS)[number]

export interface Verdict {
  readonly compatible: boolean
  readonly reasons: readonly IncompatibilityReason[]
}
