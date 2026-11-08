/**
 * Shared fixtures and fast-check arbitraries for scheduler tests. The oracle
 * helpers are written independently from the implementation so the property
 * suite can pin scheduler semantics (ADP-038).
 */
import fc from "fast-check"
import type { CandidateModel, Demand } from "../../../src/routing/compatibility/types.js"
import { BLOCKED_REASONS } from "../../../src/health/resource-health/types.js"
import type { Assessment, ResourceKey } from "../../../src/health/resource-health/types.js"
import type { CapacitySignals } from "../../../src/health/capacity/types.js"
import type { ModelRef } from "../../../src/routing/work-unit/types.js"
import type { SchedulerInput } from "../../../src/routing/scheduler/types.js"

export function ref(providerID: string, id: string, variant?: string): ModelRef {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

/** Fully available, tool-capable, text-modality, large-context candidate. */
export function candidateOf(r: ModelRef, overrides: Partial<CandidateModel> = {}): CandidateModel {
  return {
    providerID: r.providerID,
    modelID: r.id,
    variant: r.variant,
    enabled: true,
    providerEnabled: true,
    variantAvailable: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000 },
    ...overrides,
  }
}

export function inputOf(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    routing: { kind: "tier", tier: "standard", source: "default" },
    demand: {},
    inventory: [],
    tierCandidates: [],
    health: {},
    capacity: {},
    ...overrides,
  }
}

export function keyOf(r: ModelRef): ResourceKey {
  return r.variant === undefined
    ? { providerID: r.providerID, modelID: r.id }
    : { providerID: r.providerID, modelID: r.id, variantID: r.variant }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

export const modelRefArb: fc.Arbitrary<ModelRef> = fc.record({
  providerID: fc.string({ minLength: 1 }),
  id: fc.string({ minLength: 1 }),
  variant: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
})

const stringArb = fc.string({ minLength: 1 })

export const candidateArb: fc.Arbitrary<CandidateModel> = fc.record(
  {
    providerID: stringArb,
    modelID: stringArb,
    variant: fc.option(stringArb, { nil: undefined }),
    enabled: fc.option(fc.boolean(), { nil: undefined }),
    providerEnabled: fc.option(fc.boolean(), { nil: undefined }),
    variantAvailable: fc.option(fc.boolean(), { nil: undefined }),
    capabilities: fc.option(
      fc.record({
        tools: fc.option(fc.boolean(), { nil: undefined }),
        input: fc.option(fc.array(stringArb), { nil: undefined }),
        output: fc.option(fc.array(stringArb), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    limit: fc.option(
      fc.record({ context: fc.option(fc.integer({ min: 0 }), { nil: undefined }) }),
      { nil: undefined },
    ),
  },
  { requiredKeys: ["providerID", "modelID"] },
)

export const demandArb: fc.Arbitrary<Demand> = fc.record({
  tools: fc.option(fc.boolean(), { nil: undefined }),
  input: fc.option(fc.array(fc.constantFrom("text", "image", "audio", "file")), { nil: undefined }),
  output: fc.option(fc.array(fc.constantFrom("text", "image")), { nil: undefined }),
  contextTokens: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
})

export const assessmentArb: fc.Arbitrary<Assessment> = fc.oneof(
  fc.constant({ kind: "available" } as const),
  fc.record({ id: stringArb, provider: stringArb }).map(({ id, provider }): Assessment => ({
    kind: "probe",
    ticket: { id, key: { providerID: provider } },
  })),
  fc
    .record({
      reason: fc.constantFrom(...BLOCKED_REASONS),
      provider: stringArb,
      retry: fc.option(fc.integer({ min: 0, max: 86_400_000 }), { nil: undefined }),
    })
    .map(({ reason, provider, retry }): Assessment => {
      const key: ResourceKey = { providerID: provider }
      return retry === undefined
        ? { kind: "blocked", reason, key }
        : { kind: "blocked", reason, key, retryAtMs: retry }
    }),
)

export const signalsArb: fc.Arbitrary<CapacitySignals> = fc.record({
  exhausted: fc.boolean(),
  draining: fc.boolean(),
})

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

/**
 * Test-side classification of one candidate's health/capacity view, written
 * from the ADP-038 invariant text rather than from the implementation:
 * - `"ready"` — may take new work.
 * - `"probe"` — offering the single half-open probe admission.
 * - `"draining"` — a policy request to wind down; usable as last resort.
 * - `` `skip:${reason}` `` — cannot take the work.
 */
export type OracleBucket = "ready" | "probe" | "draining" | `skip:${string}`

export function oracleBucket(
  assessment: Assessment | undefined,
  signals: CapacitySignals | undefined,
): OracleBucket {
  if (signals?.exhausted === true) {
    return "skip:capacity-exhausted"
  }
  if (assessment === undefined) {
    return signals?.draining === true ? "draining" : "ready"
  }
  if (assessment.kind === "probe") {
    return "probe"
  }
  if (assessment.kind === "blocked") {
    return assessment.reason === "draining" ? "draining" : `skip:${assessment.reason}`
  }
  return signals?.draining === true ? "draining" : "ready"
}

/** One generated candidate with its health and capacity views, for properties. */
export interface GeneratedCandidate {
  readonly ref: ModelRef
  readonly candidate: CandidateModel
  readonly assessment: Assessment | undefined
  readonly signals: CapacitySignals | undefined
}

/** Candidates with random availability metadata and random health/capacity views. */
export const generatedCandidateArb: fc.Arbitrary<GeneratedCandidate> = fc
  .record({
    r: modelRefArb,
    enabled: fc.option(fc.boolean(), { nil: undefined }),
    providerEnabled: fc.option(fc.boolean(), { nil: undefined }),
    variantAvailable: fc.option(fc.boolean(), { nil: undefined }),
    tools: fc.option(fc.boolean(), { nil: undefined }),
    context: fc.option(fc.integer({ min: 0, max: 300_000 }), { nil: undefined }),
    assessment: fc.option(assessmentArb, { nil: undefined }),
    signals: fc.option(signalsArb, { nil: undefined }),
  })
  .map(
    ({ r, enabled, providerEnabled, variantAvailable, tools, context, assessment, signals }) => ({
      ref: r,
      candidate: candidateOf(r, {
        enabled,
        providerEnabled,
        variantAvailable,
        ...(tools === undefined
          ? {}
          : { capabilities: { tools, input: ["text"], output: ["text"] } }),
        ...(context === undefined ? {} : { limit: { context } }),
      }),
      assessment,
      signals,
    }),
  )

/** Ref identity string used to dedupe generated candidate pools. */
export function refIdentity(r: ModelRef): string {
  return `${r.providerID}|${r.id}|${r.variant ?? ""}`
}
