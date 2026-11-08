// covers: ["ADP-024"]
import { describe, expect, it } from "vitest"

import { waitingLabel, waitingSessions } from "../../src/flow/waiting.js"
import type { StatusSnapshot } from "../../src/status.js"

// Local-time construction keeps the expectations independent of the runner's time zone.
const NOW = new Date(2026, 10, 7, 14, 5).getTime()

describe("waitingLabel", () => {
  it("names only the wait when no reset time is known", () => {
    expect(waitingLabel(null, NOW)).toBe("waiting")
  })

  it("says resuming once the reset time has passed", () => {
    expect(waitingLabel(NOW, NOW)).toBe("waiting · resuming")
    expect(waitingLabel(NOW - 60_000, NOW)).toBe("waiting · resuming")
  })

  it("shows the clock time for a reset later today", () => {
    expect(waitingLabel(new Date(2026, 10, 7, 18, 42).getTime(), NOW)).toBe(
      "waiting · resumes 18:42",
    )
    expect(waitingLabel(new Date(2026, 10, 7, 23, 9).getTime(), NOW)).toBe(
      "waiting · resumes 23:09",
    )
  })

  it("adds the weekday for a reset on a later calendar day within a week", () => {
    expect(waitingLabel(new Date(2026, 10, 8, 1, 0).getTime(), NOW)).toBe(
      "waiting · resumes Sun 01:00",
    )
    expect(waitingLabel(new Date(2026, 10, 13, 9, 30).getTime(), NOW)).toBe(
      "waiting · resumes Fri 09:30",
    )
  })

  it("adds the date for a reset more than a week away", () => {
    expect(waitingLabel(new Date(2026, 10, 14, 18, 42).getTime(), NOW)).toBe(
      "waiting · resumes Nov 14 18:42",
    )
    expect(waitingLabel(new Date(2027, 0, 2, 8, 0).getTime(), NOW)).toBe(
      "waiting · resumes Jan 2 08:00",
    )
  })
})

describe("waitingSessions", () => {
  it("maps each parked session to its resume time", () => {
    const snapshot: StatusSnapshot = {
      mode: "active",
      pin: null,
      tiers: { quick: [], standard: [], advanced: [] },
      parked: 2,
      waiting: [
        { sessionID: "s1", tier: "standard", resumeAt: 5000 },
        { sessionID: "s2", tier: "advanced", resumeAt: null },
      ],
      receipts: 0,
    }
    expect(waitingSessions(snapshot)).toEqual({ s1: 5000, s2: null })
  })
})
