/**
 * The supervisor (ADP-025..ADP-032): owns all state stores and glues the pure
 * core to the host reports. It contains no policy of its own — every decision
 * comes from the pure scheduler/retry/tier modules — and it applies the two
 * wiring contracts: fail-open (ADP-031, internal failures log and defer) and
 * Observe ≡ Control (the same admission path, only the mode wrapper differs).
 *
 * Wiring decisions recorded here (see docs/ARCHITECTURE.md):
 * - admission runs only on `execution-started` (a safe boundary); auxiliary
 *   per-request routing is not applied in v1 because switching the model for
 *   an auxiliary request would also move the primary model.
 * - park records arise only from owned-recovery failures and resume
 *   boundaries; admission cannot hold an already-started episode, so an
 *   admission `park` decision is recorded as a receipt without a parked
 *   record (the episode proceeds on OpenCode's own model).
 * - retry-hook veto decisions are not receipts (they are not scheduler
 *   decisions); admission receipts plus outcome attachment cover ADP-030.
 * - interruption reasons outside the known vocabulary leave the unit open
 *   (a later episode supersedes it); no outcome is ever fabricated.
 * - escalation (ADP-015..017) triggers only on capability-classified unit
 *   failures (context overflow, content policy); infrastructure failures
 *   never escalate, and the per-unit budget is finite.
 */
import { WorkUnitTracker } from "../core/work-unit/tracker.js"
import {
  sameModelRef,
  type ActiveUnit,
  type ApplyResult,
  type ModelRef,
} from "../core/work-unit/types.js"
import { INTERRUPT_REASONS } from "../core/work-unit/interruption.js"
import type { InterruptReason } from "../core/work-unit/interruption.js"
import { resolveRouting } from "../core/tier-policy/resolve.js"
import { TIERS, nextTier } from "../core/tier-policy/types.js"
import type { RoutingDecision, TierName } from "../core/tier-policy/types.js"
import type { TierRequest } from "../core/tier-policy/types.js"
import {
  admit,
  forMode as schedulerForMode,
  planEscalation,
  schedulerHealthKey,
} from "../core/scheduler/index.js"
import type {
  ApplyDecision,
  EscalationEvidence,
  OperatingMode,
  SchedulerInput,
} from "../core/scheduler/types.js"
import { MAX_ESCALATION_EVIDENCE } from "../core/scheduler/types.js"
import type { CandidateModel, Demand } from "../core/compatibility/types.js"
import { checkCompatibility } from "../core/compatibility/gate.js"
import { classifyFailure, CapacityRegistry, ResourceHealthRegistry } from "../health/index.js"
import { sweepRecord } from "../health/resource-health/transitions.js"
import type { ResourceRecord } from "../health/resource-health/types.js"
import { HealthRecordStore, HEALTH_KEY } from "../state/health/index.js"
import { CapacityReadingStore, CAPACITY_KEY } from "../state/capacity/index.js"
import type { PersistedCapacityReading } from "../state/capacity/index.js"
import { mergeReadings } from "../health/capacity/merge.js"
import { resourceChain, resourceKeyID } from "../health/resource-health/key.js"
import type {
  Assessment,
  CapacityReading,
  CapacitySignals,
  FailureCategory,
  FailureClassification,
  HealthEvent,
  ProbeOutcome,
  ProbeTicket,
  ResourceKey,
} from "../health/index.js"
import { SettingsStore, SETTINGS_KEY } from "../state/settings/index.js"
import type { SettingsV1 } from "../state/settings/index.js"
import type { PatchResult, SettingsPatch } from "../state/settings/types.js"
import { SessionModeStore, SESSION_MODES_KEY } from "../state/session-modes/index.js"
import { ReceiptStore, RECEIPTS_KEY } from "../state/receipts/index.js"
import type { Receipt, ReceiptInput, ReceiptOutcome } from "../state/receipts/types.js"
import { buildStatus } from "../rpc/status.js"
import type { StatusSnapshot } from "../rpc/status.js"
import { RECEIPTS_VIEW_LIMIT } from "./view.js"
import { ParkedWorkStore, PARKED_KEY } from "../state/parked-work/index.js"
import type { ParkedRecord } from "../state/parked-work/types.js"
import {
  decideRetry,
  executeContinuation,
  forMode as retryForMode,
  planContinuation,
  selectResumable,
} from "../execution/index.js"
import { escalationDetail } from "../execution/escalation/index.js"
import type { RecoveryOption } from "../execution/index.js"
import { listCandidates, sessionOps, storageSeam } from "../adapters/opencode/index.js"
import type { EventReport } from "../adapters/opencode/index.js"
import { CodexCapacitySensor } from "../adapters/codex-capacity/index.js"
import { logFailOpen } from "./log.js"
import type { RetryHookInput, SupervisorOptions } from "./types.js"
import { CODEX_PROVIDER_ID } from "./types.js"

/** Which tiers currently have configured resources (ADP-005). */
/** Vocabulary guard without a cast: strict member equality. */
function isTierName(tier: string): tier is TierName {
  return TIERS.some((name) => name === tier)
}

function configuredTiers(settings: SettingsV1): TierName[] {
  return TIERS.filter((tier) => settings.tiers[tier].length > 0)
}

/** Narrow a wire interrupt reason to the known vocabulary. */
function interruptReason(reason: string): InterruptReason | undefined {
  return (INTERRUPT_REASONS as readonly string[]).includes(reason)
    ? (reason as InterruptReason)
    : undefined
}

/**
 * Failure categories that count as structured capability evidence (ADP-015).
 * The remaining evidence kinds (agent request, reviewer rejection) have no
 * structured host source in v2 and are never inferred from free text.
 */
const CAPABILITY_EVIDENCE_CATEGORIES: readonly FailureCategory[] = [
  "context_overflow",
  "content_policy",
]

/** Finite per-unit escalation budget (ADP-017). */
const MAX_ESCALATIONS_PER_UNIT = 2

