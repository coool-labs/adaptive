/**
 * Supervisor wiring types (ADP-029/031). Structural mirrors of the host
 * surfaces the supervisor consumes, so the supervisor never imports
 * `@opencode/plugin` (architecture rule: only the adapters touch the host
 * package) while the real host domains remain directly assignable — method
 * parameters are bivariant, so `ctx.session` satisfies the mirror.
 */
import type { ModelRef } from "../core/work-unit/types.js"
import type { SessionOpsSource } from "../adapters/opencode/session-ops.js"
import type { ModelSource } from "../adapters/opencode/inventory.js"
import type { StorageSource } from "../adapters/opencode/storage.js"
import type { ProcessLedger } from "../adapters/opencode/process-ledger.js"

/** The host session surface the supervisor actually uses. */
export interface SupervisorSessionSource extends SessionOpsSource {
  get(input: { sessionID: string }): Promise<unknown>
}

/**
 * Structural mirror of the host `retry` hook input. The retry handler OWNS
 * `decision` — a veto assigns `{ retry: false }` (host hooks mutate their
 * inputs; callbacks never return replacements).
 */
export interface RetryHookInput {
  readonly sessionID: string
  readonly model: ModelRef
  readonly error: {
    readonly type: string
    readonly message: string
    readonly status?: number | undefined
    readonly retryAfterMs?: number | undefined
  }
  readonly attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

/** Everything the supervisor needs from the host. */
export interface SupervisorOptions {
  readonly session: SupervisorSessionSource
  readonly model: ModelSource
  readonly storage: StorageSource
  /** Epoch-ms clock (injected so tests are deterministic). */
  readonly clock: () => number
  /** One-shot timer for the parked-work wake; returns its cancel. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  /** What every plugin instance in the process shares (ADP-056). */
  readonly ledger: ProcessLedger
}

/** The Codex header sensor watches ChatGPT/Codex-backed resources. */
export const CODEX_PROVIDER_ID = "openai"
