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
import type { ActiveUnit, ApplyResult, ModelRef } from "../core/work-unit/types.js"
import { INTERRUPT_REASONS } from "../core/work-unit/interruption.js"
import type { InterruptReason } from "../core/work-unit/interruption.js"
import { resolveRouting } from "../core/tier-policy/resolve.js"
import { TIERS, nextTier } from "../core/tier-policy/types.js"
import type { RoutingDecision, TierName } from "../core/tier-policy/types.js"
import {
  admit,
  forMode as schedulerForMode,
  planEscalation,
  schedulerHealthKey,
} from "../core/scheduler/index.js"
import type { ApplyDecision, EscalationEvidence, SchedulerInput } from "../core/scheduler/types.js"
import { MAX_ESCALATION_EVIDENCE } from "../core/scheduler/types.js"
import type { Demand } from "../core/compatibility/types.js"
import { classifyFailure, CapacityRegistry, ResourceHealthRegistry } from "../health/index.js"
import type {
  Assessment,
  CapacitySignals,
  FailureCategory,
  FailureClassification,
  HealthEvent,
  ResourceKey,
} from "../health/index.js"
import { SettingsStore, SETTINGS_KEY } from "../state/settings/index.js"
import type { SettingsV1 } from "../state/settings/index.js"
import type { PatchResult, SettingsPatch } from "../state/settings/types.js"
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
  SideEffectLedger,
} from "../execution/index.js"
import { MAX_ESCALATION_FIELD_LENGTH, escalationDetail } from "../execution/escalation/index.js"
import type { ContinuationPrompts, RecoveryOption } from "../execution/index.js"
import { listCandidates, sessionOps, storageSeam } from "../adapters/opencode/index.js"
import type { EventReport } from "../adapters/opencode/index.js"
import { CodexCapacitySensor } from "../adapters/codex-capacity/index.js"
import { CONTINUATION_PROMPT, logFailOpen } from "./log.js"
import type { RetryHookInput, SupervisorOptions } from "./types.js"
import { CODEX_PROVIDER_ID } from "./types.js"