export class Supervisor {
  readonly #options: SupervisorOptions
  readonly #settings: SettingsStore
  readonly #receipts: ReceiptStore
  readonly #parked: ParkedWorkStore
  readonly #tracker = new WorkUnitTracker()
  readonly #health: ResourceHealthRegistry
  readonly #healthRecords: HealthRecordStore
  readonly #capacityStore: CapacityReadingStore
  readonly #sessionModes: SessionModeStore
  readonly #capacity: CapacityRegistry
  readonly #codex: CodexCapacitySensor
  readonly #vetoes = new Map<string, number>()
  readonly #escalations = new Map<string, number>()
  readonly #admissionTiers = new Map<string, TierName>()
  /** Recorded escalation-tool requests per unit (ADP-015 agent self-reports). */
  readonly #escalationEvidence = new Map<string, EscalationEvidence[]>()
  /** Last agent observed per session (role-hint routing evidence, ADP-002). */
  // Bounded like every other per-session map: long-lived hosts meet many
  // short-lived subagent sessions, and agent hints for long-gone sessions
  // are worthless. Insertion order gives the eviction (oldest hint first).
  static readonly MAX_AGENT_HINTS = 1024
  readonly #agents = new Map<string, string>()
  /**
   * Per-session tier requests (agent-declared via the adaptive_tier tool):
   * the request is STICKY — it steers the session's next and following
   * admissions until cleared or the session dies — because an agent works
   * across many units in one task. Insertion order gives the eviction.
   */
  static readonly MAX_TIER_REQUESTS = 1024
  readonly #tierRequests = new Map<string, TierRequest>()
  /**
   * Sessions with an owned continuation prompt in flight: the prompt hook
   * will fire for it, but that prompt belongs to the active unit — it must
   * not re-admit (prevents an admission ping-pong).
   */
  readonly #continuationPending = new Set<string>()
  /**
   * Depth of continuation prompts whose prompt hook has not run yet (or whose
   * host call is still in flight). While a session is inside this window, a
   * unit close must not clear the ownership mark: the close event of the
   * failed unit is pumped concurrently with the continuation's own
   * beforePrompt → prompt-hook sequence, and clearing the mark there would
   * make the continuation re-admit (admission ping-pong).
   */
  readonly #continuationsInFlight = new Map<string, number>()
  /**
   * Half-open probe tickets by session: a probe admitted while computing the
   * recovery for a veto belongs to the continuation episode that follows, so
   * the ticket is parked here until that unit opens and takes it.
   */
  readonly #sessionProbeTickets = new Map<string, ProbeTicket>()
  /**
   * Half-open probe tickets by unit: the unit admitted as (or carrying) the
   * breaker's single probe. Its termination reports the probe outcome — a
   * success closes the breaker, a failure reopens it, an interruption re-arms
   * it — otherwise a lost probe would wedge the resource in half_open.
   */
  readonly #probeTickets = new Map<string, ProbeTicket>()
  /**
   * Session → tier admitted by the prompt hook for the unit that is about to
   * open. Consumed by execution-started, which then skips re-routing (the
   * model is already applied to the very turn that triggered admission).
   */
  readonly #promptAdmission = new Map<string, { tier?: TierName }>()
  /**
   * Tier intent for an owned continuation (retry recovery, escalation,
   * parked resume) set before its prompt is delivered. The continuation's
   * prompt hook re-arms the prompt-admission marker from this so the
   * continuation's execution-started skips re-routing — a fresh admission
   * would flip an escalated episode back to the preferred model mid-unit
   * (a switch only lands on the next turn). Cleared when the continuation
   * unit opens, its prompt is rejected, or the session dies.
   */
  readonly #continuationTiers = new Map<string, TierName>()
  readonly #ready: Promise<SettingsV1>
  readonly #ops: ReturnType<typeof sessionOps>

