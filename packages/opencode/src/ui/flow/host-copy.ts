export type HostDeferReason =
  "routing-defer" | "adaptive-off" | "pin-unverifiable" | "pin-incompatible"

/** Hosts have different defer semantics, not just different product names. */
export interface HostCopy {
  readonly inviteTitle: string
  readonly modelSearchPlaceholder: string
  receiptExplanation(reason: HostDeferReason): string
}
