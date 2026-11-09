// covers: ["ADP-057", "ADP-058"]
import { expect, it } from "vitest"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
import { shouldWriteNote, decisionNote } from "../src/ui/notes.js"
import { PI_COPY } from "../src/ui/copy.js"
import { whatHappened } from "@coool/adaptive-core/flow/receipts"

const apply: Decision = {
  kind: "apply",
  model: { providerID: "p", id: "m" },
  reason: "preferred",
  evidence: { skipped: [] },
}
const park: Decision = { kind: "park", reason: "all-blocked" }

it("defaults changes to meaningful transitions, but always explains trouble", () => {
  expect(shouldWriteNote("quiet", park, undefined)).toBe(false)
  expect(shouldWriteNote("all", apply, apply)).toBe(true)
  expect(shouldWriteNote("changes", apply, undefined)).toBe(true)
  expect(shouldWriteNote("changes", apply, apply)).toBe(false)
  expect(shouldWriteNote("changes", park, apply)).toBe(true)
  expect(shouldWriteNote("changes", apply, park)).toBe(true)
  expect(shouldWriteNote("changes", { ...apply, reason: "fallback" }, apply)).toBe(true)
  expect(shouldWriteNote("changes", { ...apply, reason: "probe" }, apply)).toBe(true)
  expect(
    shouldWriteNote("changes", { ...apply, model: { providerID: "p", id: "other" } }, apply),
  ).toBe(true)
  expect(shouldWriteNote("changes", { kind: "observe-only", would: apply }, apply)).toBe(true)
  expect(
    shouldWriteNote(
      "changes",
      { kind: "observe-only", would: apply },
      { kind: "observe-only", would: apply },
    ),
  ).toBe(false)
})

it("formats the finite decision vocabulary without raw errors or evidence prose", () => {
  expect(decisionNote(apply, "standard")).toBe("standard → p/m")
  expect(decisionNote({ kind: "observe-only", would: apply }, "standard")).toContain(
    "would standard",
  )
  expect(decisionNote(park, "standard")).toContain("waiting")
  expect(decisionNote({ kind: "defer", reason: "pin-incompatible" }, "quick")).toContain(
    "/adaptive why",
  )
  expect(
    decisionNote(
      {
        kind: "escalate",
        target: apply.model,
        tier: "advanced",
        step: "tier",
        evidence: [],
        budgetRemaining: 0,
      },
      "standard",
    ),
  ).toContain("Escalated to advanced")
})

it("uses Pi copy, including durable park explanations without breaking existing hosts", () => {
  expect(PI_COPY.inviteTitle).toBe("Pi Adaptive")
  expect(PI_COPY.modelSearchPlaceholder).toContain("Pi")
  for (const reason of [
    "routing-defer",
    "adaptive-off",
    "pin-unverifiable",
    "pin-incompatible",
  ] as const)
    expect(PI_COPY.receiptExplanation(reason)).not.toContain("OpenCode")
  for (const reason of [
    "all-blocked",
    "no-candidates",
    "no-compatible-resource",
    "pin-blocked",
  ] as const)
    expect(
      whatHappened({ id: 1, at: 0, sessionID: "s", decision: { kind: "park", reason } }, PI_COPY),
    ).toContain("/adaptive")
})
