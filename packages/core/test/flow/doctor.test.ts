/**
 * Doctor report: the checks every host derives from its status snapshot, and
 * the problems-first rendering both hosts show.
 */
// covers: ["ADP-062"]
import { describe, expect, it } from "vitest"
import { doctorLines, statusChecks } from "../../src/flow/doctor.js"
import { resource, snapshot } from "./fake-env.js"

describe("statusChecks", () => {
  it("flags every empty tier and reports a clean setup", () => {
    expect(statusChecks(snapshot())).toEqual([
      ...["quick", "standard", "advanced"].map((tier) => ({
        state: "warning",
        message: `${tier}: no configured models`,
        action: "Add a model in /adaptive → Models.",
      })),
      { state: "ok", message: "Health: no models limited" },
      { state: "ok", message: "No parked work" },
    ])
  })

  it("counts each limited model once and points at the follow-up", () => {
    const limited = resource({ health: "quota_exhausted" })
    const checks = statusChecks(
      snapshot({
        tiers: {
          quick: [limited],
          standard: [limited, resource({ ref: { providerID: "prov", id: "b" } })],
          advanced: [resource({ ref: { providerID: "prov", id: "c" }, health: "unavailable" })],
        },
        parked: 1,
      }),
    )
    expect(checks).toEqual([
      {
        state: "ok",
        message: "Health: 2 models limited",
        action: "Check /adaptive → Health; reset only after checking the provider.",
      },
      {
        state: "ok",
        message: "1 parked task",
        action: "Use /adaptive → Parked work in the waiting session.",
      },
    ])
    expect(
      statusChecks(
        snapshot({
          tiers: { quick: [limited], standard: [limited], advanced: [limited] },
          parked: 3,
        }),
      ).map((check) => check.message),
    ).toEqual(["Health: 1 model limited", "3 parked tasks"])
  })
})

describe("doctorLines", () => {
  it("leads with a verdict, then problems first", () => {
    expect(doctorLines([{ state: "error", message: "bad", action: "fix" }])).toEqual([
      "1 to fix · 0 to check · 0 OK",
      "FIX bad",
      "  fix",
    ])
    expect(
      doctorLines([
        { state: "ok", message: "fine" },
        { state: "warning", message: "meh" },
        { state: "error", message: "bad" },
      ]),
    ).toEqual(["1 to fix · 1 to check · 1 OK", "FIX bad", "CHECK meh", "OK fine"])
    expect(doctorLines([{ state: "ok", message: "fine" }])).toEqual(["All 1 checks OK", "OK fine"])
  })
})
