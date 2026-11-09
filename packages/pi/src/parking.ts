// covers: ["ADP-024", "ADP-060"]
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

export const MAX_WAKES = 3
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
  if (typeof wakes !== "number" || !Number.isSafeInteger(wakes) || wakes < 0 || wakes > MAX_WAKES)
    throw new Error("Adaptive parked: wakes must be an integer from 0 to 3")
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

/** Claim and increment under the same cross-process file lock, before dispatch. */
export function claimPark(file: JsonFile, record: Parked, now: number): Promise<boolean> {
  return file.update((value) => {
    const rows = records(value)
    const found = rows.find((row) => row.session === record.session && row.token === record.token)
    const claimed =
      found !== undefined && !found.claimed && found.due <= now && found.wakes < MAX_WAKES
    return {
      next: claimed
        ? {
            version: 1,
            records: rows.map((row) =>
              row === found ? { ...row, claimed: true, wakes: row.wakes + 1 } : row,
            ),
          }
        : undefined,
      result: claimed,
    }
  })
}

export function cancelPark(file: JsonFile, session: string): Promise<void> {
  return file.update((value) => ({
    next: { version: 1, records: records(value).filter((row) => row.session !== session) },
    result: undefined,
  }))
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
