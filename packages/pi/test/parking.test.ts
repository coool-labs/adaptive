// covers: ["ADP-024", "ADP-060", "ADP-051"]
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import {
  cancelPark,
  claimPark,
  findPark,
  MAX_WAKES,
  parseParked,
  savePark,
  waitUntil,
  WaitCancelled,
  type Parked,
} from "../src/parking.js"
import { timer } from "../src/host/timer.js"
import { memoryFile } from "./memory-file.js"
const record: Parked = {
  session: "s",
  token: "t",
  tier: "standard",
  due: 2_000,
  wakes: 0,
  claimed: false,
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => {
  vi.useRealTimers()
})

it("claims once under the file transaction, rejects early, cancelled, replaced and spent wakes", async () => {
  const file = memoryFile()
  expect(await findPark(file, "s")).toBeUndefined()
  await savePark(file, record)
  expect(await findPark(file, "s")).toEqual(record)
  expect(await claimPark(file, record, 1_999)).toBe(false)
  expect(
    await Promise.all([claimPark(file, record, 2_000), claimPark(file, record, 2_000)]),
  ).toEqual([true, false])
  expect(await findPark(file, "s")).toBeUndefined()
  await savePark(file, { ...record, token: "new", wakes: MAX_WAKES })
  expect(await claimPark(file, record, 3_000)).toBe(false)
  // A spent automatic budget still blocks automatic claims…
  expect(await claimPark(file, { ...record, token: "new" }, 3_000)).toBe(false)
  await cancelPark(file, "s")
  expect(await claimPark(file, record, 3_000)).toBe(false)
  expect(await findPark(file, "s")).toBeUndefined()
  // …but a manual resume bypasses it.
  await savePark(file, { ...record, token: "new", wakes: MAX_WAKES })
  expect(await claimPark(file, { ...record, token: "new" }, 3_000, true)).toBe(true)
  expect(await findPark(file, "s")).toBeUndefined()
})

it("bounds the shared metadata index and retains other sessions on replacement", async () => {
  const file = memoryFile()
  for (let n = 0; n < 514; n += 1) await savePark(file, { ...record, session: String(n) })
  expect(await findPark(file, "0")).toBeUndefined()
  expect(await findPark(file, "2")).toBeDefined()
  await savePark(file, { ...record, session: "2", due: 4_000 })
  expect(await findPark(file, "2")).toMatchObject({ due: 4_000 })
  await claimPark(file, { ...record, session: "2" }, 5_000)
  expect(await findPark(file, "513")).toBeDefined()
})

it("hard-errors on malformed metadata without changing it", async () => {
  for (const value of [
    null,
    {},
    { version: 2, records: [] },
    { version: 1, records: {} },
    { version: 1, records: Array.from({ length: 513 }, () => record) },
  ]) {
    const file = memoryFile(value)
    await expect(findPark(file, "s")).rejects.toThrow("expected version 1")
    expect(file.value()).toBe(value)
  }
  for (const [key, values] of Object.entries({
    session: ["", 1],
    token: ["", null],
    tier: ["other", 1],
    due: [-1, Infinity, "2"],
    wakes: [-1, 1.2, "0"],
    claimed: [undefined, "true"],
  })) {
    for (const value of values) expect(() => parseParked({ ...record, [key]: value })).toThrow(key)
  }
  expect(() => parseParked(null)).toThrow("session")
})

it("counts down in abortable ticks and never dispatches a cancelled timer", async () => {
  const sources = { file: memoryFile(), clock: Date.now, timer }
  const ticks: number[] = []
  const controller = new AbortController()
  const waiting = waitUntil(sources, 3_500, controller.signal, (remaining) => ticks.push(remaining))
  await vi.advanceTimersByTimeAsync(2_500)
  await waiting
  expect(ticks).toEqual([2_500, 1_500, 500])
  controller.abort()
  await expect(
    waitUntil(sources, 5_000, controller.signal, () => undefined),
  ).rejects.toBeInstanceOf(WaitCancelled)
  await expect(waitUntil(sources, 0, controller.signal, () => undefined)).rejects.toThrow(
    "cancelled",
  )
  const aborted = new AbortController()
  const pending = waitUntil(sources, 10_000, aborted.signal, () => undefined)
  const rejected = expect(pending).rejects.toThrow("cancelled")
  aborted.abort()
  await rejected
  await vi.runAllTimersAsync()
  expect(vi.getTimerCount()).toBe(0)
})

it("never claims the same park twice across wake/cancel/new-input interleavings", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("park", "wake", "cancel"), { maxLength: 100 }),
      async (events) => {
        const file = memoryFile()
        let next = 0
        let current = record
        const dispatched = new Set<string>()
        for (const event of events) {
          if (event === "park") {
            next += 1
            current = { ...record, token: String(next) }
            await savePark(file, current)
          }
          if (event === "cancel") await cancelPark(file, "s")
          if (event === "wake" && (await claimPark(file, current, 10_000))) {
            expect(dispatched.has(current.token)).toBe(false)
            dispatched.add(current.token)
          }
        }
      },
    ),
    { numRuns: 100 },
  )
})