  constructor(options: SupervisorOptions) {
    this.#options = options
    this.#health = new ResourceHealthRegistry(options.clock)
    this.#capacity = new CapacityRegistry(options.clock)
    this.#codex = new CodexCapacitySensor({ providerID: CODEX_PROVIDER_ID })
    this.#capacity.register(this.#codex)
    this.#settings = new SettingsStore(storageSeam(SETTINGS_KEY, options.storage))
    this.#receipts = new ReceiptStore(storageSeam(RECEIPTS_KEY, options.storage))
    this.#parked = new ParkedWorkStore(storageSeam(PARKED_KEY, options.storage))
    this.#healthRecords = new HealthRecordStore(storageSeam(HEALTH_KEY, options.storage))
    this.#capacityStore = new CapacityReadingStore(storageSeam(CAPACITY_KEY, options.storage))
    this.#sessionModes = new SessionModeStore(
      storageSeam(SESSION_MODES_KEY, options.storage),
      options.clock,
    )
    this.#ops = sessionOps(options.session, {
      beforeSwitch: (sessionID, model) => {
        this.#tracker.noteOwnSwitch(sessionID, model)
      },
      beforePrompt: (sessionID) => {
        this.#continuationPending.add(sessionID)
        this.#continuationsInFlight.set(
          sessionID,
          (this.#continuationsInFlight.get(sessionID) ?? 0) + 1,
        )
      },
      afterPrompt: (sessionID, delivered) => {
        // sessionOps.prompt calls this only after its own beforePrompt, so
        // the entry is always present; the assertion avoids a default branch
        // no caller can reach.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const depth = this.#continuationsInFlight.get(sessionID)!
        if (depth <= 1) {
          this.#continuationsInFlight.delete(sessionID)
          if (!delivered) {
            // The last in-flight owned prompt never reached the host's hook:
            // its ownership mark would swallow the next user prompt's
            // admission, so it is dropped here (the hook can no longer fire).
            // The continuation's tier intent dies with it — no episode will
            // open to carry it.
            this.#continuationPending.delete(sessionID)
            this.#continuationTiers.delete(sessionID)
          }
        } else {
          this.#continuationsInFlight.set(sessionID, depth - 1)
        }
      },
    })
    // Durable state loads before the first report is handled: a later load
    // must never clobber decisions recorded in the meantime.
    const loadState = async (): Promise<SettingsV1> => {
      await this.#receipts.load()
      await this.#parked.load()
      // Unit ids are durable keys (`${sessionID}#${episode}`) persisted in
      // receipts and parked work. Seed the tracker's per-session episode
      // counters above every persisted id: after a restart the counters
      // must never re-mint a colliding id, which would replace a parked
      // record (the store parks one record per id) and misattribute
      // receipt outcomes.
      const floors = new Map<string, number>()
      const bump = (unitID: string | undefined): void => {
        if (unitID === undefined) return
        const cut = unitID.lastIndexOf("#")
        if (cut <= 0) return
        const sessionID = unitID.slice(0, cut)
        const episode = Number(unitID.slice(cut + 1))
        if (!Number.isInteger(episode) || episode <= 0) return
        if (episode > (floors.get(sessionID) ?? 0)) floors.set(sessionID, episode)
      }
      for (const receipt of this.#receipts.snapshot()) bump(receipt.unitID)
      for (const record of this.#parked.list()) bump(record.id)
      this.#tracker.seedEpisodes(floors)
      // Health records hydrate the registry: the host's TUI-mode plugin
      // reconciliation can serve RPC from an instance whose hooks (event
      // pump) live on another instance — persisted failures are the only
      // health that instance can see, and a fresh instance must also assess
      // persisted failures before routing instead of starting from empty.
      await this.#healthRecords.load()
      this.#health.hydrate(this.#healthRecords.snapshot())
      // Session-mode overrides hydrate the same way: a restart (or the
      // host's double-instance reconciliation) must keep steering sessions
      // under the modes the user set for them.
      await this.#sessionModes.load()
      await this.#capacityStore.load()
      return this.#settings.load()
    }
    this.#ready = loadState()
  }

  /** Settings as of the latest load/patch (awaits the constructor load). */
  async #ensureSettings(): Promise<SettingsV1> {
    await this.#ready
    return this.#settings.get()
  }

  /**
   * The session's effective operating mode (ADP-054): its per-session
   * override when one is set, else the global mode. Every session-scoped
   * supervision decision consults this instead of `settings.mode` directly.
   */
  #modeFor(sessionID: string, settings: SettingsV1): OperatingMode {
    return this.#sessionModes.get(sessionID) ?? settings.mode
  }

  // ---------- public entry points (never throw — fail-open, ADP-031) ----------

  /** Handle one host report (event pump or session hook). */
  async handleReport(report: EventReport): Promise<void> {
    try {
      const settings = await this.#ensureSettings()
      // An OFF session is fully inert — no supervision, no receipts, no
      // health evidence. Idle is the exception: it is the bookkeeping
      // boundary (parked-work sweep, dead-session override pruning) and runs
      // for every report so other sessions' overrides are maintained; the
      // sweep itself gates per parked session below.
      if (report.kind !== "idle" && this.#modeFor(report.sessionID, settings) === "off") return
      await this.#dispatch(report, settings)
    } catch (error) {
      logFailOpen("report", error)
    }
  }

  /**
   * Handle one `retry` hook invocation. On a veto this mutates
   * `input.decision` to `{ retry: false }`; otherwise the decision is left
   * untouched and OpenCode's native retry policy stands.
   */
  async handleRetry(input: RetryHookInput): Promise<void> {
    try {
      const settings = await this.#ensureSettings()
      if (this.#modeFor(input.sessionID, settings) === "off") return
      await this.#handleRetry(input, settings)
    } catch (error) {
      logFailOpen("retry", error)
    }
  }

  /**
   * Record an escalation-tool request (ADP-015 agent self-report) against the
   * session's current work unit. Returns false when no unit is active — the
   * request is then discarded (escalation is a per-unit signal).
   */
  noteEscalationRequest(sessionID: string, reason: string, evidence: string): boolean {
    const unit = this.#tracker.active(sessionID)
    if (unit === undefined) return false
    const recorded = this.#escalationEvidence.get(unit.id) ?? []
    recorded.push({
      kind: "agent-request",
      detail: escalationDetail({ reason, evidence }),
    })
    this.#escalationEvidence.set(unit.id, recorded.slice(-MAX_ESCALATION_EVIDENCE))
    return true
  }

  /**
   * Record an agent-declared tier request for the session (the adaptive_tier
   * tool). STICKY: it steers the session's next and following admissions
   * until cleared — an agent works across many units in one task. Returns
   * false on an unknown tier (the tool re-validates before calling).
   */
  noteTierRequest(sessionID: string, tier: string): boolean {
    if (!isTierName(tier)) return false
    if (
      !this.#tierRequests.has(sessionID) &&
      this.#tierRequests.size >= Supervisor.MAX_TIER_REQUESTS
    ) {
      // The map is non-empty here (size >= MAX_TIER_REQUESTS > 0): Map
      // preserves insertion order, so the first key is the oldest request.
      for (const oldest of this.#tierRequests.keys()) {
        this.#tierRequests.delete(oldest)
        break
      }
    }
    this.#tierRequests.set(sessionID, { tier, via: "manual-command" })
    return true
  }

  /** The session's tier request, or `null` when it follows the routing ladder. */
  async getTierRequest(sessionID: string): Promise<TierName | null> {
    await this.#ready
    return this.#tierRequests.get(sessionID)?.tier ?? null
  }

  /** Clear one session's tier request (`null` is the only valid input). */
  async setTierRequest(sessionID: string, tier: TierName | null): Promise<void> {
    await this.#ready
    if (tier !== null) throw new Error("only null clears a tier request")
    this.#tierRequests.delete(sessionID)
  }

  // ---------- state API for the control surfaces (ADP-033/034/036) ----------

  /** Current settings (awaits the constructor load). */
  async settings(): Promise<SettingsV1> {
    return this.#ensureSettings()
  }

  /** Validate and persist a settings patch; returns per-field errors. */
  async updateSettings(patch: SettingsPatch): Promise<PatchResult> {
    await this.#ready
    return this.#settings.update(patch)
  }

  /** The session's mode override, or `null` when it follows the global mode. */
  async getSessionMode(sessionID: string): Promise<OperatingMode | null> {
    await this.#ready
    return this.#sessionModes.get(sessionID)
  }

  /**
   * Persist one session's mode override (`null` clears it). Throws on write
   * failure — the RPC handler degrades that to an error patch result
   * (fail-open, ADP-031), while the routing path never calls this.
   */
  async setSessionMode(sessionID: string, mode: OperatingMode | null): Promise<void> {
    await this.#ready
    await this.#sessionModes.set(sessionID, mode)
  }

  /**
   * Bounded status snapshot for the status view (ADP-033). Health is read
   * from the persisted record set (not the in-memory registry): the serving
   * instance's registry can be empty when the host's plugin reconciliation
   * placed the event-pump hooks on another instance, while the persisted
   * mirror is shared by every instance.
   */
  async status(): Promise<StatusSnapshot> {
    const settings = await this.#ensureSettings()
    await this.#healthRecords.load()
    // The persisted mirror serves the status surface: a serving instance
    // without the event-pump hooks must still report sensed capacity.
    await this.#capacityStore.load()
    const now = this.#options.clock()
    const records = this.#healthRecords.snapshot().map((record) => sweepRecord(record, now))
    // Capacity readings are gathered per configured ref (mirroring the health
    // input shape) so buildStatus stays a pure function of its inputs.
    const capacity: Record<string, CapacityReading | null> = {}
    for (const tier of TIERS) {
      for (const ref of settings.tiers[tier]) {
        const chainIDs = new Set(resourceChain(refKey(ref)).map(resourceKeyID))
        const candidates = this.#capacityStore
          .snapshot()
          .filter((entry) => chainIDs.has(resourceKeyID(entry.key)))
          .map((entry) => entry.reading)
        capacity[schedulerHealthKey(ref)] = mergeReadings(candidates, now)
      }
    }
    return buildStatus({
      settings,
      health: records,
      capacity,
      parked: this.#parked.count(),
      receipts: this.#receipts.snapshot().length,
    })
  }

  /** Newest-first bounded receipt view (ADP-030). */
  async receipts(): Promise<Receipt[]> {
    await this.#ready
    return this.#receipts.snapshot().slice(-RECEIPTS_VIEW_LIMIT).reverse()
  }

  // ---------- dispatch ----------

  async #dispatch(report: EventReport, settings: SettingsV1): Promise<void> {
    switch (report.kind) {
      case "execution-started":
        await this.#onExecutionStarted(report, settings)
        return
      case "execution-succeeded":
        await this.#onExecutionSucceeded(report)
        return
      case "execution-failed":
        await this.#onExecutionFailed(report, settings)
        return
      case "execution-interrupted":
        await this.#onExecutionInterrupted(report)
        return
      case "model-selected":
        this.#tracker.apply({
          kind: "model-selected",
          sessionID: report.sessionID,
          at: report.at,
          model: report.model,
        })
        return
      case "model-request":
        if (report.agent !== undefined) {
          if (
            !this.#agents.has(report.sessionID) &&
            this.#agents.size >= Supervisor.MAX_AGENT_HINTS
          ) {
            // The guard above ensures the map is at its cap (>= 1 entries),
            // so the first key always exists; the assertion avoids a branch
            // the coverage gate would reject as unreachable.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const oldest = this.#agents.keys().next().value!
            this.#agents.delete(oldest)
          }
          this.#agents.set(report.sessionID, report.agent)
        }
        this.#tracker.apply({
          kind: "model-request",
          sessionID: report.sessionID,
          at: this.#options.clock(),
          model: report.model,
        })
        return
      case "http-response":
        await this.#onHttpResponse(report)
        return
      case "idle":
        await this.#onIdle(settings)
        return
      case "prompt":
        await this.#onPrompt(report.sessionID, settings)
        return
    }
  }

  // ---------- admission ----------

  /**
   * CONTROL-mode admission in the awaited prompt hook. The hook runs before
   * the turn's model resolution, so the applied model governs the very turn
   * that triggered admission (the event-pump execution-started report is
   * asynchronous and would only affect the next turn — verified on host
   * 2.2.5). OBSERVE never switches, so it needs no prompt-time decision and
   * stays on the pump entirely.
   */
  async #onPrompt(sessionID: string, settings: SettingsV1): Promise<void> {
    const mode = this.#modeFor(sessionID, settings)
    if (mode !== "active") return
    if (this.#continuationPending.delete(sessionID)) {
      // An owned continuation (retry recovery, escalation, parked resume)
      // already owns this unit's routing: re-arm the admission marker from
      // the continuation's tier intent so execution-started skips a fresh
      // (continuation-unaware) admission.
      const tier = this.#continuationTiers.get(sessionID)
      this.#promptAdmission.set(sessionID, tier !== undefined ? { tier } : {})
      return
    }
    // A fresh user prompt cancels any stale continuation intent and marker:
    // this admission re-routes from scratch.
    this.#continuationTiers.delete(sessionID)
    this.#promptAdmission.delete(sessionID)
    // A pending probe ticket from an earlier prompt admission (or a failed
    // recovery) can only be carried by the unit the ORIGINAL prompt opens;
    // a fresh admission means that episode never ran, so the ticket re-arms
    // here instead of being adopted by whichever unit opens next.
    const stale = this.#sessionProbeTickets.get(sessionID)
    if (stale !== undefined) {
      this.#sessionProbeTickets.delete(sessionID)
      this.#reportProbeOutcome(stale, { success: false, category: "user_cancelled" })
    }
    let probeTicket: ProbeTicket | undefined
    try {
      const admission = await this.#admit(settings, sessionID)
      probeTicket = admission.probeTicket
      const wrapped = schedulerForMode(admission.decision, mode)
      if (wrapped.kind === "apply") {
        await this.#ops.switchModel(sessionID, wrapped.model)
      }
      // A pin is not a tier — receipts only carry a tier for tiered routing.
      const tier = routingTier(admission.routing)
      await this.#recordReceipt({
        sessionID,
        ...(tier !== undefined ? { tier } : {}),
        decision: wrapped,
      })
      this.#promptAdmission.set(sessionID, { ...(tier !== undefined ? { tier } : {}) })
      // The prompt-admitted probe episode is the turn that follows.
      if (wrapped.kind === "apply" && probeTicket !== undefined) {
        this.#sessionProbeTickets.set(sessionID, probeTicket)
      }
    } catch (error) {
      // A probe admitted for this turn is lost when the admission fails (the
      // switch threw): no unit will ever carry the ticket, so re-arm it.
      if (probeTicket !== undefined) {
        this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
      }
      // Fail-open: no marker → execution-started re-routes the unit itself.
      logFailOpen("admission", error)
      await this.#recordReceipt({
        sessionID,
        decision: { kind: "defer", reason: "routing-defer", detail: "internal error" },
      })
    }
  }

  async #onExecutionStarted(
    report: EventReport & { kind: "execution-started" },
    settings: SettingsV1,
  ): Promise<void> {
    const opened = this.#tracker.apply({
      kind: "execution-started",
      sessionID: report.sessionID,
      at: report.at,
    })
    const unit = opened.unit
    // The prompt-hook marker belongs to the unit this report OPENS, so read
    // it before the close cleanup: a superseding start would otherwise
    // discard it and re-route an already-admitted turn.
    const admitted = this.#promptAdmission.get(report.sessionID)
    // A superseding start closes the previous episode — release its
    // per-unit bookkeeping (veto budget) too.
    this.#afterUnitClose(opened)
    // The prompt hook already admitted and applied for this unit — carry the
    // tier into escalation context and skip re-routing.
    if (admitted !== undefined) {
      this.#promptAdmission.delete(report.sessionID)
      this.#continuationTiers.delete(report.sessionID)
      if (admitted.tier !== undefined) this.#admissionTiers.set(unit.id, admitted.tier)
      // The prompt-time admission receipt was recorded before this unit
      // existed; adopt it so outcomes attach to it like any unit receipt.
      try {
        await this.#receipts.adoptUnit(report.sessionID, unit.id)
      } catch (error) {
        logFailOpen("receipts", error)
      }
      const sessionTicket = this.#sessionProbeTickets.get(report.sessionID)
      if (sessionTicket !== undefined) {
        this.#sessionProbeTickets.delete(report.sessionID)
        this.#probeTickets.set(unit.id, sessionTicket)
      }
      return
    }
    // A probe admitted while computing a veto's recovery belongs to the
    // continuation episode that follows — the first start on the session
    // after the veto.
    const carriedTicket = this.#sessionProbeTickets.get(report.sessionID)
    if (carriedTicket !== undefined) {
      this.#sessionProbeTickets.delete(report.sessionID)
      this.#probeTickets.set(unit.id, carriedTicket)
    }
    try {
      await this.#routeAdmission(unit, settings, this.#modeFor(unit.sessionID, settings))
    } catch (error) {
      logFailOpen("admission", error)
      await this.#recordReceipt({
        sessionID: unit.sessionID,
        unitID: unit.id,
        decision: { kind: "defer", reason: "routing-defer", detail: "internal error" },
      })
    }
  }

  /** Fresh admission: routing ladder → scheduler, raw (unwrapped). */
  async #admit(
    settings: SettingsV1,
    sessionID: string,
  ): Promise<{
    routing: RoutingDecision
    decision: ReturnType<typeof admit>
    probeTicket?: ProbeTicket
  }> {
    const routing = resolveRouting({
      ...(settings.pin !== null ? { pin: settings.pin } : {}),
      // The agent-declared tier request (adaptive_tier tool) outranks the
      // role hints but stays below the pin (ADP-002 ladder).
      ...(this.#tierRequests.has(sessionID)
        ? { tierRequest: this.#tierRequests.get(sessionID) }
        : {}),
      // The agent-role hint is the session's last observed agent — the host
      // reports it on every model request (ADP-002 level 3).
      ...(this.#agents.has(sessionID) ? { agent: this.#agents.get(sessionID) } : {}),
      agentTiers: settings.agentTiers,
      configuredTiers: configuredTiers(settings),
    })
    const tierCandidates = routing.kind === "tier" ? settings.tiers[routing.tier] : []
    const inventory = await listCandidates(this.#options.model)
    // Capacity sensors are pull-based: refresh before assessing so the
    // admission decision sees current readings.
    await this.#capacity.refresh()
    const health: Record<string, Assessment> = {}
    const capacity: Record<string, CapacitySignals> = {}
    // Tickets issued by this assessment sweep (see the re-arm below).
    const issued: ProbeTicket[] = []
    for (const candidate of inventory) {
      const ref = candidateRef(candidate)
      const mapKey = schedulerHealthKey(ref)
      const assessment = this.#health.assess(refKey(ref))
      health[mapKey] = assessment
      if (assessment.kind === "probe") issued.push(assessment.ticket)
      const capacityAssessment = this.#capacity.assessment(refKey(ref))
      if (capacityAssessment.kind === "estimate") capacity[mapKey] = capacityAssessment.signals
    }
    const input: SchedulerInput = {
      routing,
      // The host exposes no per-episode demand source in the v2 wiring
      // (no tool/modality/context requirement reaches the plugin), so the
      // compatibility gate runs on availability metadata only. Documented
      // limitation — see TEST_STRATEGY "Compatibility gate demand".
      demand: {} satisfies Demand,
      inventory,
      tierCandidates,
      health,
      capacity,
    }
    const decision = admit(input)
    // Assess admits a half-open probe for every due breaker it touches —
    // including candidates this decision passed over (a ready sibling wins)
    // or dispatched nothing for (defer/park). An issued-but-undispatched
    // probe would wedge its resource in half_open: no unit ever carries the
    // ticket, so nothing reports it and the resource never recovers. Re-arm
    // each unselected ticket with the breaker's same backoff window — a
    // probe that never ran is no health evidence.
    const selectedId = decision.kind === "apply" ? decision.evidence.probeId : undefined
    let probeTicket: ProbeTicket | undefined
    for (const ticket of issued) {
      if (selectedId !== undefined && ticket.id === selectedId) {
        probeTicket = ticket
      } else {
        this.#health.reportProbe(ticket, { success: false, category: "user_cancelled" })
      }
    }
    return { routing, decision, ...(probeTicket !== undefined ? { probeTicket } : {}) }
  }

  async #routeAdmission(
    unit: ActiveUnit,
    settings: SettingsV1,
    mode: OperatingMode,
  ): Promise<void> {
    const { routing, decision, probeTicket } = await this.#admit(settings, unit.sessionID)
    // The tier the unit was admitted under is escalation context (ADP-015);
    // recorded for every tiered routing outcome (including a defer, which
    // still names the tier it could not honor).
    if (routing.kind !== "pin") {
      this.#admissionTiers.set(unit.id, routing.tier)
    }
    const wrapped = schedulerForMode(decision, mode)
    if (wrapped.kind === "apply") {
      try {
        await this.#applyModel(unit, wrapped)
      } catch (error) {
        // The episode cannot carry the probe when the switch itself failed —
        // re-arm the ticket instead of wedging the resource half-open.
        if (probeTicket !== undefined) {
          this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
        }
        throw error
      }
      if (probeTicket !== undefined) this.#probeTickets.set(unit.id, probeTicket)
      return
    }
    if (probeTicket !== undefined) {
      // OBSERVE wraps an apply — including a probe admission — without
      // running it: no episode will ever report the ticket, so re-arm it.
      this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
    }
    // Observe-only records the identical decision; defer and park leave the
    // episode on OpenCode's own model (admission cannot hold an episode).
    const tier = routingTier(routing)
    await this.#recordReceipt({
      sessionID: unit.sessionID,
      unitID: unit.id,
      ...(tier !== undefined ? { tier } : {}),
      decision: wrapped,
    })
  }

  /** CONTROL-mode application at the admission boundary; OBSERVE never reaches here. */
  async #applyModel(unit: ActiveUnit, decision: ApplyDecision): Promise<void> {
    await this.#ops.switchModel(unit.sessionID, decision.model)
    await this.#recordReceipt({
      sessionID: unit.sessionID,
      unitID: unit.id,
      ...(decision.tier !== undefined ? { tier: decision.tier } : {}),
      decision,
    })
  }

  // ---------- unit termination ----------

  async #onExecutionSucceeded(
    report: EventReport & { kind: "execution-succeeded" },
  ): Promise<void> {
    const unit = this.#tracker.active(report.sessionID)
    const model = unit?.model ?? this.#tracker.lastModel(report.sessionID)?.model
    const probeTicket = unit !== undefined ? this.#probeTickets.get(unit.id) : undefined
    const closed = this.#tracker.apply({
      kind: "execution-succeeded",
      sessionID: report.sessionID,
      at: report.at,
    })
    this.#afterUnitClose(closed)
    if (model !== undefined) {
      this.#observeHealth({ kind: "success", key: refKey(model) })
    }
    if (unit !== undefined) {
      if (probeTicket !== undefined) {
        this.#probeTickets.delete(unit.id)
        this.#reportProbeOutcome(probeTicket, { success: true })
      }
      await this.#attachOutcome(unit, { status: "succeeded" })
    }
  }

  async #onExecutionFailed(
    report: EventReport & { kind: "execution-failed" },
    settings: SettingsV1,
  ): Promise<void> {
    const unit = this.#tracker.active(report.sessionID)
    const model = unit?.model ?? this.#tracker.lastModel(report.sessionID)?.model
    const unitID = unit?.id
    // Budget and tier are read before the close clears the per-unit maps.
    const admissionTier = unitID !== undefined ? this.#admissionTiers.get(unitID) : undefined
    const escalationUsed = unitID !== undefined ? (this.#escalations.get(unitID) ?? 0) : 0
    // Tool evidence is captured pre-close like the other per-unit maps.
    const toolEvidence = unitID !== undefined ? (this.#escalationEvidence.get(unitID) ?? []) : []
    const probeTicket = unitID !== undefined ? this.#probeTickets.get(unitID) : undefined
    const closed = this.#tracker.apply({
      kind: "execution-failed",
      sessionID: report.sessionID,
      at: report.at,
      error: report.error,
    })
    this.#afterUnitClose(closed)
    const classification = classifyFailure({
      structured: {
        type: report.error.type,
        ...(report.error.retryAfterMs !== undefined
          ? { retryAfterMs: report.error.retryAfterMs }
          : {}),
      },
      status: report.error.status,
      // Terminal classification may use the bounded textual last resort
      // (content-policy rejections arrive as free text, not error types).
      // The retry hook deliberately omits text: it must stay conservative.
      text: report.error.message,
    })
    if (model !== undefined) {
      this.#observeHealth(failureEvent(refKey(model), classification))
    }
    if (unit !== undefined) {
      await this.#attachOutcome(unit, { status: "failed", category: classification.category })
      if (probeTicket !== undefined) {
        this.#probeTickets.delete(unit.id)
        this.#reportProbeOutcome(probeTicket, { success: false, category: classification.category })
      }
    }
    await this.#escalateOnFailure(
      report,
      unitID,
      model,
      classification,
      admissionTier,
      escalationUsed,
      toolEvidence,
      settings,
    )
  }

  /**
   * Escalation targets must be usable: the scheduler contract hands
   * planEscalation "already gated" resources, so the wiring filters the next
   * tier's configured refs to candidates that exist in the inventory, pass
   * the compatibility gate, are not health-blocked, and differ from the
   * model that just failed. Evaluated WITHOUT probe admission (evaluate,
   * not assess) — gating an escalation must never flip a breaker or strand
   * an unowned ticket.
   */
  async #eligibleEscalationTargets(
    refs: readonly ModelRef[],
    failed: ModelRef,
  ): Promise<ModelRef[]> {
    let inventory: readonly CandidateModel[]
    try {
      inventory = await listCandidates(this.#options.model)
    } catch (error) {
      // No inventory means no verifiable target: escalating would switch
      // blind, so the budget is kept instead of burned.
      logFailOpen("escalation", error)
      return []
    }
    const eligible: ModelRef[] = []
    for (const ref of refs) {
      if (sameModelRef(ref, failed)) continue
      const candidate = inventory.find((entry) => sameModelRef(candidateRef(entry), ref))
      if (candidate === undefined) continue
      if (!checkCompatibility(candidate, {} satisfies Demand).compatible) continue
      if (this.#health.evaluate(refKey(ref)).kind !== "available") continue
      eligible.push(ref)
    }
    return eligible
  }

  /**
   * Escalation on a terminally failed unit (ADP-015..017): structured
   * capability evidence only, same-model variant first then next tier,
   * finite budget. Control continues the interrupted work on the escalated
   * resource; Observe records the identical decision; defer receipts stand.
   */
  async #escalateOnFailure(
    report: EventReport & { kind: "execution-failed" },
    unitID: string | undefined,
    model: ModelRef | undefined,
    classification: FailureClassification,
    admissionTier: TierName | undefined,
    escalationUsed: number,
    toolEvidence: readonly EscalationEvidence[],
    settings: SettingsV1,
  ): Promise<void> {
    if (
      unitID === undefined ||
      model === undefined ||
      admissionTier === undefined ||
      !CAPABILITY_EVIDENCE_CATEGORIES.includes(classification.category)
    ) {
      return
    }
    const next = nextTier(admissionTier)
    const evidence: EscalationEvidence[] = [
      ...toolEvidence,
      { kind: "repeated-failure", detail: classification.category },
    ]
    const nextResources = next !== undefined ? settings.tiers[next] : []
    const eligible = await this.#eligibleEscalationTargets(nextResources, model)
    const plan = planEscalation({
      currentModel: model,
      currentTier: admissionTier,
      nextTierResources: eligible,
      evidence,
      budget: { used: escalationUsed, max: MAX_ESCALATIONS_PER_UNIT },
    })
    const wrapped = schedulerForMode(plan, this.#modeFor(report.sessionID, settings))
    if (wrapped.kind === "escalate") {
      this.#escalations.set(unitID, escalationUsed + 1)
      // Recorded unit-less on purpose: the receipt describes the CONTINUATION
      // decision, so the continuation unit adopts it and its outcome attaches
      // here (the failed unit's own outcome attaches to its apply receipt).
      await this.#recordReceipt({
        sessionID: report.sessionID,
        tier: wrapped.tier,
        decision: wrapped,
      })
      // Continue the interrupted work on the escalated resource; the unit is
      // terminally failed, so an ops failure is only logged (never parked).
      try {
        await this.#ownRecovery(report.sessionID, wrapped.target, wrapped.tier)
      } catch (error) {
        logFailOpen("escalation-ops", error)
      }
      return
    }
    await this.#recordReceipt({
      sessionID: report.sessionID,
      tier: plan.kind === "escalate" ? plan.tier : admissionTier,
      decision: wrapped,
    })
  }

  async #onExecutionInterrupted(
    report: EventReport & { kind: "execution-interrupted" },
  ): Promise<void> {
    const reason = interruptReason(report.reason)
    if (reason === undefined) {
      logFailOpen(
        "interrupt",
        new Error(`unknown interruption reason: ${report.reason.slice(0, 32)}`),
      )
      return
    }
    const unit = this.#tracker.active(report.sessionID)
    const probeTicket = unit !== undefined ? this.#probeTickets.get(unit.id) : undefined
    const closed = this.#tracker.apply({
      kind: "execution-interrupted",
      sessionID: report.sessionID,
      at: report.at,
      reason,
    })
    this.#afterUnitClose(closed)
    // User and host interruptions never produce health evidence (the
    // classifier maps them outside the infrastructure vocabulary).
    if (unit !== undefined) {
      // An interrupted probe is no evidence about resource health: re-arm the
      // breaker's same window rather than doubling it.
      if (probeTicket !== undefined) {
        this.#probeTickets.delete(unit.id)
        this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
      }
      await this.#attachOutcome(unit, { status: "interrupted", reason })
    }
  }

  /**
   * One probe ticket's resolution at its episode's termination. A probe that
   * ends without a reported outcome (superseded, lost) would wedge the
   * resource in half_open, so the close cleanup reports those as
   * interruptions — re-arming the same backoff window, never doubling it.
   */
  #reportProbeOutcome(ticket: ProbeTicket, outcome: ProbeOutcome): void {
    // reportProbe is total and synchronous; validation failures (stale or
    // unknown ticket) are reported by its boolean return, not by throwing.
    this.#health.reportProbe(ticket, outcome)
  }

  /** Bounded per-unit bookkeeping once the tracker closed the unit. */
  #afterUnitClose(closed: ApplyResult): void {
    const unitID = closedUnitID(closed)
    if (unitID !== undefined) {
      this.#vetoes.delete(unitID)
      this.#escalations.delete(unitID)
      this.#admissionTiers.delete(unitID)
      this.#escalationEvidence.delete(unitID)
      const leftover = this.#probeTickets.get(unitID)
      if (leftover !== undefined) {
        // The explicit outcome reporters run before this cleanup; reaching
        // here means the unit ended without one (superseded or lost).
        this.#reportProbeOutcome(leftover, { success: false, category: "user_cancelled" })
        this.#probeTickets.delete(unitID)
      }
    }
    if (closed.kind === "opened" || closed.kind === "closed") {
      // Per-session flags for a unit that will never open again must not
      // leak: a stale continuation mark would swallow a real user prompt's
      // admission; a stale admission marker would skip routing. The guard
      // keeps the wipe out of an in-flight continuation's mark window (its
      // own close events are pumped concurrently with the mark).
      const sid = closed.unit.sessionID
      // A continuation tier intent pins the marker: the failed unit's close
      // event can arrive after the continuation's prompt hook set it, and
      // wiping then would re-route the continuation unit.
      if ((this.#continuationsInFlight.get(sid) ?? 0) === 0 && !this.#continuationTiers.has(sid)) {
        this.#continuationPending.delete(sid)
        this.#promptAdmission.delete(sid)
      }
    }
  }

  // ---------- http evidence ----------

  async #onHttpResponse(report: EventReport & { kind: "http-response" }): Promise<void> {
    if (report.capturedHeaders !== undefined) {
      this.#codex.observe(report.capturedHeaders, this.#options.clock())
      await this.#syncCapacityMirror()
    }
    if (report.status < 400) return
    const unit = this.#tracker.active(report.sessionID)
    const model = unit?.model ?? this.#tracker.lastModel(report.sessionID)?.model
    if (model === undefined) return
    const classification = classifyFailure({
      status: report.status,
      ...(report.retryAfterHeader !== undefined
        ? { headers: { "retry-after": report.retryAfterHeader } }
        : {}),
    })
    this.#observeHealth(failureEvent(refKey(model), classification))
  }

  // ---------- retry hook ----------

  async #handleRetry(input: RetryHookInput, settings: SettingsV1): Promise<void> {
    const classification = classifyFailure({
      structured: {
        type: input.error.type,
        ...(input.error.retryAfterMs !== undefined
          ? { retryAfterMs: input.error.retryAfterMs }
          : {}),
      },
      status: input.error.status,
    })
    this.#observeHealth(failureEvent(refKey(input.model), classification))

    // Recovery = fresh admission; the failed resource is already health-blocked.
    let recovery: RecoveryOption = { kind: "none" }
    let routingTier: TierName | undefined
    let probeTicket: ProbeTicket | undefined
    let admission: ReturnType<typeof admit> | undefined
    try {
      const {
        routing,
        decision,
        probeTicket: ticket,
      } = await this.#admit(settings, input.sessionID)
      routingTier = routing.kind === "pin" ? undefined : routing.tier
      if (decision.kind === "apply") {
        admission = decision
        recovery = {
          kind: "switch",
          model: decision.model,
          ...(decision.evidence.probeId !== undefined
            ? { probeId: decision.evidence.probeId }
            : {}),
        }
        probeTicket = ticket
      }
    } catch (error) {
      logFailOpen("recovery", error)
    }

    const unitID = this.#tracker.active(input.sessionID)?.id
    const vetoesUsed = unitID !== undefined ? (this.#vetoes.get(unitID) ?? 0) : 0
    const core = decideRetry({
      classification,
      failingModel: input.model,
      native: input.decision,
      recovery,
      vetoesUsed,
    })
    const wrapped = retryForMode(core, this.#modeFor(input.sessionID, settings))
    if (wrapped.kind !== "veto") {
      // OBSERVE (and a declined veto) never runs the recovery episode, so an
      // admitted probe has no continuation to report it — re-arm it here or
      // the resource wedges half-open.
      if (probeTicket !== undefined) {
        this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
      }
      return
    }
    input.decision = { retry: false }
    if (unitID !== undefined) {
      this.#vetoes.set(unitID, vetoesUsed + 1)
    }
    // A probe admitted by this recovery belongs to the continuation episode
    // that ownRecovery is about to start; its termination reports the probe.
    if (probeTicket !== undefined) {
      // The session holds one pending probe slot. A still-pending older
      // ticket belongs to a recovery whose continuation has not started (its
      // episode can no longer claim this slot) — re-arm it before replacing.
      const stale = this.#sessionProbeTickets.get(input.sessionID)
      if (stale !== undefined && stale !== probeTicket) {
        this.#reportProbeOutcome(stale, { success: false, category: "user_cancelled" })
      }
      this.#sessionProbeTickets.set(input.sessionID, probeTicket)
    }
    // The continuation episode is not re-admitted — its prompt hook is
    // consumed as an owned continuation — so the recovery admission is
    // recorded here, unit-less; the unit that opens next adopts this receipt
    // and carries the outcome.
    // A veto implies the admission was an apply: the recovery option exists
    // only when the fresh admission selected a resource, so the assertion
    // cannot be undefined on this path.
    await this.#recordReceipt({
      sessionID: input.sessionID,
      tier: routingTier,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- a veto implies the admission was an apply (the recovery exists only then)
      decision: admission!,
    })
    void this.#ownRecovery(input.sessionID, wrapped.model, routingTier)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        logFailOpen("recovery-ops", error)
        // The recovery rejected before (or while) delivering its continuation
        // prompt, so no unit will ever carry the probe it admitted — re-arm
        // it instead of wedging the resource half-open.
        if (
          probeTicket !== undefined &&
          this.#sessionProbeTickets.get(input.sessionID) === probeTicket
        ) {
          this.#sessionProbeTickets.delete(input.sessionID)
          this.#reportProbeOutcome(probeTicket, { success: false, category: "user_cancelled" })
        }
        if (unitID === undefined || routingTier === undefined) return
        try {
          await this.#parked.park({
            id: unitID,
            sessionID: input.sessionID,
            tier: routingTier,
            reason: "all-blocked",
            detail: "continuation failed",
            parkedAt: this.#options.clock(),
          })
        } catch (parkError) {
          logFailOpen("parked", parkError)
        }
      })
  }

  /**
   * Owned horizontal recovery: settle → switch → continue from session
   * state. `tier` is the continuation unit's routing tier — recorded so the
   * continuation's prompt hook re-arms the admission marker (the unit must
   * not be re-routed: that would discard the recovery/escalation decision).
   */
  async #ownRecovery(sessionID: string, model: ModelRef, tier?: TierName): Promise<void> {
    if (tier !== undefined) this.#continuationTiers.set(sessionID, tier)
    const alive = await this.#isSessionAlive(sessionID)
    const recovery: RecoveryOption = { kind: "switch", model }
    const action = planContinuation({
      recovery,
      continuationPossible: alive,
    })
    try {
      await executeContinuation({ sessionID, action, ops: this.#ops })
    } catch (error) {
      // The continuation prompt never reached the host, so no unit will open
      // to consume the tier intent — drop it or it would pin the marker
      // wipes and mislabel a later user prompt's admission.
      if (tier !== undefined) this.#continuationTiers.delete(sessionID)
      throw error
    }
  }

  // ---------- parked-work resume (safe boundary: idle) ----------

  async #onIdle(settings: SettingsV1): Promise<void> {
    const records = this.#parked.list()
    // Override holders join the alive sweep: a dead session's override is
    // pruned here (its per-session steering is worthless once the session is
    // gone), in the same sweep that clears the other per-session maps.
    const overrideIDs = this.#sessionModes.snapshot().map((record) => record.sessionID)
    if (records.length === 0 && overrideIDs.length === 0 && this.#tierRequests.size === 0) return
    // OFF sessions are not supervised: their parked records are neither
    // dropped nor resumed, and no alive probe runs for them.
    const supervised = new Set(
      records
        .map((record) => record.sessionID)
        .filter((sessionID) => this.#modeFor(sessionID, settings) !== "off"),
    )
    const alive = new Map<string, boolean>()
    for (const sessionID of new Set([...supervised, ...overrideIDs])) {
      alive.set(sessionID, await this.#isSessionAlive(sessionID))
    }
    // Tier-request holders join the alive sweep too: a dead session's sticky
    // tier request dies with its session, like the other per-session maps.
    for (const sessionID of this.#tierRequests.keys()) {
      if (!alive.has(sessionID)) alive.set(sessionID, await this.#isSessionAlive(sessionID))
    }
    const plan = selectResumable(records, {
      tierConfigured: (tier) => configuredTiers(settings).includes(tier),
      sessionAlive: (sessionID) => alive.get(sessionID) === true,
    })
    for (const dropped of plan.drop) {
      if (this.#modeFor(dropped.sessionID, settings) === "off") continue
      await this.#dropParked(dropped)
    }
    // Tier requests die with their session, like the other per-session maps.
    for (const sessionID of this.#tierRequests.keys()) {
      if (alive.get(sessionID) === false) this.#tierRequests.delete(sessionID)
    }
    // At most ONE continuation per session per sweep: prompting a session
    // with an active unit would supersede the user's in-flight episode (not
    // a safe boundary), and several back-to-back continuation prompts could
    // redo work an earlier one already completed (ADP-023).
    const attempted = new Set<string>()
    for (const record of plan.attempt) {
      if (this.#modeFor(record.sessionID, settings) === "off") continue
      if (this.#tracker.active(record.sessionID) !== undefined) continue
      if (attempted.has(record.sessionID)) continue
      attempted.add(record.sessionID)
      await this.#resumeAttempt(record, settings)
    }
    for (const [sessionID, isAlive] of alive) {
      if (!isAlive) {
        this.#continuationTiers.delete(sessionID)
        this.#promptAdmission.delete(sessionID)
        this.#continuationPending.delete(sessionID)
        if (this.#sessionModes.get(sessionID) !== null) {
          try {
            await this.#sessionModes.set(sessionID, null)
          } catch (error) {
            logFailOpen("session-modes", error)
          }
        }
      }
    }
  }

  async #dropParked(record: ParkedRecord): Promise<void> {
    try {
      await this.#parked.resume(record.id)
    } catch (error) {
      logFailOpen("parked", error)
    }
  }

  /** One parked record's fresh routing attempt at the idle boundary. */
  async #resumeAttempt(record: ParkedRecord, settings: SettingsV1): Promise<void> {
    // The parked session resumes under ITS effective mode, not the idle
    // report's session's mode.
    const mode = this.#modeFor(record.sessionID, settings)
    let decision: ReturnType<typeof admit>
    try {
      decision = (await this.#admit(settings, record.sessionID)).decision
    } catch (error) {
      logFailOpen("resume", error)
      return
    }
    if (mode === "observe") {
      await this.#recordReceipt({
        sessionID: record.sessionID,
        unitID: record.id,
        tier: record.tier,
        decision: { kind: "observe-only", would: decision },
      })
      return
    }
    if (decision.kind !== "apply") {
      // Still no usable resource (or the routing deferred) — stay parked.
      await this.#recordReceipt({
        sessionID: record.sessionID,
        unitID: record.id,
        tier: record.tier,
        decision,
      })
      return
    }
    const popped = await this.#popParked(record)
    if (popped === undefined) return
    // The resume continuation is not re-admitted (owned continuation), so
    // the freshly routed admission is recorded here, unit-less; the unit
    // that opens next adopts it and carries the outcome.
    await this.#recordReceipt({
      sessionID: record.sessionID,
      tier: record.tier,
      decision,
    })
    // The resume continuation is an owned recovery: settle first, apply the
    // freshly routed model, then prompt — the episode's first LLM call must
    // not hit the model the work was parked away from.
    try {
      await this.#ownRecovery(record.sessionID, decision.model, record.tier)
    } catch (error) {
      logFailOpen("resume", error)
      await this.#rePark(record)
    }
  }

  async #popParked(record: ParkedRecord): Promise<ParkedRecord | undefined> {
    try {
      return await this.#parked.resume(record.id)
    } catch (error) {
      logFailOpen("parked", error)
      return undefined
    }
  }

  async #rePark(record: ParkedRecord): Promise<void> {
    try {
      await this.#parked.park({
        ...record,
        attempts: (record.attempts ?? 0) + 1,
        parkedAt: this.#options.clock(),
      })
    } catch (error) {
      logFailOpen("parked", error)
    }
  }

  // ---------- shared helpers ----------

  async #isSessionAlive(sessionID: string): Promise<boolean> {
    try {
      await this.#options.session.get({ sessionID })
      return true
    } catch {
      return false
    }
  }

  async #recordReceipt(input: Omit<ReceiptInput, "at">): Promise<void> {
    try {
      await this.#receipts.record({ at: this.#options.clock(), ...input })
    } catch (error) {
      logFailOpen("receipts", error)
    }
  }

  async #attachOutcome(unit: ActiveUnit, outcome: ReceiptOutcome): Promise<void> {
    try {
      await this.#receipts.attachOutcome({ sessionID: unit.sessionID, unitID: unit.id }, outcome)
    } catch (error) {
      logFailOpen("receipts", error)
    }
  }

  #observeHealth(event: HealthEvent): void {
    this.#health.observe(event)
    // Persist the record mirror fire-and-forget: the status surface reads
    // persisted records so a serving instance without the event-pump hooks
    // still reports true health. Failures are fail-open (ADP-031).
    const records: readonly ResourceRecord[] = this.#health.snapshot()
    void this.#healthRecords.replace(records).catch((error: unknown) => {
      logFailOpen("health", error)
    })
  }

  /**
   * Persist the capacity mirror after a passive observation (same instance
   * split rationale as the health mirror): the status surface reads persisted
   * readings so a serving instance without the event-pump hooks still reports
   * sensed capacity. Failures are fail-open (ADP-031).
   */
  async #syncCapacityMirror(): Promise<void> {
    try {
      await this.#capacity.refresh()
      const entries: PersistedCapacityReading[] = []
      for (const sensor of this.#capacity.snapshot()) {
        if (sensor.latest !== null) {
          entries.push({ key: sensor.resource, reading: sensor.latest })
        }
      }
      await this.#capacityStore.replace(entries)
    } catch (error) {
      logFailOpen("capacity", error)
    }
  }
}

