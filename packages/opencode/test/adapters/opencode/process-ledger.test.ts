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

/** A claim that must succeed, returning its lease token. */
function leased(
  ledger: ReturnType<typeof processLedger>,
  sessionID: string,
  at = 0,
  staleAfterMs = 10_000,
): symbol {
  const token = ledger.claim(sessionID, at, staleAfterMs)
  if (token === undefined) throw new Error("expected claim")
  return token
}

describe("process ledger", () => {
  it("delegates resumes only to another live, registered instance", async () => {
    const [one, two] = pair()
    const sessions: string[] = []
    one.onResume((sessionID) => {
      sessions.push(sessionID)
      return Promise.resolve("resumed")
    })
    expect(two.resumeElsewhere("s1")).toBeUndefined()
    one.markLive()
    expect(one.resumeElsewhere("s1")).toBeUndefined()
    expect(await two.resumeElsewhere("s1")).toBe("resumed")
    one.leave()
    one.onResume(() => Promise.resolve("waiting"))
    expect(two.resumeElsewhere("s2")).toBeUndefined()
    expect(sessions).toEqual(["s1"])
  })

  it("orders health operations across instances and recovers after a failed write", async () => {
    const [one, two] = pair()
    const calls: string[] = []
    const first = one.healthOperation(() => {
      calls.push("first")
      return Promise.reject(new Error("write failed"))
    })
    const second = two.healthOperation(() => {
      calls.push("second")
      return Promise.resolve()
    })
    await expect(first).rejects.toThrow("write failed")
    await second
    expect(calls).toEqual(["first", "second"])
  })

  it("orders receipt operations across instances and recovers after a failed write", async () => {
    const [one, two] = pair()
    const calls: string[] = []
    const first = one.receiptOperation(() => {
      calls.push("first")
      return Promise.reject(new Error("write failed"))
    })
    const second = two.receiptOperation(() => {
      calls.push("second")
      return Promise.resolve("second done")
    })
    await expect(first).rejects.toThrow("write failed")
    await expect(second).resolves.toBe("second done")
    expect(calls).toEqual(["first", "second"])
    expect(one.receiptRevision()).toBe(0)
    one.noteReceiptWrite()
    expect(two.receiptRevision()).toBe(1)
  })

  it("broadcasts health resets to registered instances until they leave", () => {
    const [one, two] = pair()
    const calls: string[] = []
    one.onHealthReset((model) => calls.push(`one:${model.id}`))
    two.onHealthReset((model) => calls.push(`two:${model.id}`))
    one.resetHealth(A)
    two.leave()
    two.onHealthReset(() => calls.push("disposed"))
    one.resetHealth(B)
    expect(calls).toEqual(["one:a", "two:a", "one:b"])
  })

  it("lives on the global object by default, shared by every view", () => {
    const first = processLedger()
    const second = processLedger()
    const token = leased(first, "ledger-test")
    expect(second.claim("ledger-test", 0, 10_000)).toBeUndefined()
    first.release("ledger-test", token)
    const secondToken = leased(second, "ledger-test")
    second.release("ledger-test", secondToken)
  })

  it("ignores a ledger an older release left on the holder", () => {
    const legacy = { live: new Set<symbol>(), claims: new Set<string>() }
    const holder = { [Symbol.for("coool.adaptive/process-ledger")]: legacy }
    const ledger = processLedger(holder)
    const reset: string[] = []
    ledger.onHealthReset((model) => reset.push(model.id))
    ledger.resetHealth(A)
    expect(reset).toEqual(["a"])
    expect(ledger.claim("s1", 0, 10_000)).toBeDefined()
    expect(legacy.claims.size).toBe(0)
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
    const token = leased(one, "s1")
    expect(two.claim("s1", 0, 10_000)).toBeUndefined()
    leased(two, "s2")
    one.release("s1", token)
    leased(two, "s1")
  })

  it("reclaims a lease whose owner is presumed wedged", () => {
    const [one, two] = pair()
    leased(one, "s1")
    expect(two.claim("s1", 9_999, 10_000)).toBeUndefined()
    leased(two, "s1", 10_000)
  })

  it("lets a continuation's own failure supersede the live delivery lease", () => {
    const [one, two] = pair()
    const delivered = leased(one, "s1")
    const next = two.claim("s1", 0, 10_000, true)
    expect(next).toBeDefined()
    // The superseded chain's late release cannot drop the new owner's lease.
    one.release("s1", delivered)
    expect(one.claim("s1", 0, 10_000)).toBeUndefined()
  })

  it("releases only the matching lease, never a newer owner's", () => {
    const [one, two] = pair()
    const stale = leased(one, "s1")
    const current = leased(two, "s1", 10_000)
    one.release("s1", stale)
    expect(two.claim("s1", 10_001, 10_000)).toBeUndefined()
    two.release("s1", current)
    leased(one, "s1", 10_001)
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

  it("ignores a departed instance's marks", () => {
    const [one, two] = pair()
    one.noteSwitch("s1", A, 1_000)
    one.noteContinuation("s1", { tier: "standard" }, 1_000)
    one.leave()
    // A disposed instance must not steer a survivor with marks it left behind
    // (a released test supervisor would otherwise own the next real prompt).
    expect(two.takeSwitch("s1", A, 1_001)).toBe(false)
    expect(two.takeContinuation("s1", 1_001)).toBeUndefined()
  })

  it("orders steering writes and shares their revision across instances", async () => {
    const [one, two] = pair()
    const order: string[] = []
    await Promise.all([
      one.steeringOperation(() => {
        order.push("one")
        return Promise.resolve()
      }),
      two.steeringOperation(() => {
        order.push("two")
        return Promise.resolve()
      }),
    ])
    expect(order).toEqual(["one", "two"])
    expect(two.steeringRevision()).toBe(0)
    one.noteSteeringWrite()
    expect(two.steeringRevision()).toBe(1)
    // A failed write still releases the shared queue for the next one.
    await expect(
      one.steeringOperation(() => Promise.reject(new Error("write failed"))),
    ).rejects.toThrow("write failed")
    await two.steeringFlush()
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
    one.claim("s0", 0, 10_000)
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
