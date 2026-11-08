import type { HostCopy, HostDeferReason } from "@coool/adaptive-core/flow/host-copy"

const deferExplanation: Record<HostDeferReason, string> = {
  "routing-defer": "No routing rule applied to this turn, so Adaptive left the choice to OpenCode.",
  "adaptive-off": "Adaptive is switched off, so every turn runs on OpenCode's own choice.",
  "pin-unverifiable":
    "The pinned resource could not be verified as available, so Adaptive left the choice to OpenCode.",
  "pin-incompatible":
    "The pinned resource does not fit this turn's requirements, so Adaptive left the choice to OpenCode.",
}

export const OPENCODE_COPY: HostCopy = {
  inviteTitle: "OpenCode Adaptive",
  modelSearchPlaceholder: "Search OpenCode models",
  receiptExplanation: (reason) => deferExplanation[reason],
}
