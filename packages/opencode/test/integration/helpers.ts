/**
 * Integration-suite fixtures (T-22). The supervisor's real subsystems are
 * wired together (tracker + classifier + health + stores + scheduler); only
 * the clock, storage, and host session IO are faked. Reuses the supervisor
 * unit-test fixtures instead of duplicating them.
 */
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { EventReport } from "../../src/adapters/opencode/index.js"
import { migrateSettings } from "@coool/adaptive-core/state/settings/parse"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/index"
import { parseParkedPayload } from "@coool/adaptive-core/state/parked-work/index"
import {
  activeStorage,
  FakeSupervisorSession,
  flush,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
} from "../supervisor/helpers.js"

export { FakeSupervisorSession, activeStorage, flush, makeSupervisor, ref, seed, settingsJSON }

export type { ModelRef }

import { wireRef } from "../adapters/opencode/helpers.js"

export { wireRef }

/**
 * Deterministic injected clock. Real `Date.now` makes breaker backoff and
 * rate-limit windows nondeterministic in CI; tests advance explicitly.
 */
export class StorageClock {
  now = 0

  advance(ms: number): void {
    this.now += ms
  }

  tick = (): number => this.now
}

export const STARTED_S1 = { kind: "execution-started", sessionID: "s1", at: 10 } as const

export function succeeded(
  sessionID = "s1",
  at = 100,
): {
  kind: "execution-succeeded"
  sessionID: string
  at: number
} {
  return { kind: "execution-succeeded", sessionID, at }
}

export function failed429(at = 20): {
  kind: "execution-failed"
  sessionID: string
  at: number
  error: { type: string; message: string; status: number }
} {
  return {
    kind: "execution-failed",
    sessionID: "s1",
    at,
    error: { type: "UnknownError", message: "", status: 429 },
  }
}

export const INTERRUPTED_USER = {
  kind: "execution-interrupted",
  sessionID: "s1",
  at: 20,
  reason: "user",
} as const

export function selected(
  model: ModelRef,
  at = 15,
): {
  kind: "model-selected"
  sessionID: string
  at: number
  model: ModelRef
} {
  return { kind: "model-selected", sessionID: "s1", at, model }
}

/** One admission cycle: started + the host's model-selected echo. */
export async function startTracking(
  supervisor: { handleReport: (report: EventReport) => Promise<void> },
  model: ModelRef,
  at = 10,
): Promise<void> {
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at })
  await supervisor.handleReport(selected(model, at + 5))
}

/** Simulate OpenCode's native retry scheduling (the retry hook's input). */
export function intervalAttempt(
  attempt: number,
  delay: number,
): {
  sessionID: string
  model: ModelRef
  error: { type: string; message: string; status: number }
  attempt: number
  decision: { retry: boolean; delay: number }
} {
  return {
    sessionID: "s1",
    model: ref("prov", "a"),
    error: { type: "UnknownError", message: "", status: 429 },
    attempt,
    decision: { retry: true, delay },
  }
}

/** A full durable-state snapshot parsed from storage. */
export function readState(storage: { data: Map<string, unknown> }): {
  mode: string
  receiptIds: number[]
  parkedIds: string[]
} {
  return {
    mode: migrateSettings(storage.data.get("coool.adaptive/settings")).mode,
    receiptIds: parseReceiptsPayload(storage.data.get("coool.adaptive/receipts")).map(
      (receipt) => receipt.id,
    ),
    parkedIds: parseParkedPayload(storage.data.get("coool.adaptive/parked")).map(
      (record) => record.id,
    ),
  }
}
