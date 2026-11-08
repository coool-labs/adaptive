/**
 * Resource health registry (ADP-007, ADP-019, ADP-021).
 *
 * Stateful façade over the pure transition layer: one record per resource
 * key, an injected clock, and assessment that composes the record's chain of
 * ancestor scopes. Time only advances through the injected clock — there are
 * no timers; windows and breaker backoffs are evaluated (swept) lazily on
 * every observation, assessment, and snapshot.
 *
 * The single-probe guarantee (ADP-019) lives here: `assess` synchronously
 * flips a due open breaker to half-open and issues the probe ticket, so
 * concurrent assessors can never observe two admissions.
 */
import {
  admitProbe,
  breakerBlockWait,
  expireProbe,
  recordProbeFailure,
  recordProbeSuccess,
  releaseProbe,
} from "../circuit-breaker/breaker.js"
import { resourceChain, resourceKeyID } from "./key.js"
import { applyHealthEvent, initialRecord, sweepRecord } from "./transitions.js"
import {
  DEFAULT_HEALTH_CONFIG,
  type Assessment,
  type Clock,
  type HealthEvent,
  type ProbeOutcome,
  type ProbeTicket,
  type ResourceHealthConfig,
  type ResourceKey,
  type ResourceRecord,
} from "./types.js"

/**
 * Severity of the three hard resource states. Used only to choose which
 * blocker a report names when several scopes in a chain are blocked at once;
 * every candidate still blocks regardless of which wins the report.
 */
const HARD_BLOCK_SEVERITY = {
  unavailable: 3,
  "quota-exhausted": 2,
  "rate-limited": 1,
} as const

type HardBlockReason = keyof typeof HARD_BLOCK_SEVERITY

interface HardBlock {
  readonly reason: HardBlockReason
  readonly key: ResourceKey
  readonly retryAtMs: number | undefined
  readonly severity: number
}

function blocked(
  reason: HardBlockReason,
  key: ResourceKey,
  retryAtMs: number | undefined,
): Assessment
function blocked(reason: "breaker-open", key: ResourceKey, retryAtMs: number): Assessment
function blocked(
  reason: "probe-in-flight" | "draining",
  key: ResourceKey,
  retryAtMs: undefined,
): Assessment
function blocked(
  reason: HardBlockReason | "breaker-open" | "probe-in-flight" | "draining",
  key: ResourceKey,
  retryAtMs: number | undefined,
): Assessment {
  if (retryAtMs === undefined) {
    return { kind: "blocked", reason, key }
  }
  return { kind: "blocked", reason, key, retryAtMs }
}

function hardBlocker(record: ResourceRecord, now: number): HardBlock | undefined {
  const retryAtMs = record.window === undefined ? undefined : record.window.until - now
  switch (record.health) {
    case "unavailable":
      return {
        reason: "unavailable",
        key: record.key,
        retryAtMs: undefined,
        severity: HARD_BLOCK_SEVERITY.unavailable,
      }
    case "quota_exhausted":
      return {
        reason: "quota-exhausted",
        key: record.key,
        retryAtMs,
        severity: HARD_BLOCK_SEVERITY["quota-exhausted"],
      }
    case "rate_limited":
      return {
        reason: "rate-limited",
        key: record.key,
        retryAtMs,
        severity: HARD_BLOCK_SEVERITY["rate-limited"],
      }
    default:
      return undefined
  }
}

/** Most severe hard block across a chain; narrowest scope wins ties. */
function hardest(
  records: readonly (ResourceRecord | undefined)[],
  now: number,
): HardBlock | undefined {
  let hard: HardBlock | undefined
  for (const record of records) {
    if (record === undefined) {
      continue
    }
    const candidate = hardBlocker(record, now)
    if (candidate === undefined) {
      continue
    }
    if (hard === undefined || candidate.severity >= hard.severity) {
      hard = candidate
    }
  }
  return hard
}

