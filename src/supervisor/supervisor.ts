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
 *   never escalate, and the per-task budget is finite.
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
import { isTierName, nextTier } from "../core/tier-policy/types.js"
import type { RoutingDecision, TierName, TierRequest } from "../core/tier-policy/types.js"
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
import { TierRequestStore, TIER_REQUESTS_KEY } from "../state/tier-requests/index.js"
import { ReceiptStore, RECEIPTS_KEY } from "../state/receipts/index.js"
import type { Receipt, ReceiptInput, ReceiptOutcome } from "../state/receipts/types.js"
import { buildStatus } from "../rpc/status.js"
import type { StatusSnapshot } from "../rpc/status.js"
import { RECEIPTS_VIEW_LIMIT } from "./view.js"
import { ParkedWorkStore, PARKED_KEY } from "../state/parked-work/index.js"
import type { ParkedRecord } from "../state/parked-work/types.js"
import {
  decideRetry,
  earliestUsable,
  executeContinuation,
  forMode as retryForMode,
  MAX_PARKED_ATTEMPTS,
  planContinuation,
  planWake,
  resourceUsableAt,
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

import { TIERS } from "../core/tier-policy/types.js"

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

/** Finite per-task escalation budget (ADP-017). */
const MAX_ESCALATIONS_PER_TASK = 2

/**
 * The recovery's post-settle guard aborted it (the session went OFF or the
 * user interrupted while the host settle was in flight). Callers use it to
 * skip the ordinary ops-failure degradation (parking) — an aborted recovery
 * is a steering change, not an infrastructure failure.
 */
export class RecoveryAbortedError extends Error {
  constructor(sessionID: string) {
    super(`recovery aborted for session ${sessionID}`)
    this.name = "RecoveryAbortedError"
  }
}

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
  /**
   * Escalations spent per session on the current task (one user prompt and
   * the owned continuations it spawns). Keyed by session, not unit: every
   * escalation continues on a NEW unit, so a per-unit count would restart
   * the budget at each step. A fresh user prompt starts a new task.
   */
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
   * across many units in one task. Persisted like the session-mode
   * overrides: the host's double plugin instance (hooks vs RPC) must not
   * strand a request on the instance that never routes.
   */
  readonly #tierRequests: TierRequestStore
  /**
   * Sessions whose last model change was the user's own pick
   * (`selected-external`): prompt admission does not re-route them —
   * switching would undo the user's `/model` choice (ADP-028). Cleared by an
   * adaptive switch, a tier request, or a mode change; a standing settings
   * pin overrides the suppression (the pin is manual intent too).
   */
  static readonly MAX_MANUAL_SELECTIONS = 1024
  readonly #manualSelections = new Map<string, true>()
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
   * Sessions with an owned recovery in flight (between veto/resume and the
   * delivered continuation prompt). The host settle inside it can take
   * unbounded time; an interruption arriving during that window must abort
   * the stale decision instead of acting after it. The value settles when
   * the recovery does (it never rejects).
   */
  readonly #recoveryPending = new Map<string, Promise<void>>()
  /**
   * Units opened by an owned continuation's prompt. Such a unit can fail
   * before the recovery that started it returns from its prompt call; its
   * terminal failure is its own, not an echo of the superseded unit.
   * Cleared at unit close.
   */
  readonly #continuationUnits = new Set<string>()
  /** Snapshot-sized budget shared by a task's terminal quota continuations. */
  readonly #quotaRecoveriesRemaining = new Map<string, number>()
  /** Interruptions observed while a recovery was pending on the session. */
  readonly #recoveryInterrupted = new Set<string>()
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
   * Per-unit dedup for breaker failure evidence (ADP-019). One failed attempt
   * surfaces through up to three host signals — the pumped `http.response`
   * event, the `retry` hook (the same request), and the terminal
   * `execution-failed` (the last attempt) — and counting each would trip the
   * breaker after ~2 real failures instead of `failureThreshold`. The exact
   * arrival order of a pair is not guaranteed (the retry hook runs in the
   * request lifecycle, the event pump lags), so the dedup is order-symmetric:
   * the first signal of a pair counts and arms, the matching counterpart
   * consumes it, a completed pair closes the attempt, and the terminal
   * repeats only when the last attempt left no live evidence. A same-category
   * observation with nothing armed is a NEW attempt (consecutive http-only
   * failures each count). Cleared at unit close.
   */
  readonly #attemptFailures = new Map<
    string,
    {
      http?: FailureCategory | undefined
      retry?: FailureCategory | undefined
      closed?: FailureCategory | undefined
    }
  >()
  /**
   * Session → tier admitted by the prompt hook for the unit that is about to
   * open. Consumed by execution-started, which then skips re-routing (the
   * model is already applied to the very turn that triggered admission).
   */
  readonly #promptAdmission = new Map<string, { tier?: TierName; continuation?: true }>()
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
  /**
   * Parked-work wake (ADP-024): idle only follows successful work, so when a
   * whole tier is blocked one timer stands in for the safe boundary at the
   * earliest moment a candidate resource recovers. `dueAt` may lie past the
   * timer when the delay was capped — an early fire only re-arms.
   */
  #wake: { readonly cancel: () => void; readonly dueAt: number } | undefined
  /** Consecutive wake sweeps that resumed nothing (backs the timer off). */
  #fruitless = 0
  #disposed = false
  /**
   * Whether this instance receives host reports. The host's other plugin
   * instance (ADP-056) never does: its in-memory health is only what it
   * hydrated, so it re-reads persisted health before a wake sweep.
   */
  #live = false
  /**
   * Session → resume cycles spent on its current task: a resumed unit that
   * parks again carries the count, so park → wake → fail loops stay bounded
   * by MAX_PARKED_ATTEMPTS. Cleared on success or a fresh user prompt.
   */
  readonly #resumeCycles = new Map<string, number>()
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
    this.#tierRequests = new TierRequestStore(
      storageSeam(TIER_REQUESTS_KEY, options.storage),
      options.clock,
    )
    this.#ops = sessionOps(options.session, {
      beforeSwitch: (sessionID, model) => {
        this.#tracker.noteOwnSwitch(sessionID, model)
        options.ledger.noteSwitch(sessionID, model, options.clock())
      },
      switchFailed: (sessionID) => {
        options.ledger.withdrawSwitch(sessionID)
      },
      beforePrompt: (sessionID) => {
        // The other plugin instance may be the one that hears this prompt:
        // the ledger lets it recognize the continuation as Adaptive's.
        const tier = this.#continuationTiers.get(sessionID)
        const cycles = this.#resumeCycles.get(sessionID)
        options.ledger.noteContinuation(
          sessionID,
          { ...(tier === undefined ? {} : { tier }), ...(cycles === undefined ? {} : { cycles }) },
          options.clock(),
        )
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
            // open to carry it. The other instance's view of it goes too.
            this.#continuationPending.delete(sessionID)
            this.#continuationTiers.delete(sessionID)
            options.ledger.withdrawContinuation(sessionID)
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
      for (const record of this.#parked.list()) {
        bump(record.id)
        options.ledger.noteParked(record.sessionID)
      }
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
      // Tier requests hydrate the same way: a tier request recorded through
      // the host's other plugin instance (or before a restart) must still
      // steer this instance's admissions.
      await this.#tierRequests.load()
      await this.#capacityStore.load()
      return this.#settings.load()
    }
    this.#ready = loadState()
    // Parked work survives restarts; its wake must too.
    void this.#armWake()
  }

  /** Stop the wake timer; a disposed supervisor never re-arms it. */
  dispose(): void {
    this.#disposed = true
    this.#options.ledger.leave()
    this.#wake?.cancel()
    this.#wake = undefined
  }

  /**
   * This instance hears the host. The ledger ignores it from a disposed
   * instance (a late report during teardown), so the survivor still sweeps.
   */
  #markLive(): void {
    this.#live = true
    this.#options.ledger.markLive()
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
    this.#markLive()
    try {
      const settings = await this.#ensureSettings()
      // An OFF session is fully inert — no supervision, no receipts, no
      // health evidence. Idle is the exception: it is the bookkeeping
      // boundary (parked-work sweep, dead-session override pruning) and runs
      // for every report so other sessions' overrides are maintained; the
      // sweep itself gates per parked session below. A prompt still marks
      // the user taking the session over (its parked work is dropped).
      if (
        report.kind !== "idle" &&
        report.kind !== "prompt" &&
        this.#modeFor(report.sessionID, settings) === "off"
      )
        return
      await this.#dispatch(report, settings)
    } catch (error) {
      logFailOpen("report", error)
    }
  }

  /** Marks the session's manual-selection state from an external selection event. */
  #noteManualSelection(sessionID: string): void {
    if (
      !this.#manualSelections.has(sessionID) &&
      this.#manualSelections.size >= Supervisor.MAX_MANUAL_SELECTIONS
    ) {
      // The guard above ensures the map is at its cap (>= 1 entries), so the
      // first key always exists; the assertion avoids a branch the coverage
      // gate would reject as unreachable.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const oldest = this.#manualSelections.keys().next().value!
      this.#manualSelections.delete(oldest)
    }
    this.#manualSelections.set(sessionID, true)
  }

  /**
   * True while the session's last model change was the user's own pick.
   * A standing settings pin is explicit manual intent as well (ADP-002):
   * honoring it does not fight the pick, so suppression is skipped there.
   */
  #manuallySelected(sessionID: string, settings: SettingsV1): boolean {
    return settings.pin === null && this.#manualSelections.has(sessionID)
  }

  /**
   * The manual-pick suppression actually applied at an admission. It yields
   * when the picked model is health-blocked: keeping the session on a
   * quarantined resource does not honor the pick — the configured fallback
   * takes over instead (the pick is re-honored only if the user picks again).
   * Uses the non-mutating evaluation, never a probe admission.
   */
  #manualSuppressionHolds(sessionID: string, settings: SettingsV1): boolean {
    if (!this.#manuallySelected(sessionID, settings)) return false
    const current = this.#tracker.lastModel(sessionID)?.model
    if (current === undefined) return true
    if (this.#health.evaluate(refKey(current)).kind !== "blocked") return true
    this.#manualSelections.delete(sessionID)
    return false
  }

  /**
   * Handle one `retry` hook invocation. On a veto this mutates
   * `input.decision` to `{ retry: false }`; otherwise the decision is left
   * untouched and OpenCode's native retry policy stands.
   */
  async handleRetry(input: RetryHookInput): Promise<void> {
    this.#markLive()
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
   *
   * Fire-and-forget persistence: the recorder signature is sync on both the
   * tool and the RPC source interfaces, so the write is enqueued without
   * awaiting it. Readers (routing, getTierRequest, the idle sweep) flush the
   * store's queue before reading, which makes the record visible
   * deterministically; a write failure drops the record fail-open (the tool
   * told the agent "recorded", the persisted mirror simply never sees it —
   * the same degradation the in-memory map had on restart).
   */
  noteTierRequest(sessionID: string, tier: string): boolean {
    if (!isTierName(tier)) return false
    void this.#tierRequests.set(sessionID, tier).catch(() => undefined)
    // The user/agent explicitly asked Adaptive to route again (ADP-028).
    this.#manualSelections.delete(sessionID)
    return true
  }

  /** The session's tier request, or `null` when it follows the routing ladder. */
  async getTierRequest(sessionID: string): Promise<TierName | null> {
    await this.#ready
    // A fire-and-forget note may still be in the queue: flush before reading.
    await this.#tierRequests.flush()
    return this.#tierRequests.get(sessionID)
  }

  /** Clear one session's tier request (`null` is the only valid input). */
  async setTierRequest(sessionID: string, tier: TierName | null): Promise<void> {
    await this.#ready
    if (tier !== null) throw new Error("only null clears a tier request")
    await this.#tierRequests.set(sessionID, null)
    // Clearing through the control surface is the user asking Adaptive back.
    this.#manualSelections.delete(sessionID)
  }

  // ---------- state API for the control surfaces (ADP-033/034/036) ----------

  /** Current settings (awaits the constructor load). */
  async settings(): Promise<SettingsV1> {
    return this.#ensureSettings()
  }

  /** Validate and persist a settings patch; returns per-field errors. */
  async updateSettings(patch: SettingsPatch): Promise<PatchResult> {
    await this.#ready
    const result = await this.#settings.update(patch)
    if (result.ok && patch.mode !== undefined) {
      // A global mode change is the user steering Adaptive explicitly
      // (ADP-028): manual-selection suppression lifts for every session.
      this.#manualSelections.clear()
    }
    // Mode and tier changes move which parked work is due and when.
    if (result.ok) await this.#rearmWake()
    return result
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
    // A mode change is the user steering Adaptive explicitly (ADP-028).
    this.#manualSelections.delete(sessionID)
    await this.#rearmWake()
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
    // Parked work too: the other instance may have parked or resumed it.
    await this.#parked.refresh()
    const now = this.#options.clock()
    const { records, capacity, usableAt } = await this.#persistedView(settings, now)
    // The wake that will actually resume the session may come later than the
    // reset (backoff after fruitless wakes). It is this instance's own when
    // it sweeps, else the one the live instance published.
    const { ledger } = this.#options
    const wakeAt = this.#live || !ledger.liveElsewhere() ? this.#wake?.dueAt : ledger.liveWake()
    const waiting = this.#parked
      .list()
      .filter((record) => this.#wakeable(record, settings))
      .map((record) => {
        const usable = parkedResumeAt(record, settings, usableAt)
        return {
          sessionID: record.sessionID,
          tier: record.tier,
          resumeAt: usable === undefined ? null : Math.max(usable, wakeAt ?? usable),
        }
      })
    return buildStatus({
      settings,
      health: records,
      capacity,
      parked: this.#parked.count(),
      waiting,
      receipts: this.#receipts.snapshot().length,
    })
  }

  /**
   * Health and capacity as persisted by every instance, with when each ref
   * becomes usable. The status surface reads this (its instance's registry
   * can be empty when the host placed the event pump on another instance),
   * and so does the wake of an instance that hears no host reports.
   */
  async #persistedView(
    settings: SettingsV1,
    now: number,
  ): Promise<{
    records: ResourceRecord[]
    capacity: Record<string, CapacityReading | null>
    usableAt: (ref: ModelRef) => number | undefined
  }> {
    await this.#healthRecords.load()
    await this.#capacityStore.load()
    const records = this.#healthRecords.snapshot().map((record) => sweepRecord(record, now))
    const recordsByID = new Map(records.map((record) => [resourceKeyID(record.key), record]))
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
    const usableAt = (ref: ModelRef): number | undefined =>
      resourceUsableAt(
        resourceChain(refKey(ref)).map((key) => recordsByID.get(resourceKeyID(key))),
        capacity[schedulerHealthKey(ref)] ?? null,
        now,
      )
    return { records, capacity, usableAt }
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
      case "model-selected": {
        const result = this.#tracker.apply({
          kind: "model-selected",
          sessionID: report.sessionID,
          at: report.at,
          model: report.model,
        })
        // Whether the change was the user's pick or Adaptive's own switch
        // decides who controls the session's model (ADP-028); the result
        // carries the attribution the tracker resolved. Only the two
        // selection sources reach this event kind.
        const { source } = result.transition
        if (
          source === "selected-adaptive" ||
          // The host's other plugin instance (ADP-056) may have switched it.
          this.#options.ledger.takeSwitch(report.sessionID, report.model, this.#options.clock())
        ) {
          this.#manualSelections.delete(report.sessionID)
          return
        }
        this.#noteManualSelection(report.sessionID)
        await this.#takeOver(report.sessionID)
        return
      }
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
        // Only the agent loop's own request reports the model actually
        // executing the unit's work. An auxiliary request (title, compaction,
        // generate — ADP-027) carries the host's own cheap pick for that side
        // request; adopting it as the session's model would misattribute the
        // primary unit's health evidence and leave the next admission
        // believing the unit runs on the wrong resource.
        if (report.requestKind === "primary") {
          this.#tracker.apply({
            kind: "model-request",
            sessionID: report.sessionID,
            at: this.#options.clock(),
            model: report.model,
          })
        }
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
    const own = this.#continuationPending.delete(sessionID)
    // The host's other plugin instance (ADP-056) may have sent it.
    const foreign = own
      ? undefined
      : this.#options.ledger.takeContinuation(sessionID, this.#options.clock())
    if (mode !== "active") {
      // An OFF or OBSERVE session is not routed, but the user's own turn
      // there still supersedes its parked work: turning Adaptive back on
      // must not replay a continuation the user has moved past.
      if (!own && foreign === undefined) await this.#takeOver(sessionID)
      return
    }
    if (own || foreign !== undefined) {
      // An owned continuation (retry recovery, escalation, parked resume)
      // already owns this unit's routing: re-arm the admission marker from
      // the continuation's tier intent so execution-started skips a fresh
      // (continuation-unaware) admission.
      const tier = own ? this.#continuationTiers.get(sessionID) : foreign?.tier
      if (foreign?.cycles !== undefined) this.#resumeCycles.set(sessionID, foreign.cycles)
      this.#promptAdmission.set(sessionID, {
        ...(tier !== undefined ? { tier } : {}),
        continuation: true,
      })
      return
    }
    // Prompt hooks also admit steering messages into an active episode. They
    // are not routing boundaries: switching here interrupts productive work
    // and resets its recovery budget before the host consumes the steering.
    if (this.#tracker.active(sessionID) !== undefined) return
    // A fresh user prompt cancels any stale continuation intent and marker:
    // this admission re-routes from scratch.
    this.#continuationTiers.delete(sessionID)
    this.#promptAdmission.delete(sessionID)
    this.#escalations.delete(sessionID)
    this.#quotaRecoveriesRemaining.delete(sessionID)
    await this.#takeOver(sessionID)
    // A pending probe ticket from an earlier prompt admission (or a failed
    // recovery) can only be carried by the unit the ORIGINAL prompt opens;
    // a fresh admission means that episode never ran, so the ticket is
    // released here instead of being adopted by whichever unit opens next.
    const stale = this.#sessionProbeTickets.get(sessionID)
    if (stale !== undefined) {
      this.#sessionProbeTickets.delete(sessionID)
      this.#health.releaseProbe(stale)
    }
    if (this.#manualSuppressionHolds(sessionID, settings)) {
      // ADP-028: the user's own model pick stands (yielded to health if the
      // picked resource is quarantined). Recording the defer (no switch, no
      // marker) leaves OpenCode's choice — the picked model — in place;
      // execution-started will skip routing the same way.
      await this.#recordReceipt({
        sessionID,
        decision: { kind: "defer", reason: "routing-defer", detail: "manual-selection" },
      })
      return
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
      // switch threw): no unit will ever carry the ticket, so release it.
      if (probeTicket !== undefined) {
        this.#health.releaseProbe(probeTicket)
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
    // A run Adaptive did not continue — the user's shell or slash command
    // skips the prompt hook — moves the session past any resume waiting to
    // settle on it.
    if (admitted?.continuation !== true) this.#options.ledger.noteTakeover(report.sessionID)
    // A superseding start closes the previous episode — release its
    // per-unit bookkeeping (veto budget) too.
    this.#afterUnitClose(opened)
    // The prompt hook already admitted and applied for this unit — carry the
    // tier into escalation context and skip re-routing.
    if (admitted !== undefined) {
      this.#promptAdmission.delete(report.sessionID)
      this.#continuationTiers.delete(report.sessionID)
      if (admitted.tier !== undefined) this.#admissionTiers.set(unit.id, admitted.tier)
      if (admitted.continuation === true) this.#continuationUnits.add(unit.id)
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
    requiredTier?: TierName,
  ): Promise<{
    routing: RoutingDecision
    decision: ReturnType<typeof admit>
    probeTicket?: ProbeTicket
  }> {
    // The agent-declared tier request (adaptive_tier tool) outranks the
    // role hints but stays below the pin (ADP-002 ladder). The note is
    // recorded fire-and-forget, so flush the store's queue before reading.
    await this.#tierRequests.flush()
    const tierRequest = this.#tierRequests.get(sessionID)
    let routedTier: TierRequest | undefined
    if (requiredTier !== undefined) {
      routedTier = { tier: requiredTier, via: "manual-command" as const }
    } else if (tierRequest !== null) {
      routedTier = { tier: tierRequest, via: "manual-command" as const }
    }
    const routing = resolveRouting({
      ...(settings.pin !== null ? { pin: settings.pin } : {}),
      ...(routedTier !== undefined ? { tierRequest: routedTier } : {}),
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
    // Tickets issued by this assessment sweep (see the release below).
    const issued: ProbeTicket[] = []
    // Only the routed candidates are assessed: assess flips a due breaker to
    // half_open, and admitting a quick unit has no business touching an
    // advanced-tier resource's breaker.
    const routed = routing.kind === "pin" ? [routing.model] : tierCandidates
    for (const ref of routed) {
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
    // including candidates this decision passed over (an earlier ready
    // candidate wins) or dispatched nothing for (defer/park). An
    // issued-but-undispatched probe would wedge its resource in half_open:
    // no unit ever carries the ticket. Release each unselected ticket — it
    // stays due, because a probe that never ran is no health evidence and
    // restarting its backoff would push it back on every admission.
    const selectedId = decision.kind === "apply" ? decision.evidence.probeId : undefined
    let probeTicket: ProbeTicket | undefined
    for (const ticket of issued) {
      if (selectedId !== undefined && ticket.id === selectedId) {
        probeTicket = ticket
      } else {
        this.#health.releaseProbe(ticket)
      }
    }
    return { routing, decision, ...(probeTicket !== undefined ? { probeTicket } : {}) }
  }

  async #routeAdmission(
    unit: ActiveUnit,
    settings: SettingsV1,
    mode: OperatingMode,
  ): Promise<void> {
    if (this.#manualSuppressionHolds(unit.sessionID, settings)) {
      // ADP-028: the session runs on the user's own pick (yielded to health
      // if the picked resource is quarantined) — no re-route.
      await this.#recordReceipt({
        sessionID: unit.sessionID,
        unitID: unit.id,
        decision: { kind: "defer", reason: "routing-defer", detail: "manual-selection" },
      })
      return
    }
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
        // release the ticket instead of wedging the resource half-open.
        if (probeTicket !== undefined) {
          this.#health.releaseProbe(probeTicket)
        }
        throw error
      }
      if (probeTicket !== undefined) this.#probeTickets.set(unit.id, probeTicket)
      return
    }
    if (probeTicket !== undefined) {
      // OBSERVE wraps an apply — including a probe admission — without
      // running it: no episode will ever report the ticket, so release it.
      this.#health.releaseProbe(probeTicket)
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
    const probeTicket = this.#takeProbeTicket(unit?.id)
    const closed = this.#tracker.apply({
      kind: "execution-succeeded",
      sessionID: report.sessionID,
      at: report.at,
    })
    this.#afterUnitClose(closed)
    this.#resumeCycles.delete(report.sessionID)
    if (model !== undefined) {
      this.#observeHealth({ kind: "success", key: refKey(model) })
    }
    if (unit !== undefined) {
      if (probeTicket !== undefined) {
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
    // The tier is read before the close clears the per-unit maps.
    const admissionTier = unitID !== undefined ? this.#admissionTiers.get(unitID) : undefined
    const escalationUsed = this.#escalations.get(report.sessionID) ?? 0
    // Tool evidence is captured pre-close like the other per-unit maps.
    const toolEvidence = unitID !== undefined ? (this.#escalationEvidence.get(unitID) ?? []) : []
    const probeTicket = this.#takeProbeTicket(unitID)
    // A vetoed continuation unit's failure is an echo: its own veto owns the
    // next continuation.
    const continuation =
      unitID !== undefined && this.#continuationUnits.has(unitID) && !this.#vetoes.has(unitID)
    // The terminal classifies and dedups BEFORE the close: the close clears
    // the unit's attempt-failure entry, and the terminal must consult it —
    // it repeats the episode's last attempt, which an attempt signal
    // (http-response or retry hook) already counted.
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
      // The retry hook passes text only to refine a 429's window.
      text: report.error.message,
    })
    const countTerminal = this.#countTerminalFailure(unitID, classification.category)
    const closed = this.#tracker.apply({
      kind: "execution-failed",
      sessionID: report.sessionID,
      at: report.at,
      error: report.error,
    })
    this.#afterUnitClose(closed)
    if (model !== undefined && countTerminal) {
      this.#observeHealth(failureEvent(refKey(model), classification))
    }
    if (unit !== undefined) {
      await this.#attachOutcome(unit, { status: "failed", category: classification.category })
      if (probeTicket !== undefined) {
        this.#reportProbeOutcome(probeTicket, { success: false, category: classification.category })
      }
    }
    if (
      unit !== undefined &&
      model !== undefined &&
      classification.category === "quota_exhausted"
    ) {
      await this.#recoverTerminalQuota(unit, admissionTier, continuation, settings)
      return
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

  async #recoverTerminalQuota(
    unit: ActiveUnit,
    requiredTier: TierName | undefined,
    continuation: boolean,
    settings: SettingsV1,
  ): Promise<void> {
    const sessionID = unit.sessionID
    // The continuation unit itself can run out of quota before the recovery
    // that started it returns from its prompt call. Its failure is its own:
    // wait for that recovery to settle, then recover (or park) like any unit.
    if (continuation) await this.#recoveryPending.get(sessionID)
    // Otherwise a pending continuation owns the session (a retry veto's
    // terminal echo must not start another). OBSERVE computes the same
    // admission without applying it.
    const mode = this.#modeFor(sessionID, settings)
    if (
      mode === "off" ||
      this.#recoveryPending.has(sessionID) ||
      this.#continuationTiers.has(sessionID) ||
      this.#continuationPending.has(sessionID)
    )
      return
    if (mode === "active") this.#manualSuppressionHolds(sessionID, settings)
    const { routing, decision, probeTicket } = await this.#admit(settings, sessionID, requiredTier)
    const tier = routingTier(routing)
    if (mode === "observe") {
      if (probeTicket !== undefined) this.#health.releaseProbe(probeTicket)
      await this.#recordReceipt({ sessionID, tier, decision: schedulerForMode(decision, mode) })
      return
    }
    // Quota windows can expire while session.wait is pending. Snapshot the
    // configured ladder length once so even those recoveries cannot loop.
    const remaining =
      this.#quotaRecoveriesRemaining.get(sessionID) ??
      (tier === undefined ? 0 : settings.tiers[tier].length)
    if (decision.kind === "apply" && remaining === 0) {
      if (probeTicket !== undefined) this.#health.releaseProbe(probeTicket)
      // The ladder is spent but the work is not done: park it so the wake
      // resumes it with a fresh budget instead of leaving the session stuck.
      if (tier !== undefined) {
        await this.#recordReceipt({
          sessionID,
          tier,
          decision: { kind: "park", reason: "all-blocked", detail: "quota recovery budget spent" },
        })
        await this.#parkUnit(unit.id, sessionID, tier, "quota exhausted")
      }
      return
    }
    await this.#recordReceipt({ sessionID, tier, decision })
    if (decision.kind !== "apply") {
      if (decision.kind === "park" && tier !== undefined) {
        await this.#parkUnit(unit.id, sessionID, tier, "quota exhausted")
      }
      return
    }
    this.#quotaRecoveriesRemaining.set(sessionID, remaining - 1)
    if (probeTicket !== undefined) this.#sessionProbeTickets.set(sessionID, probeTicket)
    // The host rejected this attempt without invoking its retry hook. Continue
    // from durable session state rather than waiting for another user message.
    void this.#ownRecovery(
      sessionID,
      decision.model,
      tier,
      () => this.#modeFor(sessionID, this.#settings.get()) === "active",
    ).catch((error: unknown) => {
      if (probeTicket !== undefined && this.#sessionProbeTickets.get(sessionID) === probeTicket) {
        this.#sessionProbeTickets.delete(sessionID)
        this.#health.releaseProbe(probeTicket)
      }
      if (!(error instanceof RecoveryAbortedError)) logFailOpen("quota-recovery", error)
    })
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
    // Compared by resource key: the host reports base-model calls as variant
    // "default", which is the same resource as the bare tier entry.
    const failedID = resourceKeyID(refKey(failed))
    for (const ref of refs) {
      if (resourceKeyID(refKey(ref)) === failedID) continue
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
      budget: { used: escalationUsed, max: MAX_ESCALATIONS_PER_TASK },
    })
    const wrapped = schedulerForMode(plan, this.#modeFor(report.sessionID, settings))
    if (wrapped.kind === "escalate") {
      this.#escalations.set(report.sessionID, escalationUsed + 1)
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
        await this.#ownRecovery(
          report.sessionID,
          wrapped.target,
          wrapped.tier,
          () => this.#modeFor(report.sessionID, settings) !== "off",
        )
      } catch (error) {
        if (!(error instanceof RecoveryAbortedError)) logFailOpen("escalation-ops", error)
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
    const probeTicket = this.#takeProbeTicket(unit?.id)
    // The user cancelling is the user steering: a resume waiting on this
    // session (on either instance) drops its work instead of re-parking it.
    if (reason === "user") this.#options.ledger.noteTakeover(report.sessionID)
    // An interruption while a recovery is pending on this session aborts it
    // at its post-settle guard (the pending recovery's decision predates the
    // interruption and must not act after it).
    if (this.#recoveryPending.has(report.sessionID)) {
      this.#recoveryInterrupted.add(report.sessionID)
    }
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

  /**
   * One attempt's failure evidence (http-response event or retry hook):
   * returns whether THIS observation is the attempt's first count.
   */
  #countAttemptFailure(
    unitID: string | undefined,
    source: "http" | "retry",
    category: FailureCategory,
  ): boolean {
    if (unitID === undefined) return true
    const ev = this.#attemptFailures.get(unitID) ?? {}
    if (source === "http" ? ev.retry === category : ev.http === category) {
      // The other host signal already counted this attempt: consume it.
      const closed = { ...ev, http: undefined, retry: undefined, closed: category }
      this.#attemptFailures.set(unitID, closed)
      return false
    }
    this.#attemptFailures.set(
      unitID,
      source === "http" ? { ...ev, http: category } : { ...ev, retry: category },
    )
    return true
  }

  /**
   * The terminal `execution-failed` repeats the episode's last attempt: it
   * counts only when the last attempt left no live evidence (e.g. a
   * capability failure that never produced an HTTP response or retry hook).
   */
  #countTerminalFailure(unitID: string | undefined, category: FailureCategory): boolean {
    if (unitID === undefined) return true
    const ev = this.#attemptFailures.get(unitID) ?? {}
    if (ev.http === category) {
      this.#attemptFailures.set(unitID, { ...ev, http: undefined })
      return false
    }
    if (ev.retry === category) {
      this.#attemptFailures.set(unitID, { ...ev, retry: undefined })
      return false
    }
    if (ev.closed === category) {
      this.#attemptFailures.set(unitID, { ...ev, closed: undefined })
      return false
    }
    this.#attemptFailures.set(unitID, { ...ev, closed: category })
    return true
  }

  /**
   * Hands a closing unit's probe ticket to its explicit outcome reporter.
   * Taken BEFORE the close: #afterUnitClose treats any ticket still held as
   * lost and re-opens the breaker, which would turn a probe's real outcome
   * into a stale report.
   */
  #takeProbeTicket(unitID: string | undefined): ProbeTicket | undefined {
    if (unitID === undefined) return undefined
    const ticket = this.#probeTickets.get(unitID)
    this.#probeTickets.delete(unitID)
    return ticket
  }

  /** Bounded per-unit bookkeeping once the tracker closed the unit. */
  #afterUnitClose(closed: ApplyResult): void {
    const unitID = closedUnitID(closed)
    if (unitID !== undefined) {
      this.#vetoes.delete(unitID)
      this.#continuationUnits.delete(unitID)
      this.#admissionTiers.delete(unitID)
      this.#escalationEvidence.delete(unitID)
      const leftover = this.#probeTickets.get(unitID)
      if (leftover !== undefined) {
        // The explicit outcome reporters take their ticket before this
        // cleanup; reaching here means the unit ended without one
        // (superseded or lost).
        this.#reportProbeOutcome(leftover, { success: false, category: "user_cancelled" })
        this.#probeTickets.delete(unitID)
      }
    }
    if (closed.kind === "opened" || closed.kind === "closed") {
      const unitID = closedUnitID(closed)
      if (unitID !== undefined) {
        this.#attemptFailures.delete(unitID)
      }
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
    // The retry hook classifies the same request for the host's retry
    // decision; counting both would double every attempt (ADP-019).
    if (this.#countAttemptFailure(unit?.id, "http", classification.category)) {
      this.#observeHealth(failureEvent(refKey(model), classification))
    }
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
      // Text only refines a definitive 429's window (rate limit vs spent
      // quota); every other retry classification stays structural.
      ...(input.error.status === 429 ? { text: input.error.message } : {}),
    })
    const unitID = this.#tracker.active(input.sessionID)?.id
    // The pumped http-response event describes the same failed request;
    // counting both would double every attempt (ADP-019).
    if (this.#countAttemptFailure(unitID, "retry", classification.category)) {
      this.#observeHealth(failureEvent(refKey(input.model), classification))
    }

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
      // admitted probe has no continuation to report it — release it here or
      // the resource wedges half-open.
      if (probeTicket !== undefined) {
        this.#health.releaseProbe(probeTicket)
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
      // episode can no longer claim this slot) — release it before replacing.
      const stale = this.#sessionProbeTickets.get(input.sessionID)
      if (stale !== undefined && stale !== probeTicket) {
        this.#health.releaseProbe(stale)
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
    void this.#ownRecovery(
      input.sessionID,
      wrapped.model,
      routingTier,
      () => this.#modeFor(input.sessionID, settings) !== "off",
    )
      .then(() => undefined)
      .catch(async (error: unknown) => {
        if (error instanceof RecoveryAbortedError) {
          // The user steered away (interruption / OFF) during the settle: the
          // veto stands, but no continuation episode will ever carry the
          // probe it admitted — release it instead of wedging half-open.
          if (
            probeTicket !== undefined &&
            this.#sessionProbeTickets.get(input.sessionID) === probeTicket
          ) {
            this.#sessionProbeTickets.delete(input.sessionID)
            this.#health.releaseProbe(probeTicket)
          }
          return
        }
        logFailOpen("recovery-ops", error)
        // The recovery rejected before (or while) delivering its continuation
        // prompt, so no unit will ever carry the probe it admitted — release
        // it instead of wedging the resource half-open.
        if (
          probeTicket !== undefined &&
          this.#sessionProbeTickets.get(input.sessionID) === probeTicket
        ) {
          this.#sessionProbeTickets.delete(input.sessionID)
          this.#health.releaseProbe(probeTicket)
        }
        if (unitID === undefined || routingTier === undefined) return
        await this.#parkUnit(unitID, input.sessionID, routingTier, "continuation failed")
      })
  }

  /**
   * Owned horizontal recovery: settle → switch → continue from session
   * state. `tier` is the continuation unit's routing tier — recorded so the
   * continuation's prompt hook re-arms the admission marker (the unit must
   * not be re-routed: that would discard the recovery/escalation decision).
   */
  #ownRecovery(
    sessionID: string,
    model: ModelRef,
    tier: TierName | undefined,
    stillValid: () => boolean,
  ): Promise<void> {
    const run = this.#continueSession(sessionID, model, tier, stillValid)
    // The guard window opens in the same tick the recovery starts (before
    // its first await completes) so an interrupt pumped during the admission
    // race is still seen.
    const pending = run.catch(() => undefined)
    this.#recoveryPending.set(sessionID, pending)
    return run.finally(() => {
      // A later recovery on the session owns the entry now.
      if (this.#recoveryPending.get(sessionID) === pending) this.#recoveryPending.delete(sessionID)
    })
  }

  async #continueSession(
    sessionID: string,
    model: ModelRef,
    tier: TierName | undefined,
    stillValid: () => boolean,
  ): Promise<void> {
    if (tier !== undefined) this.#continuationTiers.set(sessionID, tier)
    try {
      const alive = await this.#isSessionAlive(sessionID)
      const recovery: RecoveryOption = { kind: "switch", model }
      const action = planContinuation({
        recovery,
        continuationPossible: alive,
      })
      // executeContinuation settles first; the supervisor settles here so the
      // post-settle guard (mode OFF, user interruption) can abort before any
      // switch or prompt — the settle is the only step that can take
      // unbounded time, and a decision made before it may be stale after it.
      await this.#ops.settle(sessionID)
      if (!stillValid() || this.#recoveryInterrupted.delete(sessionID)) {
        throw new RecoveryAbortedError(sessionID)
      }
      // Already settled above; the action's own settle is a no-op.
      await executeContinuation({
        sessionID,
        action,
        ops: { ...this.#ops, settle: () => Promise.resolve() },
      })
    } catch (error) {
      // The continuation prompt never reached the host, so no unit will open
      // to consume the tier intent — drop it or it would pin the marker
      // wipes and mislabel a later user prompt's admission.
      if (tier !== undefined) this.#continuationTiers.delete(sessionID)
      throw error
    }
  }

  // ---------- parked-work resume (safe boundaries: idle, wake) ----------

  async #onIdle(settings: SettingsV1): Promise<void> {
    await this.#sweepParked(settings)
    await this.#armWake()
  }

  /**
   * The wake timer's safe boundary. Fires only when no unit of a parked
   * session can reach idle on its own; it runs the same sweep (same
   * safeguards) as idle, then re-plans. An early fire (capped delay) only
   * re-plans: no sweep, no receipts while a long window is still open.
   */
  async #onWake(dueAt: number, capped: boolean): Promise<void> {
    this.#setWake(undefined)
    try {
      const settings = await this.#ensureSettings()
      if (!this.#disposed && (!capped || this.#options.clock() >= dueAt)) {
        if (!this.#live && this.#options.ledger.liveElsewhere()) {
          // The instance that hears the host has current health and sees
          // the resumed unit's reports: it resumes, this one backs off.
          this.#fruitless += 1
        } else {
          if (!this.#live) {
            // No instance hears the host yet (fresh start): persisted health
            // is the only current evidence.
            await this.#healthRecords.load()
            this.#health.hydrate(this.#healthRecords.snapshot())
          }
          // A taken record's delivery settles the backoff itself.
          if (!(await this.#sweepParked(settings))) this.#fruitless += 1
        }
      }
    } catch (error) {
      logFailOpen("wake", error)
    }
    await this.#armWake()
  }

  /**
   * Plans the one wake timer from the parked work due for resume (ADP-024).
   * Never throws: a failed plan leaves parked work to the idle boundary.
   */
  async #armWake(): Promise<void> {
    try {
      const settings = await this.#ensureSettings()
      const now = this.#options.clock()
      // An instance that hears no host has no current health or capacity of
      // its own: it plans from what the live one persisted, as status does.
      const usableAt = this.#live
        ? (ref: ModelRef): number | undefined =>
            resourceUsableAt(
              resourceChain(refKey(ref)).map((key) => this.#health.recordFor(key)),
              this.#capacity.reading(refKey(ref)),
              now,
            )
        : (await this.#persistedView(settings, now)).usableAt
      // Disposal may land during either read above.
      if (this.#disposed) return
      const targets = this.#parked
        .list()
        .filter((record) => this.#wakeable(record, settings))
        .map((record) => parkedResumeAt(record, settings, usableAt))
      const plan = planWake(targets, now, this.#fruitless)
      if (plan !== undefined && plan.dueAt === this.#wake?.dueAt) return
      this.#wake?.cancel()
      this.#setWake(undefined)
      if (plan === undefined) return
      const { dueAt, capped } = plan
      this.#setWake({
        dueAt,
        cancel: this.#options.schedule(() => void this.#onWake(dueAt, capped), plan.delayMs),
      })
    } catch (error) {
      logFailOpen("wake", error)
    }
  }

  /** Keeps the published wake (what status shows elsewhere) in step. */
  #setWake(wake: { readonly cancel: () => void; readonly dueAt: number } | undefined): void {
    this.#wake = wake
    this.#options.ledger.noteWake(wake?.dueAt)
  }

  /** A change the user or a new park made: re-plan without backoff. */
  async #rearmWake(): Promise<void> {
    this.#fruitless = 0
    await this.#armWake()
  }

  /**
   * Parked work the wake serves: an ACTIVE session (observe never resumes,
   * off is inert), a configured tier (else it is held), attempts left.
   */
  #wakeable(record: ParkedRecord, settings: SettingsV1): boolean {
    return (
      this.#modeFor(record.sessionID, settings) === "active" &&
      configuredTiers(settings).includes(record.tier) &&
      (record.attempts ?? 0) < MAX_PARKED_ATTEMPTS
    )
  }

  /**
   * Resumes due parked work once per session; true when any record was
   * taken for resume. Reloads parked work first: the host's other plugin
   * instance may have parked or resumed records since this one last looked.
   */
  async #sweepParked(settings: SettingsV1): Promise<boolean> {
    await this.#parked.refresh()
    const records = this.#parked.list()
    for (const record of records) this.#options.ledger.noteParked(record.sessionID)
    // Override holders join the alive sweep: a dead session's override is
    // pruned here (its per-session steering is worthless once the session is
    // gone), in the same sweep that clears the other per-session maps.
    const overrideIDs = this.#sessionModes.snapshot().map((record) => record.sessionID)
    const tierRequestIDs = this.#tierRequests.snapshot().map((record) => record.sessionID)
    if (records.length === 0 && overrideIDs.length === 0 && tierRequestIDs.length === 0) {
      return false
    }
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
    for (const sessionID of tierRequestIDs) {
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
    // The fire-and-forget note means the queue may still hold writes; the
    // serialized set applies after them. A write failure just leaves the
    // record (fail-open — it will die with the session on the next sweep).
    for (const sessionID of tierRequestIDs) {
      if (alive.get(sessionID) === false) {
        try {
          await this.#tierRequests.set(sessionID, null)
        } catch (error) {
          logFailOpen("tier-requests", error)
        }
      }
    }
    // At most ONE continuation per session per sweep: prompting a session
    // with an active unit would supersede the user's in-flight episode (not
    // a safe boundary), and several back-to-back continuation prompts could
    // redo work an earlier one already completed (ADP-023).
    const attempted = new Set<string>()
    let resumed = false
    for (const record of plan.attempt) {
      if (this.#disposed) break
      if (this.#modeFor(record.sessionID, settings) === "off") continue
      if (this.#tracker.active(record.sessionID) !== undefined) continue
      if (attempted.has(record.sessionID)) continue
      attempted.add(record.sessionID)
      if (await this.#resumeAttempt(record, settings)) resumed = true
    }
    for (const [sessionID, isAlive] of alive) {
      if (!isAlive) {
        this.#continuationTiers.delete(sessionID)
        this.#promptAdmission.delete(sessionID)
        this.#continuationPending.delete(sessionID)
        this.#escalations.delete(sessionID)
        this.#quotaRecoveriesRemaining.delete(sessionID)
        this.#resumeCycles.delete(sessionID)
        this.#options.ledger.clearParked(sessionID)
        if (this.#sessionModes.get(sessionID) !== null) {
          try {
            await this.#sessionModes.set(sessionID, null)
          } catch (error) {
            logFailOpen("session-modes", error)
          }
        }
      }
    }
    return resumed
  }

  async #dropParked(record: ParkedRecord): Promise<void> {
    try {
      await this.#parked.resume(record.id)
    } catch (error) {
      logFailOpen("parked", error)
    }
  }

  /**
   * The user took the session over (own prompt or model pick): a resume in
   * flight on either plugin instance aborts after its settle, and parked
   * work is dropped — resuming it would replay a continuation the user has
   * already moved past.
   */
  async #takeOver(sessionID: string): Promise<void> {
    const { ledger } = this.#options
    ledger.noteTakeover(sessionID)
    this.#resumeCycles.delete(sessionID)
    const parkedHere = (): ParkedRecord[] =>
      this.#parked.list().filter((record) => record.sessionID === sessionID)
    // A session that never parked costs no storage read (OFF stays free).
    if (parkedHere().length === 0 && !ledger.mayBeParked(sessionID)) return
    await this.#parked.refresh()
    const records = parkedHere()
    ledger.clearParked(sessionID)
    if (records.length === 0) return
    for (const record of records) await this.#dropParked(record)
    await this.#rearmWake()
  }

  /**
   * Parks a unit whose tier has no usable resource. A unit that was itself
   * a resume carries the session's resume cycles, so repeated park → wake →
   * fail rounds exhaust MAX_PARKED_ATTEMPTS instead of looping.
   */
  async #parkUnit(id: string, sessionID: string, tier: TierName, detail: string): Promise<void> {
    const attempts = this.#resumeCycles.get(sessionID)
    if (
      await this.#storeParked({
        id,
        sessionID,
        tier,
        reason: "all-blocked",
        detail,
        parkedAt: this.#options.clock(),
        ...(attempts !== undefined ? { attempts } : {}),
      })
    ) {
      await this.#rearmWake()
    }
  }

  /**
   * Persists parked work; false when nothing waits. Work out of resume
   * attempts is not kept: it gets a receipt saying so instead of lingering
   * unresumable behind a waiting chip.
   */
  async #storeParked(record: ParkedRecord): Promise<boolean> {
    if ((record.attempts ?? 0) >= MAX_PARKED_ATTEMPTS) {
      await this.#recordReceipt({
        sessionID: record.sessionID,
        unitID: record.id,
        tier: record.tier,
        decision: {
          kind: "park",
          reason: "all-blocked",
          detail: `gave up after ${String(MAX_PARKED_ATTEMPTS)} resume attempts`,
        },
      })
      return false
    }
    this.#options.ledger.noteParked(record.sessionID)
    try {
      await this.#parked.park(record)
    } catch (error) {
      logFailOpen("parked", error)
      return false
    }
    return true
  }

  /**
   * One parked record's fresh routing attempt at a safe boundary; true when
   * the record was taken for resume. Its continuation is delivered in the
   * background: the prompt call stays open while the continued unit runs,
   * and the sweep must not hold every other due session behind it.
   */
  async #resumeAttempt(record: ParkedRecord, settings: SettingsV1): Promise<boolean> {
    // The parked session resumes under ITS effective mode, not the idle
    // report's session's mode.
    const mode = this.#modeFor(record.sessionID, settings)
    let decision: ReturnType<typeof admit>
    let probeTicket: ProbeTicket | undefined
    try {
      const admission = await this.#admit(settings, record.sessionID, record.tier)
      decision = admission.decision
      probeTicket = admission.probeTicket
    } catch (error) {
      logFailOpen("resume", error)
      return false
    }
    if (mode === "observe" || decision.kind !== "apply") {
      // Observed, or still no usable resource (or the routing deferred) —
      // stay parked. A non-apply admission held no probe ticket: #admit keeps
      // a ticket only for apply decisions and releases every other one.
      if (probeTicket !== undefined) this.#health.releaseProbe(probeTicket)
      await this.#noteStillParked(
        record,
        mode === "observe" ? { kind: "observe-only", would: decision } : decision,
      )
      return false
    }
    // The takeover baseline is read before the claim, synchronously with it:
    // a user prompt landing while the record is popped still counts. The
    // claim spans the pop and the continuation's delivery: the host's other
    // plugin instance sweeping the same record backs off, then finds it gone
    // once it re-reads the parked store.
    const { ledger } = this.#options
    const takeovers = ledger.takeovers(record.sessionID)
    if (!ledger.claim(record.sessionID)) {
      if (probeTicket !== undefined) this.#health.releaseProbe(probeTicket)
      return false
    }
    let delivering = false
    try {
      const popped = await this.#popParked(record)
      if (popped === undefined) {
        if (probeTicket !== undefined) this.#health.releaseProbe(probeTicket)
        return false
      }
      // The resumed unit is a new round of the same task: a fresh quota
      // ladder, and one more spent resume cycle should it park again.
      this.#resumeCycles.set(record.sessionID, (record.attempts ?? 0) + 1)
      this.#quotaRecoveriesRemaining.delete(record.sessionID)
      if (probeTicket !== undefined) this.#sessionProbeTickets.set(record.sessionID, probeTicket)
      // The resume continuation is not re-admitted (owned continuation), so
      // the freshly routed admission is recorded here, unit-less; the unit
      // that opens next adopts it and carries the outcome.
      await this.#recordReceipt({ sessionID: record.sessionID, tier: record.tier, decision })
      delivering = true
      const takenOver = (): boolean => ledger.takeovers(record.sessionID) !== takeovers
      void this.#deliverResume(record, decision.model, settings, probeTicket, takenOver).finally(
        () => {
          ledger.release(record.sessionID)
        },
      )
      return true
    } finally {
      if (!delivering) ledger.release(record.sessionID)
    }
  }

  /**
   * Records why parked work stays parked. A wake that finds nothing changed
   * adds no receipt: a tier with no stated recovery would otherwise log the
   * same decision every few minutes.
   */
  async #noteStillParked(record: ParkedRecord, decision: Receipt["decision"]): Promise<void> {
    const last = this.#receipts.snapshot().findLast((receipt) => receipt.unitID === record.id)
    if (last !== undefined && JSON.stringify(last.decision) === JSON.stringify(decision)) return
    await this.#recordReceipt({
      sessionID: record.sessionID,
      unitID: record.id,
      tier: record.tier,
      decision,
    })
  }

  /**
   * The resume continuation is an owned recovery: settle first, apply the
   * freshly routed model, then prompt — the episode's first LLM call must
   * not hit the model the work was parked away from. Never rejects.
   */
  async #deliverResume(
    record: ParkedRecord,
    model: ModelRef,
    settings: SettingsV1,
    probeTicket: ProbeTicket | undefined,
    takenOver: () => boolean,
  ): Promise<void> {
    try {
      await this.#ownRecovery(
        record.sessionID,
        model,
        record.tier,
        // The parked session's own effective mode and its still-open unit
        // window are re-checked after the settle; a session that gained an
        // active unit must not be prompted (not a safe boundary), and one the
        // user took over (on either instance) has moved past the work.
        () =>
          !(takenOver() || this.#disposed) &&
          this.#modeFor(record.sessionID, settings) !== "off" &&
          this.#tracker.active(record.sessionID) === undefined,
      )
      this.#fruitless = 0
    } catch (error) {
      if (
        probeTicket !== undefined &&
        this.#sessionProbeTickets.get(record.sessionID) === probeTicket
      ) {
        this.#sessionProbeTickets.delete(record.sessionID)
        this.#health.releaseProbe(probeTicket)
      }
      if (!(error instanceof RecoveryAbortedError)) logFailOpen("resume", error)
      this.#resumeCycles.delete(record.sessionID)
      // Work the user took over is gone for good; anything else waits again,
      // and a failed resume backs off like a fruitless wake rather than
      // retrying a second later.
      if (takenOver()) return
      this.#fruitless += 1
      await this.#rePark(record)
      await this.#armWake()
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
    await this.#storeParked({
      ...record,
      attempts: (record.attempts ?? 0) + 1,
      parkedAt: this.#options.clock(),
    })
  }

  // ---------- shared helpers ----------

  async #isSessionAlive(sessionID: string): Promise<boolean> {
    try {
      await this.#options.session.get({ sessionID })
      return true
    } catch (error) {
      // The host rejects `session.get` for a missing session with a plain
      // error and exposes no typed status; only a definitive not-found
      // counts as dead. Anything else is treated as alive (fail open toward
      // keeping durable user state, ADP-031): a transient storage or host
      // error must never prune parked work, mode overrides, or tier
      // requests — the next sweep re-probes instead.
      return !/not found/i.test(String(error))
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

/**
 * When a parked record can resume: the earliest usable candidate its
 * resume admission would route to (a standing pin wins over the tier).
 */
function parkedResumeAt(
  record: ParkedRecord,
  settings: SettingsV1,
  usableAt: (ref: ModelRef) => number | undefined,
): number | undefined {
  const candidates = settings.pin !== null ? [settings.pin] : settings.tiers[record.tier]
  return earliestUsable(candidates.map(usableAt))
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

/** Quota survives variantless host resolution; only shared-limit evidence blocks siblings. */
function failureKey(key: ResourceKey, classification: FailureClassification): ResourceKey {
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
function failureEvent(key: ResourceKey, classification: FailureClassification): HealthEvent {
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
