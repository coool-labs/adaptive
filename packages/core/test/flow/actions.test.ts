/**
 * Shared host operations behind the `/adaptive` menu: health reset, parked
 * work (resume / cancel) and the doctor report — one dialog and one copy for
 * every host, driven through a scripted view.
 */
// covers: ["ADP-024", "ADP-062"]
import { describe, expect, it } from "vitest"
import {
  cancelHere,
  resumeHere,
  runDoctor,
  runHealthReset,
  runParkedWork,
  type CancelOutcome,
  type ResumeOutcome,
} from "../../src/flow/actions.js"
import { STATUS_EMPTY_MESSAGE } from "../../src/flow/status.js"
import type { ModelRef } from "../../src/routing/work-unit/types.js"
import { resource, scripted, snapshot } from "./fake-env.js"

const A: ModelRef = { providerID: "prov", id: "a" }
const B: ModelRef = { providerID: "prov", id: "b" }

describe("runHealthReset", () => {
  it("says so when no model is configured", async () => {
    const host = scripted()
    await runHealthReset(host.env, () => Promise.reject(new Error("unreachable")))
    expect(host.alerts).toEqual([{ title: "Health", message: STATUS_EMPTY_MESSAGE }])
    expect(host.selects).toEqual([])
  })

  it("lists each configured model once with its state, then confirms before resetting", async () => {
    const reset: ModelRef[] = []
    const host = scripted({
      status: snapshot({
        tiers: {
          quick: [resource({ ref: A })],
          standard: [
            resource({ ref: A }),
            resource({ ref: B, health: "unavailable", breaker: "open" }),
          ],
          advanced: [],
        },
      }),
    })
    host.picks.push("prov/b")
    host.confirms.push(true)
    await runHealthReset(host.env, (model) => {
      reset.push(model)
      return Promise.resolve()
    })
    expect(host.selects).toEqual([
      {
        title: "Health · select a model to reset",
        options: [
          { title: "prov/a", description: "healthy" },
          { title: "prov/b", description: "unavailable · breaker open" },
        ],
      },
    ])
    expect(reset).toEqual([B])
    expect(host.toasts).toEqual([{ message: "Health reset", variant: "success" }])
  })

  it("resets nothing when the pick or the confirmation is withdrawn", async () => {
    const reset: ModelRef[] = []
    const record = (model: ModelRef) => {
      reset.push(model)
      return Promise.resolve()
    }
    const status = snapshot({
      tiers: { quick: [resource({ ref: A })], standard: [], advanced: [] },
    })
    const dismissed = scripted({ status })
    dismissed.picks.push(undefined)
    await runHealthReset(dismissed.env, record)
    const declined = scripted({ status })
    declined.picks.push("prov/a")
    declined.confirms.push(false)
    await runHealthReset(declined.env, record)
    expect(reset).toEqual([])
    expect([...dismissed.toasts, ...declined.toasts]).toEqual([])
  })
})

describe("resumeHere / cancelHere", () => {
  const resumeWith = (outcome: ResumeOutcome) => () => Promise.resolve(outcome)
  const cancelWith = (outcome: CancelOutcome) => () => Promise.resolve(outcome)

  it("closes the menu only when the parked run resumes", async () => {
    const resumed = scripted({ sessionID: "s1" })
    expect(await resumeHere(resumed.env, resumeWith("resumed"))).toBe(true)
    expect(resumed.toasts).toEqual([{ message: "Resuming parked work", variant: "success" }])

    const waiting = scripted({ sessionID: "s1" })
    expect(await resumeHere(waiting.env, resumeWith("waiting"))).toBe(false)
    expect(waiting.alerts).toEqual([
      {
        title: "Parked work",
        message: "No model in this tier is available yet. Adaptive keeps waiting and retries.",
      },
    ])

    const idle = scripted({ sessionID: "s1" })
    expect(await resumeHere(idle.env, resumeWith("not-parked"))).toBe(false)
    expect(idle.alerts).toEqual([
      { title: "Parked work", message: "Nothing is parked in this session." },
    ])
  })

  it("acts only from inside a session", async () => {
    const OUTSIDE = {
      title: "Parked work",
      message: "Open the waiting session and run /adaptive there to resume or cancel it.",
    }
    const resume = scripted()
    expect(await resumeHere(resume.env, resumeWith("resumed"))).toBe(false)
    const cancel = scripted()
    await cancelHere(cancel.env, cancelWith("cancelled"))
    expect([...resume.alerts, ...cancel.alerts]).toEqual([OUTSIDE, OUTSIDE])
  })

  it("confirms a cancel, and says when there was nothing to cancel", async () => {
    const asked: string[] = []
    const cancelled = scripted({ sessionID: "s1" })
    await cancelHere(cancelled.env, (sessionID) => {
      asked.push(sessionID)
      return Promise.resolve("cancelled")
    })
    expect(asked).toEqual(["s1"])
    expect(cancelled.toasts).toEqual([{ message: "Parked work cancelled", variant: "success" }])
    const idle = scripted({ sessionID: "s1" })
    await cancelHere(idle.env, cancelWith("not-parked"))
    expect(idle.alerts).toEqual([
      { title: "Parked work", message: "Nothing is parked in this session." },
    ])
  })
})

