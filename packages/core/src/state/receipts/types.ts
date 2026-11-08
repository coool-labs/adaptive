/**
 * Decision receipts (ADP-030): small bounded local records explaining why
 * Adaptive made each decision. Receipts exist for explainability, debugging,
 * tests, and a future outcome-learning policy — never injected into prompts,
 * never leaving the machine. Retention is bounded (oldest evicted).
 */
import type { Decision } from "../../routing/scheduler/types.js"
import type { TierName } from "../../routing/tier-policy/types.js"
import type { InterruptReason } from "../../routing/work-unit/interruption.js"
import type { FailureCategory } from "../../health/classifier/types.js"

export const RECEIPTS_KEY = "coool.adaptive/receipts"
export const RECEIPTS_VERSION = 1
/** Product bound — not a user knob. The ring keeps the newest receipts. */
export const MAX_RECEIPTS = 200
/**
 * Every free-text string stored in a receipt is truncated to this bound
 * before persisting (and re-truncated on read). Boundedness is the
 * no-secrets invariant: prompts, error bodies, and credentials have no
 * field to live in and no room to hide in.
 */
export const MAX_RECEIPT_TEXT = 128

export interface ReceiptMeta {
  /** Decision timestamp (adapter clock, ms epoch). */
  readonly at: number
  readonly sessionID: string
  readonly unitID?: string | undefined
  /** Required tier when routing named one (pins carry no tier). */
  readonly tier?: TierName | undefined
}

export interface ReceiptInput extends ReceiptMeta {
  /** The decision exactly as the scheduler/mode wrapper produced it. */
  readonly decision: Decision
}

/**
 * Unit outcome attached after termination. Structured vocabulary only —
 * never the raw error text (ADP-030: no secrets, bounded records).
 */
export type ReceiptOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly category: FailureCategory }
  | { readonly status: "interrupted"; readonly reason: InterruptReason }

export interface Receipt extends ReceiptMeta {
  /** Monotonic id assigned by the store; continues across restarts. */
  readonly id: number
  readonly decision: Decision
  readonly outcome?: ReceiptOutcome
}

export interface ReceiptsPayload {
  readonly version: typeof RECEIPTS_VERSION
  readonly receipts: readonly Receipt[]
}

/** Storage seam — the adapter binds `RECEIPTS_KEY` to `ctx.storage`. */
export interface ReceiptsStorage {
  read(): Promise<unknown>
  write(payload: ReceiptsPayload): Promise<void>
}
