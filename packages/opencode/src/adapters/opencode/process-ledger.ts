/**
 * The host may load the plugin twice in one process (ADP-056): either
 * instance may resume parked work (ADP-024) while the other receives the
 * session's host reports. The ledger is what the instances share so neither
 * misreads the other — owned switches and continuation prompts are
 * recognized as Adaptive's, a takeover one instance saw stops the other's
 * continuation (parked resume or failure recovery), one owned continuation
 * per session is in flight, and the instance that hears the host is preferred
 * for wake sweeps.
 */
import { sameModelRef, type ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { ResumeOutcome } from "@coool/adaptive-core/flow/actions"

/** How long another instance's owned switch or prompt stays recognizable. */
export const MARK_TTL_MS = 60_000
/** Per-session entries kept (oldest session evicted first). */
export const MAX_LEDGER_SESSIONS = 1024

/** What a continuation prompted by another instance carries over. */
export interface OwnedContinuation {
  readonly tier?: TierName
  readonly cycles?: number
}

/** One instance's view of the process-wide ledger. */
export interface ProcessLedger {
  /** This instance receives host reports (inert once it left). */
  markLive(): void
  /** Another instance in the process receives host reports. */
  liveElsewhere(): boolean
  /** Withdraws this instance for good (disposed). */
  leave(): void
  /**
   * Taken synchronously before an owned continuation (a parked resume or a
   * failure recovery) starts. Returns this lease's token, or undefined when
   * another owner holds the session. The lease expires `staleAfterMs` after
   * `at`, so one hung settle or prompt cannot strand the session for the
   * process lifetime. `supersede` takes over a live lease: only the failure
   * of the continuation unit that lease delivered may do so — that episode
   * now owns the session's next recovery.
   */
  claim(
    sessionID: string,
    at: number,
    staleAfterMs: number,
    supersede?: boolean,
  ): symbol | undefined
  /** Releases this lease only; a newer owner's lease is left intact. */
  release(sessionID: string, token: symbol): void
  /** The user took the session over (own prompt, model pick, run, cancel). */
  noteTakeover(sessionID: string): void
  /** Takeovers seen so far; a resume compares it across its settle. */
  takeovers(sessionID: string): number
  noteSwitch(sessionID: string, model: ModelRef, at: number): void
  /** Whether this selection is another instance's own switch (read once). */
  takeSwitch(sessionID: string, model: ModelRef, now: number): boolean
  /** Drops this instance's switch mark (the switch never happened). */
  withdrawSwitch(sessionID: string): void
  noteContinuation(sessionID: string, continuation: OwnedContinuation, at: number): void
  /** Another instance's continuation prompt on this session (read once). */
  takeContinuation(sessionID: string, now: number): OwnedContinuation | undefined
  /** Drops this instance's continuation mark (the prompt never arrived). */
  withdrawContinuation(sessionID: string): void
  /** Publishes when this instance's wake is due (`undefined`: none armed). */
  noteWake(dueAt: number | undefined): void
  /** The earliest wake another live instance has armed. */
  liveWake(): number | undefined
  /** The session may have parked work (a superset: never misses one). */
  noteParked(sessionID: string): void
  mayBeParked(sessionID: string): boolean
  /** The parked store holds none of the session's work. */
  clearParked(sessionID: string): void
  /** Orders health hydration, persistence and resets across duplicate instances. */
  healthOperation(operation: () => Promise<void>): Promise<void>
  /**
   * Orders receipt load-mutate-persist cycles across duplicate instances.
   * Receipt writes are read-modify-write on one storage key: without a shared
   * lock, the last writer's stale ring replaces the other instance's receipt.
   */
  receiptOperation<T>(operation: () => Promise<T>): Promise<T>
  /** Bumped after a receipt write, so another instance knows to reload. */
  receiptRevision(): number
  noteReceiptWrite(): void
  /**
   * Orders steering read-modify-write cycles across duplicate instances.
   * Settings, session modes and tier requests are durable keys whose
   * in-memory snapshots must not drift when both instances write.
   */
  steeringOperation<T>(operation: () => Promise<T>): Promise<T>
  /** Resolves when every steering write enqueued so far has settled. */
  steeringFlush(): Promise<void>
  /** Bumped after a steering write, so the other instance reloads. */
  steeringRevision(): number
  noteSteeringWrite(): void
  /** The listener lives until this instance leaves. */
  onHealthReset(reset: (model: ModelRef) => void): void
  /** Publish only after the reset is durable, inside healthOperation. */
  resetHealth(model: ModelRef): void
  onResume(resume: (sessionID: string) => Promise<ResumeOutcome>): void
  /** The live instance owns probe tickets and active-unit state. */
  resumeElsewhere(sessionID: string): Promise<ResumeOutcome> | undefined
}

interface Mark<T> {
  readonly owner: symbol
  readonly value: T
  readonly at: number
  readonly readers: Set<symbol>
}

interface Claim {
  readonly token: symbol
  readonly expiresAt: number
}

interface Shared {
  readonly live: Set<symbol>
  /** Instances that disposed: their marks must never steer a survivor. */
  readonly departed: Set<symbol>
  readonly claims: Map<string, Claim>
  readonly takeovers: Map<string, number>
  readonly switches: Map<string, Mark<ModelRef>>
  readonly continuations: Map<string, Mark<OwnedContinuation>>
  readonly wakes: Map<symbol, number>
  readonly parked: Set<string>
  healthQueue: Promise<void>
  receiptQueue: Promise<unknown>
  receiptRevision: number
  steeringQueue: Promise<unknown>
  steeringRevision: number
  readonly healthResets: Map<symbol, (model: ModelRef) => void>
  readonly resumers: Map<symbol, (sessionID: string) => Promise<ResumeOutcome>>
}

/**
 * Duplicate instances may come from separate module copies, so the ledger
 * lives on the holder (`globalThis`) under a registry symbol every copy
 * resolves identically. A copy from another release may already have
 * published a ledger of a different shape (the host can keep an older plugin
 * loaded beside a newer one); the shape version in the key keeps copies that
 * disagree about it from sharing one. Bump it whenever `Shared` changes.
 */
const LEDGER = Symbol.for("coool.adaptive/process-ledger/6")

type LedgerHolder = Record<symbol, Shared | undefined>

/** Evicts the oldest session `keep` does not protect once at the cap. */
function setBounded<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  keep: (key: string) => boolean = () => false,
): void {
  map.delete(key)
  if (map.size >= MAX_LEDGER_SESSIONS) {
    for (const oldest of map.keys()) {
      if (keep(oldest)) continue
      map.delete(oldest)
      break
    }
  }
  map.set(key, value)
}

