// covers: ["ADP-024", "ADP-060"]
import { MAX_PARKED_ATTEMPTS } from "@coool/adaptive-core/execution/parking/plan"
import { isTierName, type TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import type { JsonFile } from "./store.js"

/** Metadata only: user input stays in Pi's own session file, never this index. */
export interface Parked {
  readonly session: string
  readonly token: string
  readonly tier: TierName
  readonly due: number
  readonly wakes: number
  readonly claimed: boolean
}

export interface ParkingSources {
  readonly file: JsonFile
  readonly clock: () => number
  readonly timer: (callback: () => void, delay: number) => () => void
}

/**
 * Failed wake deliveries before a parked task stops auto-waking (the same
 * give-up budget OpenCode derives from MAX_PARKED_ATTEMPTS). A wake that
 * re-parks because the tier is still blocked does not consume the budget:
 * waiting for a stated reset is free, only resumed work that failed again
 * counts.
 */
export const MAX_WAKES = MAX_PARKED_ATTEMPTS
export const SHORT_WAIT_MS = 120_000
export const PARK_ENTRY = "adaptive.parked"
export class WaitCancelled extends Error {
  constructor() {
    super("Adaptive wait cancelled")
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

export function parseParked(value: unknown): Parked {
  const session = field(value, "session")
  const token = field(value, "token")
  const tier = field(value, "tier")
  const due = field(value, "due")
  const wakes = field(value, "wakes")
  const claimed = field(value, "claimed")
  if (typeof session !== "string" || session.length === 0)
    throw new Error("Adaptive parked: session must be a non-empty string")
  if (typeof token !== "string" || token.length === 0)
    throw new Error("Adaptive parked: token must be a non-empty string")
  if (typeof tier !== "string" || !isTierName(tier))
    throw new Error("Adaptive parked: tier must be quick, standard, or advanced")
  if (typeof due !== "number" || !Number.isFinite(due) || due < 0)
    throw new Error("Adaptive parked: due must be a finite timestamp")
  // Manual retries after the give-up may keep failing, so `wakes` has no
  // upper bound: MAX_WAKES is policy (stop auto-waking), not a format limit.
  if (typeof wakes !== "number" || !Number.isSafeInteger(wakes) || wakes < 0)
    throw new Error("Adaptive parked: wakes must be a non-negative integer")
  if (typeof claimed !== "boolean") throw new Error("Adaptive parked: claimed must be boolean")
  return { session, token, tier, due, wakes, claimed }
}

function records(value: unknown): Parked[] {
  if (value === undefined) return []
  const rows = field(value, "records")
  if (field(value, "version") !== 1 || !Array.isArray(rows) || rows.length > 512)
    throw new Error("Adaptive parked: expected version 1 and at most 512 records")
  return rows.map(parseParked)
}

export function savePark(file: JsonFile, record: Parked): Promise<void> {
  return file.update((value) => ({
    next: {
      version: 1,
      records: [...records(value).filter((row) => row.session !== record.session), record].slice(
        -512,
      ),
    },
    result: undefined,
  }))
}

export function findPark(file: JsonFile, session: string): Promise<Parked | undefined> {
  return file.update((value) => ({
    next: undefined,
    result: records(value).find((row) => row.session === session && !row.claimed),
  }))
}

/**
 * Claim before dispatch under the same cross-process file lock. The claim
 * does not touch `wakes`: only a re-park after the delivered task failed
 * again does (parkingAfterRun). `manual` retries a given-up task on the
 * user's explicit request instead of silently refusing it.
 */
export function claimPark(
  file: JsonFile,
  record: Parked,
  now: number,
  manual = false,
): Promise<boolean> {
  return file.update((value) => {
    const rows = records(value)
    const found = rows.find((row) => row.session === record.session && row.token === record.token)
    const claimed =
      found !== undefined &&
      !found.claimed &&
      found.due <= now &&
      (manual || found.wakes < MAX_WAKES)
    return {
      next: claimed
        ? {
            version: 1,
            records: rows.map((row) => (row === found ? { ...row, claimed: true } : row)),
          }
        : undefined,
      result: claimed,
    }
  })
}

/** Drops the session's records; true when one was still waiting (not yet claimed). */
export function cancelPark(file: JsonFile, session: string): Promise<boolean> {
  return file.update((value) => {
    const rows = records(value)
    return {
      next: { version: 1, records: rows.filter((row) => row.session !== session) },
      result: rows.some((row) => row.session === session && !row.claimed),
    }
  })
}

/** Abortable ticks, shared by countdowns and long owned headless waits. */
export async function waitUntil(
  sources: ParkingSources,
  due: number,
  signal: AbortSignal,
  tick: (remaining: number) => void,
): Promise<void> {
  while (sources.clock() < due) {
    if (signal.aborted) throw new WaitCancelled()
    const remaining = due - sources.clock()
    tick(remaining)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cancel()
        reject(new WaitCancelled())
      }
      const cancel = sources.timer(
        () => {
          signal.removeEventListener("abort", abort)
          resolve()
        },
        Math.min(remaining, 1_000),
      )
      signal.addEventListener("abort", abort, { once: true })
    })
  }
  if (signal.aborted) throw new WaitCancelled()
}
