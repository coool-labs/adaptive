// covers: ["ADP-059"]
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import type * as FsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * Deterministic interleaving of two waiters that both judged the same crashed
 * holder's lock stale: the first stat is held back until the second waiter has
 * issued its own, and the second is delivered only once the first waiter owns
 * the lock again — exactly the window in which a naive reclaim would delete a
 * live holder's fresh lock.
 */
const gate = vi.hoisted(() => {
  const state: {
    calls: number
    secondIssued: () => void
    holderOwnsLock: () => void
    waiterRetried: () => void
    firstMayReturn: Promise<void>
    secondMayReturn: Promise<void>
    retried: Promise<void>
    armed: boolean
    /** 1-based indexes of lock reads that fail as if the holder just released. */
    vanishing: readonly number[]
    lockReads: number
  } = {
    calls: 0,
    secondIssued: () => undefined,
    holderOwnsLock: () => undefined,
    waiterRetried: () => undefined,
    firstMayReturn: Promise.resolve(),
    secondMayReturn: Promise.resolve(),
    retried: Promise.resolve(),
    armed: false,
    vanishing: [],
    lockReads: 0,
  }
  return state
})

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    readFile: (path: string, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".lock")) {
        gate.lockReads += 1
        if (gate.vanishing.includes(gate.lockReads))
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    },
    stat: async (path: string) => {
      if (!gate.armed) return actual.stat(path)
      gate.calls += 1
      const call = gate.calls
      const result = actual.stat(path)
      // Observe the file now, deliver the observation later.
      if (call === 1) await gate.firstMayReturn
      else if (call === 2) {
        gate.secondIssued()
        await gate.secondMayReturn
      } else gate.waiterRetried()
      return result
    },
  }
})

const { jsonFile } = await import("../src/store.js")

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "adaptive-stale-lock-"))
})

afterEach(async () => {
  gate.armed = false
  gate.vanishing = []
  gate.lockReads = 0
  await rm(directory, { recursive: true, force: true })
})

it("never deletes the fresh lock of a waiter that already reclaimed the crashed holder's lock", async () => {
  const path = join(directory, "health.json")
  await writeFile(`${path}.lock`, "999999")
  const old = new Date(Date.now() - 60_000)
  await utimes(`${path}.lock`, old, old)

  gate.calls = 0
  gate.armed = true
  gate.firstMayReturn = new Promise((resolve) => {
    gate.secondIssued = resolve
  })
  gate.secondMayReturn = new Promise((resolve) => {
    gate.holderOwnsLock = resolve
  })
  gate.retried = new Promise((resolve) => {
    gate.waiterRetried = resolve
  })

  const events: string[] = []
  let enteredSecond!: () => void
  const secondEntered = new Promise<void>((resolve) => {
    enteredSecond = resolve
  })
  const critical = (name: string) => async (): Promise<{ next: undefined; result: string }> => {
    events.push(`${name} in`)
    if (events.length === 1) {
      gate.holderOwnsLock()
      // Stay inside until the other waiter either barges in or visibly keeps waiting.
      await Promise.race([secondEntered, gate.retried])
    } else enteredSecond()
    events.push(`${name} out`)
    return { next: undefined, result: name }
  }

  const results = await Promise.all([
    jsonFile(path).transaction(critical("first")),
    jsonFile(path).transaction(critical("second")),
  ])
  expect(results.sort()).toEqual(["first", "second"])
  // Mutual exclusion: one holder leaves before the other enters.
  expect(events[0]?.endsWith(" in")).toBe(true)
  expect(events[1]).toBe(events[0]?.replace(" in", " out"))
  expect(events[2]?.endsWith(" in")).toBe(true)
  expect(await readdir(directory)).toEqual([])
})

it("writes state files readable only by their owner", async () => {
  const path = join(directory, "parked.json")
  await jsonFile(path).update(() => ({ next: { version: 1 }, result: undefined }))
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 })
})

it.each([
  ["before it was inspected", [1]],
  ["after it was judged stale", [2]],
])("never removes a lock that vanished %s, and still acquires it", async (_when, vanishing) => {
  const path = join(directory, "health.json")
  await writeFile(`${path}.lock`, "999999")
  const old = new Date(Date.now() - 60_000)
  await utimes(`${path}.lock`, old, old)
  gate.vanishing = vanishing
  await expect(jsonFile(path).update(() => ({ next: 7, result: "ok" }))).resolves.toBe("ok")
  expect(gate.lockReads).toBeGreaterThan(Math.max(...vanishing))
  expect(await readdir(directory)).toEqual(["health.json"])
})