/** A pin is not a tier — receipts only carry a tier for tiered routing. */
function routingTier(routing: RoutingDecision): TierName | undefined {
  return routing.kind === "pin" ? undefined : routing.tier
}

/** The unit a tracker result closed or superseded, if any. */
function closedUnitID(result: ApplyResult): string | undefined {
  switch (result.kind) {
    case "closed":
      return result.unit.id
    case "opened":
      return result.superseded?.id
    default:
      return undefined
  }
}

/** ModelRef for a normalized candidate. */
function candidateRef(candidate: {
  providerID: string
  modelID: string
  variant?: string | undefined
}): ModelRef {
  return {
    providerID: candidate.providerID,
    id: candidate.modelID,
    ...(candidate.variant !== undefined ? { variant: candidate.variant } : {}),
  }
}

/** ResourceKey for a model ref (no account level is observable in v1). */
function refKey(ref: ModelRef): ResourceKey {
  // The host reports base-model calls with variant "default" (verified on
  // 2.2.5), while the inventory enumerates the bare model plus its named
  // variants. Taken literally, a "default" key would orphan every
  // unvarianted failure record on a key no admission ever assesses — health
  // and breaker state would be invisible to routing.
  const variant = ref.variant === "default" ? undefined : ref.variant
  return {
    providerID: ref.providerID,
    modelID: ref.id,
    ...(variant !== undefined ? { variantID: variant } : {}),
  }
}

/** Health failure event from a classification (bounded structured evidence). */
function failureEvent(key: ResourceKey, classification: FailureClassification): HealthEvent {
  return {
    kind: "failure",
    key,
    category: classification.category,
    definitive: classification.definitive,
    ...(classification.retry.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retry.retryAfterMs }
      : {}),
  }
}