function withdraw<T>(marks: Map<string, Mark<T>>, sessionID: string, owner: symbol): void {
  if (marks.get(sessionID)?.owner === owner) marks.delete(sessionID)
}

/**
 * Reads another owner's fresh mark once per reader. A read that does not
 * match still consumes it, so a stale mark can never claim a later pick.
 */
function take<T>(
  marks: Map<string, Mark<T>>,
  sessionID: string,
  reader: symbol,
  now: number,
  departed: ReadonlySet<symbol>,
): T | undefined {
  const mark = marks.get(sessionID)
  if (
    mark === undefined ||
    mark.owner === reader ||
    mark.readers.has(reader) ||
    departed.has(mark.owner)
  )
    return undefined
  mark.readers.add(reader)
  return now - mark.at <= MARK_TTL_MS ? mark.value : undefined
}

export function processLedger(holder: object = globalThis): ProcessLedger {
  // `globalThis` has no declared slot for a registry symbol; the cast only
  // widens it with that one optional, plugin-owned property.
  const slot = holder as LedgerHolder
  const shared = slot[LEDGER] ?? {
    live: new Set<symbol>(),
    departed: new Set<symbol>(),
    claims: new Map<string, Claim>(),
    takeovers: new Map<string, number>(),
    switches: new Map<string, Mark<ModelRef>>(),
    continuations: new Map<string, Mark<OwnedContinuation>>(),
    wakes: new Map<symbol, number>(),
    parked: new Set<string>(),
    healthQueue: Promise.resolve(),
    receiptQueue: Promise.resolve(),
    receiptRevision: 0,
    steeringQueue: Promise.resolve(),
    steeringRevision: 0,
    healthResets: new Map<symbol, (model: ModelRef) => void>(),
    resumers: new Map<symbol, (sessionID: string) => Promise<ResumeOutcome>>(),
  }
  slot[LEDGER] = shared
  const owner = Symbol("instance")
  const mark = <T>(value: T, at: number): Mark<T> => ({ owner, value, at, readers: new Set() })
  // A disposed instance can still hear a late host report while the rest of
  // the plugin tears down; it must not pose as the live one again.
  let left = false
  return {
    markLive() {
      if (!left) shared.live.add(owner)
    },
    liveElsewhere() {
      return [...shared.live].some((other) => other !== owner)
    },
    leave() {
      left = true
      shared.departed.add(owner)
      shared.live.delete(owner)
      shared.wakes.delete(owner)
      shared.healthResets.delete(owner)
      shared.resumers.delete(owner)
    },
    claim(sessionID, at, staleAfterMs, supersede = false) {
      const held = shared.claims.get(sessionID)
      if (!supersede && held !== undefined && at < held.expiresAt) return undefined
      const token = Symbol("claim")
      shared.claims.set(sessionID, { token, expiresAt: at + staleAfterMs })
      return token
    },
    release(sessionID, token) {
      if (shared.claims.get(sessionID)?.token === token) shared.claims.delete(sessionID)
    },
    noteTakeover(sessionID) {
      // A claimed session's count is what its in-flight resume compares
      // against: evicting it would read as a takeover.
      setBounded(shared.takeovers, sessionID, (shared.takeovers.get(sessionID) ?? 0) + 1, (key) =>
        shared.claims.has(key),
      )
    },
    takeovers(sessionID) {
      return shared.takeovers.get(sessionID) ?? 0
    },
    noteSwitch(sessionID, model, at) {
      setBounded(shared.switches, sessionID, mark(model, at))
    },
    takeSwitch(sessionID, model, now) {
      const noted = take(shared.switches, sessionID, owner, now, shared.departed)
      return noted !== undefined && sameModelRef(noted, model)
    },
    withdrawSwitch(sessionID) {
      withdraw(shared.switches, sessionID, owner)
    },
    noteContinuation(sessionID, continuation, at) {
      setBounded(shared.continuations, sessionID, mark(continuation, at))
    },
    takeContinuation(sessionID, now) {
      return take(shared.continuations, sessionID, owner, now, shared.departed)
    },
    withdrawContinuation(sessionID) {
      withdraw(shared.continuations, sessionID, owner)
    },
    noteWake(dueAt) {
      if (dueAt === undefined) shared.wakes.delete(owner)
      else if (!left) shared.wakes.set(owner, dueAt)
    },
    liveWake() {
      const due = [...shared.wakes]
        .filter(([other]) => other !== owner && shared.live.has(other))
        .map(([, dueAt]) => dueAt)
      return due.length === 0 ? undefined : Math.min(...due)
    },
    // The hint is only ever cleared by a read of the parked store itself, so
    // it never hides parked work; it spares that read for every prompt in a
    // session that never parked.
    noteParked(sessionID) {
      shared.parked.add(sessionID)
    },
    mayBeParked(sessionID) {
      return shared.parked.has(sessionID)
    },
    clearParked(sessionID) {
      shared.parked.delete(sessionID)
    },
    healthOperation(operation) {
      const pending = shared.healthQueue.then(operation)
      shared.healthQueue = pending.catch(() => undefined)
      return pending
    },
    receiptOperation(operation) {
      const pending = shared.receiptQueue.then(operation)
      shared.receiptQueue = pending.catch(() => undefined)
      return pending
    },
    receiptRevision() {
      return shared.receiptRevision
    },
    noteReceiptWrite() {
      shared.receiptRevision += 1
    },
    steeringOperation(operation) {
      const pending = shared.steeringQueue.then(operation)
      shared.steeringQueue = pending.catch(() => undefined)
      return pending
    },
    steeringFlush() {
      return shared.steeringQueue.then(() => undefined)
    },
    steeringRevision() {
      return shared.steeringRevision
    },
    noteSteeringWrite() {
      shared.steeringRevision += 1
    },
    onHealthReset(reset) {
      if (!left) shared.healthResets.set(owner, reset)
    },
    resetHealth(model) {
      for (const reset of shared.healthResets.values()) reset(model)
    },
    onResume(resume) {
      if (!left) shared.resumers.set(owner, resume)
    },
    resumeElsewhere(sessionID) {
      for (const [other, resume] of shared.resumers) {
        if (other !== owner && shared.live.has(other)) return resume(sessionID)
      }
      return undefined
    },
  }
}
