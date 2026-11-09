import { expect, it } from "vitest"
import { visibleWidth } from "@earendil-works/pi-tui"
import { statusText, type AdaptiveStatus } from "../src/ui/status.js"
import { fitLine } from "../src/host/entries.js"

it("explains every status and fits real terminal cells at 60/80/120 columns", () => {
  const model = { providerID: "界".repeat(50), id: "m" }
  const statuses: AdaptiveStatus[] = [
    { kind: "off" },
    { kind: "observe", tier: "standard" },
    { kind: "routing", tier: "standard", model },
    { kind: "recovering", tier: "standard", model },
    { kind: "waiting", tier: "standard", remainingMs: 42000 },
    { kind: "parked", tier: "standard", due: "18:42" },
    { kind: "escalated", tier: "advanced" },
    { kind: "degraded" },
    { kind: "setup" },
  ]
  for (const status of statuses) {
    const text = statusText(status)
    if (text !== undefined)
      for (const width of [60, 80, 120])
        expect(visibleWidth(fitLine(text, width))).toBeLessThanOrEqual(width)
  }
  expect(statusText(statuses[0] ?? { kind: "off" })).toBeUndefined()
  expect(statusText({ kind: "waiting", tier: "quick", remainingMs: -100 })).toContain("0:00")
})
