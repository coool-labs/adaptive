// covers: ["ADP-033"]
import { expect, it } from "vitest"
import { OPENCODE_COPY } from "../../src/ui/copy.js"

it("explains the OpenCode defer behavior without implying Adaptive selected a model", () => {
  expect(OPENCODE_COPY.inviteTitle).toBe("OpenCode Adaptive")
  expect(OPENCODE_COPY.modelSearchPlaceholder).toBe("Search OpenCode models")
  expect(OPENCODE_COPY.receiptExplanation("routing-defer")).toBe(
    "No routing rule applied to this turn, so Adaptive left the choice to OpenCode.",
  )
  expect(OPENCODE_COPY.receiptExplanation("adaptive-off")).toBe(
    "Adaptive is switched off, so every turn runs on OpenCode's own choice.",
  )
  expect(OPENCODE_COPY.receiptExplanation("pin-unverifiable")).toBe(
    "The pinned resource could not be verified as available, so Adaptive left the choice to OpenCode.",
  )
  expect(OPENCODE_COPY.receiptExplanation("pin-incompatible")).toBe(
    "The pinned resource does not fit this turn's requirements, so Adaptive left the choice to OpenCode.",
  )
})