/** Which tiers currently have configured resources (ADP-005). */
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
  readonly #capacity: CapacityRegistry
  readonly #codex: CodexCapacitySensor
  readonly #ledger = new SideEffectLedger()
  readonly #vetoes = new Map<string, number>()
  readonly #escalations = new Map<string, number>()
  readonly #admissionTiers = new Map<string, TierName>()
  /** Recorded escalation-tool requests per unit (ADP-015 agent self-reports). */
  readonly #escalationEvidence = new Map<string, EscalationEvidence[]>()
  /** Last agent observed per session (role-hint routing evidence, ADP-002). */
  readonly #agents = new Map<string, string>()
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
    this.#ops = sessionOps(options.session, {
      beforeSwitch: (sessionID, model) => {
        this.#tracker.noteOwnSwitch(sessionID, model)
      },
    })
    // Durable state loads before the first report is handled: a later load
    // must never clobber decisions recorded in the meantime.
    const loadState = async (): Promise<SettingsV1> => {
      await this.#receipts.load()
      await this.#parked.load()
      return this.#settings.load()
    }
    this.#ready = loadState()
  }

  /** Settings as of the latest load/patch (awaits the constructor load). */
  async #ensureSettings(): Promise<SettingsV1> {
    await this.#ready
    return this.#settings.get()
  }

  // ---------- public entry points (never throw — fail-open, ADP-031) ----------

  /** Handle one host report (event pump or session hook). */
  async handleReport(report: EventReport): Promise<void> {
    try {
      const settings = await this.#ensureSettings()
      if (settings.mode === "off") return
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
      if (settings.mode === "off") return
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
      detail: escalationDetail({ reason, evidence }).slice(0, MAX_ESCALATION_FIELD_LENGTH),
    })
    this.#escalationEvidence.set(unit.id, recorded.slice(-MAX_ESCALATION_EVIDENCE))
    return true
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

  /** Bounded status snapshot for the status view (ADP-033). */
  async status(): Promise<StatusSnapshot> {
    const settings = await this.#ensureSettings()
    return buildStatus({
      settings,
      health: this.#health.snapshot(),
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
        this.#onHttpResponse(report)
        return
      case "idle":
        await this.#onIdle(settings)
        return
    }
  }

  // ---------- admission ----------

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
    // A superseding start closes the previous episode — release its
    // per-unit bookkeeping (ledger marks, veto budget) too.
    this.#afterUnitClose(opened)
    try {
      await this.#routeAdmission(unit, settings)
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
  ): Promise<{ routing: RoutingDecision; decision: ReturnType<typeof admit> }> {
    const routing = resolveRouting({
      ...(settings.pin !== null ? { pin: settings.pin } : {}),
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
    for (const candidate of inventory) {
      const ref = candidateRef(candidate)
      const mapKey = schedulerHealthKey(ref)
      health[mapKey] = this.#health.assess(refKey(ref))
      const assessment = this.#capacity.assessment(refKey(ref))
      if (assessment.kind === "estimate") capacity[mapKey] = assessment.signals
    }
    const input: SchedulerInput = {
      routing,
      demand: {} satisfies Demand,
      inventory,
      tierCandidates,
      health,
      capacity,
    }
    return { routing, decision: admit(input) }
  }

  async #routeAdmission(unit: ActiveUnit, settings: SettingsV1): Promise<void> {
    const { routing, decision } = await this.#admit(settings, unit.sessionID)
    // The tier the unit was admitted under is escalation context (ADP-015);
    // recorded for every tiered routing outcome (including a defer, which
    // still names the tier it could not honor).
    if (routing.kind !== "pin") {
      this.#admissionTiers.set(unit.id, routing.tier)
    }
    const wrapped = schedulerForMode(decision, settings.mode)
    if (wrapped.kind === "apply") {
      await this.#applyModel(unit, wrapped)
      return
    }
    // Observe-only records the identical decision; defer and park leave the
    // episode on OpenCode's own model (admission cannot hold an episode).
    const tier = routing.kind === "pin" ? undefined : routing.tier
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
    const plan = planEscalation({
      currentModel: model,
      currentTier: admissionTier,
      nextTierResources: next !== undefined ? settings.tiers[next] : [],
      evidence,
      budget: { used: escalationUsed, max: MAX_ESCALATIONS_PER_UNIT },
    })
    const wrapped = schedulerForMode(plan, settings.mode)
    if (wrapped.kind === "escalate") {
      this.#escalations.set(unitID, escalationUsed + 1)
      await this.#recordReceipt({
        sessionID: report.sessionID,
        unitID,
        tier: wrapped.tier,
        decision: wrapped,
      })
      // Continue the interrupted work on the escalated resource; the unit is
      // terminally failed, so an ops failure is only logged (never parked).
      try {
        await this.#ownRecovery(report.sessionID, wrapped.target)
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
      await this.#attachOutcome(unit, { status: "interrupted", reason })
    }
  }

  /** Bounded per-unit bookkeeping once the tracker closed the unit. */
  #afterUnitClose(closed: ApplyResult): void {
    const unitID =
      closed.kind === "closed"
        ? closed.unit.id
        : closed.kind === "opened"
          ? closed.superseded?.id
          : undefined
    if (unitID !== undefined) {
      this.#ledger.forget(unitID)
      this.#vetoes.delete(unitID)
      this.#escalations.delete(unitID)
      this.#admissionTiers.delete(unitID)
      this.#escalationEvidence.delete(unitID)
    }
  }

  // ---------- http evidence ----------

  #onHttpResponse(report: EventReport & { kind: "http-response" }): void {
    if (report.capturedHeaders !== undefined) {
      this.#codex.observe(report.capturedHeaders, this.#options.clock())
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
    try {
      const { routing, decision } = await this.#admit(settings, input.sessionID)
      routingTier = routing.kind === "pin" ? undefined : routing.tier
      if (decision.kind === "apply") {
        recovery = {
          kind: "switch",
          model: decision.model,
          ...(decision.evidence.probeId !== undefined
            ? { probeId: decision.evidence.probeId }
            : {}),
        }
      }
    } catch (error) {
      logFailOpen("recovery", error)
    }

    const unitID = this.#tracker.active(input.sessionID)?.id
    const vetoesUsed = unitID !== undefined ? (this.#vetoes.get(unitID) ?? 0) : 0
    const core = decideRetry({
      classification,
      native: input.decision,
      recovery,
      vetoesUsed,
    })
    const wrapped = retryForMode(core, settings.mode)
    if (wrapped.kind !== "veto") return
    input.decision = { retry: false }
    if (unitID !== undefined) {
      this.#vetoes.set(unitID, vetoesUsed + 1)
    }
    void this.#ownRecovery(input.sessionID, wrapped.model)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        logFailOpen("recovery-ops", error)
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

  /** Owned horizontal recovery: settle → switch → continue from session state. */
  async #ownRecovery(sessionID: string, model: ModelRef): Promise<void> {
    const alive = await this.#isSessionAlive(sessionID)
    const recovery: RecoveryOption = { kind: "switch", model }
    const action = planContinuation({
      recovery,
      sideEffects: true,
      continuationPossible: alive,
    })
    const prompts: ContinuationPrompts = { continuation: CONTINUATION_PROMPT, original: "" }
    await executeContinuation({ sessionID, action, sideEffects: true, prompts, ops: this.#ops })
  }

  // ---------- parked-work resume (safe boundary: idle) ----------

  async #onIdle(settings: SettingsV1): Promise<void> {
    const records = this.#parked.list()
    if (records.length === 0) return
    const alive = new Map<string, boolean>()
    for (const sessionID of new Set(records.map((record) => record.sessionID))) {
      alive.set(sessionID, await this.#isSessionAlive(sessionID))
    }
    const plan = selectResumable(records, {
      tierConfigured: (tier) => configuredTiers(settings).includes(tier),
      sessionAlive: (sessionID) => alive.get(sessionID) === true,
    })
    for (const dropped of plan.drop) {
      await this.#dropParked(dropped)
    }
    for (const record of plan.attempt) {
      await this.#resumeAttempt(record, settings)
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
    let decision: ReturnType<typeof admit>
    try {
      decision = (await this.#admit(settings, record.sessionID)).decision
    } catch (error) {
      logFailOpen("resume", error)
      return
    }
    if (settings.mode === "observe") {
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
    try {
      await this.#ops.prompt(record.sessionID, CONTINUATION_PROMPT)
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
      await this.#parked.park({ ...record, parkedAt: this.#options.clock() })
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
  return {
    providerID: ref.providerID,
    modelID: ref.id,
    ...(ref.variant !== undefined ? { variantID: ref.variant } : {}),
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
