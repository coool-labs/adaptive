import type { HostCopy, HostDeferReason } from "@coool/adaptive-core/flow/host-copy"
import type { ParkReason } from "@coool/adaptive-core/routing/scheduler/types"

const defer: Record<HostDeferReason, string> = {
  "routing-defer":
    "No routing rule applied. Pi keeps the manual model; an Adaptive entry needs a compatible configured model in its tier.",
  "adaptive-off": "Adaptive is off. Pi keeps your selected model.",
  "pin-unverifiable":
    "The pinned resource is not available in Pi. Check credentials or change the pin in /adaptive.",
  "pin-incompatible":
    "The pinned resource cannot handle this request. Change the pin or tier in /adaptive.",
}
const park: Record<ParkReason, string> = {
  "all-blocked":
    "Every model in the required tier is unavailable. Work waits for recovery; /adaptive resume or cancel manages the wait.",
  "no-candidates": "This tier has no configured models. Open /adaptive tiers to add one.",
  "no-compatible-resource":
    "No configured model fits this request. Check context, inputs and tool capabilities with /adaptive doctor.",
  "pin-blocked":
    "Your pinned resource is unavailable. Adaptive does not silently replace a pin; change it in /adaptive.",
}

export const PI_COPY: HostCopy = {
  inviteTitle: "Pi Adaptive",
  modelSearchPlaceholder: "Search Pi models",
  receiptExplanation: (reason) => defer[reason],
  parkExplanation: (reason) => park[reason],
}