export class ResourceHealthRegistry {
  readonly #records = new Map<string, ResourceRecord>()
  readonly #clock: Clock
  readonly #config: ResourceHealthConfig
  readonly #newProbeId: () => string

  /**
   * `newProbeId` must be unique across every instance that shares records
   * (see `restore`); a per-instance counter suffices for a single owner.
   */
  constructor(
    clock: Clock,
    config: ResourceHealthConfig = DEFAULT_HEALTH_CONFIG,
    newProbeId?: () => string,
  ) {
    this.#clock = clock
    this.#config = config
    let counter = 0
    this.#newProbeId =
      newProbeId ??
      (() => {
        counter += 1
        return String(counter)
      })
  }

  /**
   * Replaces the registry's view with records another live instance shares
   * (one process per host session, all reading one locked file). Unlike
   * `hydrate`, an in-flight probe is kept: its owner is alive and will report
   * the outcome, and a lost owner is still bounded by the probe timeout.
   */
  restore(records: readonly ResourceRecord[]): void {
    const now = this.#clock()
    this.#records.clear()
    for (const record of records) {
      this.#records.set(resourceKeyID(record.key), sweepRecord(record, now))
    }
  }

  /**
   * Seeds the registry from persisted records (restart / cross-instance
   * reload). Records are swept against the current clock and inserted
   * without persisting — hydration must not write back what it just read.
   * A hydrated half_open record cannot keep its probe (the ticket lived in
   * the previous instance's memory), so it re-opens due immediately — its
   * backoff window had already elapsed when it went half-open, and the next
   * assessment admits exactly one probe as usual.
   */
  hydrate(records: readonly ResourceRecord[]): void {
    const now = this.#clock()
    for (const record of records) {
      const swept = sweepRecord(record, now)
      const breaker =
        swept.breaker.state === "half_open"
          ? {
              state: "open" as const,
              failures: swept.breaker.failures,
              openCount: swept.breaker.openCount,
              reopenAt: now,
            }
          : swept.breaker
      this.#records.set(resourceKeyID(swept.key), { ...swept, breaker, updatedAt: now })
    }
  }

  observe(event: HealthEvent): ResourceRecord {
    const now = this.#clock()
    const id = resourceKeyID(event.key)
    const existing = this.#records.get(id)
    const swept =
      existing === undefined ? initialRecord(event.key, now) : sweepRecord(existing, now)
    const updated = applyHealthEvent(swept, event, now, this.#config)
    this.#records.set(id, updated)
    return updated
  }

  #sweptRecord(key: ResourceKey, now: number): ResourceRecord | undefined {
    const id = resourceKeyID(key)
    const record = this.#records.get(id)
    if (record === undefined) {
      return undefined
    }
    const swept = sweepRecord(record, now)
    if (swept !== record) {
      this.#records.set(id, swept)
    }
    return swept
  }

  /**
   * Assesses whether the resource may take new work right now, composing the
   * full ancestor chain. Precedence: the most severe hard resource state
   * wins (narrowest scope on ties), then the breaker scan (widest scope
   * first — a due wide breaker is probed before a narrow one), then draining,
   * then available.
   */
  assess(key: ResourceKey): Assessment {
    const now = this.#clock()
    const records = resourceChain(key).map((chainKey) => this.#sweptRecord(chainKey, now))

    const hard = hardest(records, now)
    if (hard !== undefined) {
      return blocked(hard.reason, hard.key, hard.retryAtMs)
    }

    for (const record of records) {
      if (record === undefined) {
        continue
      }
      // A probe whose outcome report never arrived must not wedge the
      // resource in half_open: expire it (same backoff window, no doubling)
      // before attempting admission.
      const expired = expireProbe(record.breaker, now, this.#config.breaker)
      const current =
        expired === record.breaker ? record : { ...record, breaker: expired, updatedAt: now }
      if (current !== record) {
        this.#records.set(resourceKeyID(record.key), current)
      }
      const admission = admitProbe(current.breaker, now)
      if (admission.kind === "closed") {
        continue
      }
      if (admission.kind === "waiting") {
        return blocked("breaker-open", record.key, admission.retryAtMs)
      }
      if (admission.kind === "in-flight") {
        return blocked("probe-in-flight", record.key, undefined)
      }
      const probeId = this.#newProbeId()
      this.#records.set(resourceKeyID(record.key), {
        ...record,
        breaker: { ...admission.record, probeId, probeAt: now },
        updatedAt: now,
      })
      return { kind: "probe", ticket: { id: probeId, key: record.key } }
    }

    // Draining is the softest blocker; report the narrowest draining scope.
    let draining: ResourceRecord | undefined
    for (const record of records) {
      if (record?.health === "draining") {
        draining = record
      }
    }
    if (draining !== undefined) {
      return blocked("draining", draining.key, undefined)
    }

    return { kind: "available" }
  }

