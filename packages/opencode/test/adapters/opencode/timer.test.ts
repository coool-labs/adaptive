/**
 * The wake timer is a one-shot, cancellable, unref'd timeout (ADP-024): a
 * pending wake never keeps a headless process alive.
 */
// covers: ["ADP-024"]
import { afterEach, describe, expect, it, vi } from "vitest"

import { unrefTimeout } from "../../../src/adapters/opencode/timer.js"

describe("unrefTimeout", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires once after the delay and does not hold the process open", () => {
    vi.useFakeTimers()
    const unref = vi.spyOn(globalThis, "setTimeout")
    const fired: number[] = []
    unrefTimeout(() => fired.push(1), 500)
    const timer = unref.mock.results[0]?.value as { hasRef(): boolean }
    expect(timer.hasRef()).toBe(false)
    vi.advanceTimersByTime(499)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([1])
    unref.mockRestore()
  })

  it("cancels a pending wake", () => {
    vi.useFakeTimers()
    const fired: number[] = []
    const cancel = unrefTimeout(() => fired.push(1), 500)
    cancel()
    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual([])
  })
})
