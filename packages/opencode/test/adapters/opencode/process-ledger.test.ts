// covers: ["ADP-024", "ADP-056"]
import { describe, expect, it } from "vitest"

import {
  MARK_TTL_MS,
  MAX_LEDGER_SESSIONS,
  processLedger,
} from "../../../src/adapters/opencode/process-ledger.js"

const A = { providerID: "prov", id: "a" }
const B = { providerID: "prov", id: "b" }

/** Two instances of one process: two views over one holder. */
function pair(): [ReturnType<typeof processLedger>, ReturnType<typeof processLedger>] {
  const holder = {}
  return [processLedger(holder), processLedger(holder)]
}

describe("process ledger", () => {
  it("lives on the global object by default, shared by every view", () => {
    const first = processLedger()
    const second = processLedger()
    expect(first.claim("ledger-test")).toBe(true)
    expect(second.claim("ledger-test")).toBe(false)
    first.release("ledger-test")
    expect(second.claim("ledger-test")).toBe(true)
    second.release("ledger-test")
  })

  it("knows when another instance hears the host, until it leaves", () => {
    const [one, two] = pair()
    expect(one.liveElsewhere()).toBe(false)
    one.markLive()
    expect(one.liveElsewhere()).toBe(false)
    expect(two.liveElsewhere()).toBe(true)
    one.leave()
    expect(two.liveElsewhere()).toBe(false)
  })

  it("admits one claim per session at a time", () => {
    const [one, two] = pair()
    expect(one.claim("s1")).toBe(true)
    expect(two.claim("s1")).toBe(false)
    expect(two.claim("s2")).toBe(true)
    one.release("s1")
    expect(two.claim("s1")).toBe(true)
  })

  it("counts takeovers per session across instances", () => {
    const [one, two] = pair()
    expect(two.takeovers("s1")).toBe(0)
    one.noteTakeover("s1")
    one.noteTakeover("s1")
    expect(two.takeovers("s1")).toBe(2)
    expect(two.takeovers("s2")).toBe(0)
  })

  it("recognizes another instance's own switch once, only for the same model", () => {
    const [one, two] = pair()
    one.noteSwitch("s1", A, 1_000)
    // The writer never reads its own mark.
    expect(one.takeSwitch("s1", A, 1_000)).toBe(false)
    expect(two.takeSwitch("s1", A, 1_001)).toBe(true)
    expect(two.takeSwitch("s1", A, 1_002)).toBe(false)

    // A different model is a manual pick, and it consumes the mark.
    one.noteSwitch("s1", A, 2_000)
    expect(two.takeSwitch("s1", B, 2_001)).toBe(false)
    expect(two.takeSwitch("s1", A, 2_002)).toBe(false)
    expect(two.takeSwitch("s2", A, 2_003)).toBe(false)
  })

  it("forgets marks older than the TTL", () => {
    const [one, two] = pair()
    one.noteSwitch("s1", A, 0)
    expect(two.takeSwitch("s1", A, MARK_TTL_MS + 1)).toBe(false)
    one.noteContinuation("s1", { tier: "standard" }, 0)
    expect(two.takeContinuation("s1", MARK_TTL_MS)).toEqual({ tier: "standard" })
  })

  it("hands another instance's continuation over once", () => {
    const [one, two] = pair()
    one.noteContinuation("s1", { tier: "advanced", cycles: 2 }, 10)
    expect(one.takeContinuation("s1", 10)).toBeUndefined()
    expect(two.takeContinuation("s1", 11)).toEqual({ tier: "advanced", cycles: 2 })
    expect(two.takeContinuation("s1", 12)).toBeUndefined()
  })

  it("keeps a bounded number of sessions, evicting the oldest", () => {
    const [one, two] = pair()
    for (let index = 0; index <= MAX_LEDGER_SESSIONS; index += 1) {
      one.noteContinuation(`s${String(index)}`, {}, 0)
    }
    // s0 was evicted to make room for the newest session.
    expect(two.takeContinuation("s0", 0)).toBeUndefined()
    expect(two.takeContinuation("s1", 0)).toEqual({})
    expect(two.takeContinuation(`s${String(MAX_LEDGER_SESSIONS)}`, 0)).toEqual({})
    // Re-noting a present session does not evict another.
    one.noteContinuation("s2", {}, 0)
    one.noteContinuation("s2", {}, 1)
    expect(two.takeContinuation("s3", 0)).toEqual({})
  })

  it("never evicts the takeover count a claimed session's resume compares against", () => {
    const [one, two] = pair()
    one.noteTakeover("s0")
    one.claim("s0")
    for (let index = 1; index <= MAX_LEDGER_SESSIONS; index += 1) {
      one.noteTakeover(`s${String(index)}`)
    }
    expect(two.takeovers("s0")).toBe(1)
    // The oldest unclaimed session made room instead.
    expect(two.takeovers("s1")).toBe(0)
  })

  it("withdraws only this instance's own marks", () => {
    const [one, two] = pair()
    one.noteSwitch("s1", A, 0)
    one.noteContinuation("s1", { tier: "quick" }, 0)
    two.withdrawSwitch("s1")
    two.withdrawContinuation("s1")
    expect(two.takeSwitch("s1", A, 1)).toBe(true)
    expect(two.takeContinuation("s1", 1)).toEqual({ tier: "quick" })

    one.noteSwitch("s2", A, 0)
    one.noteContinuation("s2", {}, 0)
    one.withdrawSwitch("s2")
    one.withdrawContinuation("s2")
    expect(two.takeSwitch("s2", A, 1)).toBe(false)
    expect(two.takeContinuation("s2", 1)).toBeUndefined()
  })

  it("ignores a late host report from an instance that left", () => {
    const [one, two] = pair()
    one.leave()
    one.markLive()
    expect(two.liveElsewhere()).toBe(false)
  })

  it("publishes the earliest wake armed by another live instance", () => {
    const holder = {}
    const [one, two, three] = [processLedger(holder), processLedger(holder), processLedger(holder)]
    one.noteWake(5_000)
    expect(three.liveWake()).toBeUndefined()
    one.markLive()
    two.markLive()
    two.noteWake(3_000)
    expect(three.liveWake()).toBe(3_000)
    // An instance never reads its own wake.
    expect(two.liveWake()).toBe(5_000)
    two.noteWake(undefined)
    expect(three.liveWake()).toBe(5_000)
    one.leave()
    expect(three.liveWake()).toBeUndefined()
    one.noteWake(1_000)
    expect(three.liveWake()).toBeUndefined()
  })

  it("hints which sessions may hold parked work", () => {
    const [one, two] = pair()
    expect(two.mayBeParked("s1")).toBe(false)
    one.noteParked("s1")
    expect(two.mayBeParked("s1")).toBe(true)
    two.clearParked("s1")
    expect(one.mayBeParked("s1")).toBe(false)
  })
})
