// covers: ["ADP-009", "ADP-010", "ADP-011", "ADP-059"]
/**
 * Resource health shared by every Pi process on this machine. Each
 * transaction restores the registry from the health file under its lock,
 * lets the caller assess or observe, and writes the swept snapshot back — so
 * one process's 429 steers the next admission in another, and a half-open
 * breaker admits one probe across all of them (ADP-059). No Pi imports.
 */
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
import type { FailureClassification } from "@coool/adaptive-core/health/classifier/types"
import {
  DEFAULT_HEALTH_CONFIG,
  failureEvent,
  ResourceHealthRegistry,
} from "@coool/adaptive-core/health/index"
import type {
  Assessment,
  ProbeTicket,
  ResourceKey,
} from "@coool/adaptive-core/health/resource-health/types"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import { parseHealthPayload } from "@coool/adaptive-core/state/health/parse"
import { retainedHealthRecords } from "@coool/adaptive-core/state/health/store"
import { HEALTH_VERSION } from "@coool/adaptive-core/state/health/types"
import { failureEvidence, type FailedMessage } from "./evidence.js"
import type { JsonFile } from "./store.js"

export interface SharedHealth {
  readonly file: JsonFile
  readonly clock: () => number
  /** Probe ids must be unique across every process sharing the file. */
  readonly newId: () => string
}

/** Run `change` against the shared registry and persist what it leaves behind. */
export function withHealth<R>(
  shared: SharedHealth,
  change: (registry: ResourceHealthRegistry) => R,
): Promise<R> {
  return shared.file.update((current) => {
    const registry = new ResourceHealthRegistry(shared.clock, DEFAULT_HEALTH_CONFIG, shared.newId)
    registry.restore(parseHealthPayload(current))
    const result = change(registry)
    return {
      next: { version: HEALTH_VERSION, records: retainedHealthRecords(registry.snapshot()) },
      result,
    }
  })
}

function keyOf(ref: ModelRef): ResourceKey {
  return { providerID: ref.providerID, modelID: ref.id }
}

/**
 * Assess the candidates of one admission. Assessing a due open breaker issues
 * a probe ticket; every ticket the admission does not dispatch must be
 * handed back with `releaseUnselected`, or the probe stays in flight until it
 * times out.
 */
export function assessCandidates(
  registry: ResourceHealthRegistry,
  candidates: readonly ModelRef[],
): { readonly health: Record<string, Assessment>; readonly tickets: readonly ProbeTicket[] } {
  const health: Record<string, Assessment> = {}
  const tickets: ProbeTicket[] = []
  for (const ref of candidates) {
    const assessment = registry.assess(keyOf(ref))
    health[schedulerHealthKey(ref)] = assessment
    if (assessment.kind === "probe") tickets.push(assessment.ticket)
  }
  return { health, tickets }
}

export function releaseUnselected(
  registry: ResourceHealthRegistry,
  tickets: readonly ProbeTicket[],
  selected: ModelRef | undefined,
): void {
  for (const ticket of tickets)
    if (ticket.key.providerID !== selected?.providerID || ticket.key.modelID !== selected.id)
      registry.releaseProbe(ticket)
}

/**
 * Record how one dispatched request ended. User cancellations are not
 * provider evidence. Only the dispatching process sees the outcome of a
 * half-open record, so a failure there is that probe's outcome; a success
 * closes the breaker from any state. Returns the failure classification of
 * an errored dispatch, for the receipt outcome.
 */
export function observeOutcome(
  registry: ResourceHealthRegistry,
  ref: ModelRef,
  message: FailedMessage,
): FailureClassification | undefined {
  const key = keyOf(ref)
  if (message.stopReason === "aborted") return undefined
  if (message.stopReason !== "error") {
    registry.observe({ kind: "success", key })
    return undefined
  }
  const classification = classifyFailure(failureEvidence(message))
  const breaker = registry.recordFor(key)?.breaker
  if (breaker?.state === "half_open" && breaker.probeId !== undefined)
    registry.reportProbe(
      { id: breaker.probeId, key },
      { success: false, category: classification.category },
    )
  registry.observe(failureEvent(key, classification))
  return classification
}