describe("runParkedWork", () => {
  const waiting = snapshot({
    parked: 2,
    waiting: [
      { sessionID: "s1", tier: "standard", resumeAt: null },
      { sessionID: "other", tier: "quick", resumeAt: null },
    ],
  })
  const actions = {
    resume: () => Promise.resolve("resumed" as const),
    cancel: () => Promise.resolve("cancelled" as const),
  }

  it("says so when nothing waits", async () => {
    const host = scripted({ sessionID: "s1" })
    expect(await runParkedWork(host.env, actions)).toBe(false)
    expect(host.alerts).toEqual([{ title: "Parked work", message: "No parked work." }])
  })

  it("lists every waiting session and resumes this one", async () => {
    const host = scripted({ status: waiting, sessionID: "s1" })
    host.picks.push("This session", "Resume now")
    expect(await runParkedWork(host.env, actions)).toBe(true)
    expect(host.selects).toEqual([
      {
        title: "Parked work",
        options: [
          { title: "This session", description: "standard · waiting" },
          { title: "other", description: "quick · waiting" },
        ],
      },
      {
        title: "This session's parked work",
        options: [
          { title: "Resume now", description: "try the tier again" },
          { title: "Cancel", description: "drop the wait; your next prompt starts fresh" },
        ],
      },
    ])
  })

  it("cancels this session's wait and keeps the menu open", async () => {
    const host = scripted({ status: waiting, sessionID: "s1" })
    host.picks.push("This session", "Cancel")
    expect(await runParkedWork(host.env, actions)).toBe(false)
    expect(host.toasts).toEqual([{ message: "Parked work cancelled", variant: "success" }])
  })

  it("points other sessions' work at their own session", async () => {
    const host = scripted({ status: waiting, sessionID: "s1" })
    host.picks.push("other")
    expect(await runParkedWork(host.env, actions)).toBe(false)
    expect(host.alerts).toEqual([
      {
        title: "Parked work",
        message: "Open the waiting session and run /adaptive there to resume or cancel it.",
      },
    ])
  })

  it("offers only the wired operations and steps back on dismissal", async () => {
    const dismissed = scripted({ status: waiting, sessionID: "s1" })
    dismissed.picks.push(undefined)
    expect(await runParkedWork(dismissed.env, actions)).toBe(false)

    const resumeOnly = scripted({ status: waiting, sessionID: "s1" })
    resumeOnly.picks.push("This session", undefined)
    expect(await runParkedWork(resumeOnly.env, { resume: actions.resume })).toBe(false)
    expect(resumeOnly.selects[1]?.options.map((option) => option.title)).toEqual(["Resume now"])

    const cancelOnly = scripted({ status: waiting, sessionID: "s1" })
    cancelOnly.picks.push("This session", undefined)
    expect(await runParkedWork(cancelOnly.env, { cancel: actions.cancel })).toBe(false)
    expect(cancelOnly.selects[1]?.options.map((option) => option.title)).toEqual(["Cancel"])
  })

  it("reads the wall clock when the host injects none", async () => {
    const host = scripted({
      status: snapshot({ waiting: [{ sessionID: "s1", tier: "standard", resumeAt: 0 }] }),
      sessionID: "s1",
      clock: false,
    })
    await runParkedWork(host.env, actions)
    expect(host.selects[0]?.options).toEqual([
      { title: "This session", description: "standard · waiting · resuming" },
    ])
  })
})

describe("runDoctor", () => {
  it("renders the host's checks problems-first", async () => {
    const host = scripted()
    await runDoctor(host.env, () =>
      Promise.resolve([
        { state: "ok", message: "fine" },
        { state: "error", message: "bad", action: "fix it" },
      ]),
    )
    expect(host.tables).toEqual([
      {
        title: "Adaptive doctor",
        lines: ["1 to fix · 0 to check · 1 OK", "FIX bad", "  fix it", "OK fine"],
      },
    ])
  })
})