  /**
   * Non-mutating assessment for decisions that must not admit a probe
   * (escalation-target gating): identical hard-state and draining walk, but
   * an open or half-open breaker blocks without being flipped or ticketed.
   */
  evaluate(key: ResourceKey): Assessment {
    const now = this.#clock()
    const records = resourceChain(key).map((chainKey) => this.#sweptRecord(chainKey, now))
    const hard = hardest(records, now)
    if (hard !== undefined) {
      return blocked(hard.reason, hard.key, hard.retryAtMs)
    }
    for (const record of records) {
      if (record === undefined) continue
      // Observer view (non-mutating): an open breaker blocks even when its
      // backoff elapsed — assess is what flips it to half_open and issues
      // the probe ticket.
      const wait = breakerBlockWait(record.breaker, now)
      if (wait !== undefined) {
        return blocked("breaker-open", record.key, wait)
      }
      if (record.breaker.state === "half_open") {
        return blocked("probe-in-flight", record.key, undefined)
      }
    }
    let draining: ResourceRecord | undefined
    for (const record of records) {
      if (record?.health === "draining") {
        draining = record
      }
    }
    if (draining !== undefined) {
      return blocked("draining", draining.key, undefined)
    }
    return { kind: "available" }
  }

  /**
   * Reports the outcome of an admitted probe. Only the ticket issued for the
   * current half-open record is honored; stale tickets (probe already
   * resolved, record reset, or unknown key) are rejected.
   */
  reportProbe(ticket: ProbeTicket, outcome: ProbeOutcome): boolean {
    const now = this.#clock()
    const id = resourceKeyID(ticket.key)
    const record = this.#records.get(id)
    if (record === undefined) {
      return false
    }
    const breaker = record.breaker
    if (breaker.state !== "half_open" || breaker.probeId !== ticket.id) {
      return false
    }
    const next = outcome.success
      ? recordProbeSuccess(breaker)
      : recordProbeFailure(breaker, outcome.category, now, this.#config.breaker)
    this.#records.set(id, { ...record, breaker: next, updatedAt: now })
    return true
  }

  /**
   * Returns an admitted-but-never-dispatched probe ticket: the breaker
   * reopens still due, so the next admission can issue a fresh probe. Same
   * stale-ticket rule as `reportProbe`.
   */
  releaseProbe(ticket: ProbeTicket): boolean {
    const id = resourceKeyID(ticket.key)
    const record = this.#records.get(id)
    if (record?.breaker.state !== "half_open" || record.breaker.probeId !== ticket.id) {
      return false
    }
    this.#records.set(id, {
      ...record,
      breaker: releaseProbe(record.breaker),
      updatedAt: this.#clock(),
    })
    return true
  }

  /** Current (swept) record for one key, if the registry tracks it. */
  recordFor(key: ResourceKey): ResourceRecord | undefined {
    return this.#sweptRecord(key, this.#clock())
  }

  /** All tracked records, swept against the clock. */
  snapshot(): ResourceRecord[] {
    const now = this.#clock()
    return [...this.#records.values()].map((record) => sweepRecord(record, now))
  }
}
