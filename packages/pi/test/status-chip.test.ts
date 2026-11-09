import { describe, expect, it, vi } from "vitest"
import { createStatusChip, type RoutingStatus } from "../src/host/status-chip.js"

function fixture() {
  const setStatus = vi.fn<(key: string, text: string | undefined) => void>()
  const ctx = { hasUI: true, ui: { setStatus } }
  const chip = createStatusChip()
  return { chip, ctx, setStatus, feedback: chip.connect(ctx) }
}

describe("always-visible routing status", () => {
  it.each<[RoutingStatus, string]>([
    [{ kind: "routing", tier: "standard", model: "sonnet-4.5" }, "standard | sonnet-4.5"],
    [{ kind: "recovering", tier: "quick", model: "gpt-5-mini" }, "Recovering quick | gpt-5-mini"],
    [{ kind: "escalated", tier: "advanced", model: "opus-4.5" }, "Escalated advanced | opus-4.5"],
    [{ kind: "observing", tier: "standard" }, "Observing | would use standard"],
    [{ kind: "degraded" }, "Adaptive degraded | /adaptive doctor"],
    [{ kind: "setup" }, "Adaptive: set up tiers | /adaptive"],
  ])("renders %j without transcript notes", (state, text) => {
    const { feedback, setStatus } = fixture()
    feedback.show(state)
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", text)
  })

  it.each([60, 80, 120])("fits a %i-column terminal without control codes or emoji", (width) => {
    const { feedback, setStatus } = fixture()
    const model = `\u001b[31mprovider/model\u001b[0m\n\t\u0007界😀${"x".repeat(120)}`
    for (const kind of ["routing", "recovering", "escalated"] as const) {
      feedback.show({ kind, tier: "advanced", model })
      const text = setStatus.mock.lastCall?.[1]
      expect(text).toMatch(/^[\x20-\x7e]+$/)
      expect(text?.length).toBeLessThanOrEqual(width)
      expect(text).toHaveLength(48)
      expect(text).toContain("provider/model?????")
      expect(text).toMatch(/\.\.\.$/)
    }
  })

  it("lets wait and park override routing, then restores the latest routing state", () => {
    const { chip, ctx, feedback, setStatus } = fixture()
    feedback.show({ kind: "routing", tier: "standard", model: "first" })
    feedback.setStatus("adaptive", "Waiting for a model | 0:42 | Esc cancels")
    chip.connect(ctx).show({ kind: "recovering", tier: "standard", model: "second" })
    expect(setStatus).toHaveBeenLastCalledWith(
      "adaptive",
      "Waiting for a model | 0:42 | Esc cancels",
    )
    feedback.setStatus("adaptive", "standard parked | resumes 18:42")
    feedback.show({ kind: "degraded" })
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", "standard parked | resumes 18:42")
    feedback.setStatus("adaptive", undefined)
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Adaptive degraded | /adaptive doctor")
  })

  it("clears parking with no prior routing state and delegates other status keys", () => {
    const { feedback, setStatus } = fixture()
    feedback.setStatus("adaptive", "standard parked")
    feedback.setStatus("adaptive", undefined)
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
    feedback.setStatus("another-extension", "Ready")
    expect(setStatus).toHaveBeenLastCalledWith("another-extension", "Ready")
  })

  it.each([
    { retry: false, state: undefined, label: "standard" },
    { retry: false, state: { escalations: 0, restarts: 0 }, label: "standard" },
    { retry: true, state: undefined, label: "Recovering standard" },
    { retry: false, state: { escalations: 0, restarts: 1 }, label: "Recovering standard" },
    { retry: false, state: { escalations: 1, restarts: 0 }, label: "Escalated standard" },
    { retry: true, state: { escalations: 1, restarts: 0 }, label: "Recovering standard" },
  ])("restores admitted dispatch status from $label, not stale parking", ({ label, ...info }) => {
    const { feedback, setStatus } = fixture()
    feedback.setStatus("adaptive", "standard parked")
    feedback.dispatched({ id: "selected" }, { ...info, tier: "standard" })
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", `${label} | selected`)
    feedback.setStatus("adaptive", undefined)
    expect(setStatus).toHaveBeenLastCalledWith("adaptive", `${label} | selected`)
  })

  it.each(["manual pick", "session change", "shutdown"])(
    "clears ownership on %s and rejects delayed routing and parking callbacks",
    () => {
      const { chip, ctx, feedback, setStatus } = fixture()
      feedback.show({ kind: "routing", tier: "standard", model: "old" })
      feedback.setStatus("adaptive", "standard parked")
      chip.reset()
      expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
      const next = chip.connect(ctx)
      next.show({ kind: "observing", tier: "quick" })
      setStatus.mockClear()
      feedback.show({ kind: "degraded" })
      feedback.dispatched({ id: "old" }, { tier: "standard", retry: true, state: undefined })
      feedback.setStatus("adaptive", "old wait")
      feedback.setStatus("adaptive", undefined)
      feedback.setStatus("another-extension", "stale")
      feedback.clear()
      expect(setStatus).not.toHaveBeenCalled()
      next.setStatus("adaptive", undefined)
      expect(setStatus).toHaveBeenLastCalledWith("adaptive", "Observing | would use quick")
      chip.reset()
      chip.reset()
      expect(setStatus).toHaveBeenLastCalledWith("adaptive", undefined)
    },
  )

  it("does not touch UI in headless contexts or require an optional UI", () => {
    const { chip, ctx, setStatus } = fixture()
    for (const context of [{ ...ctx, hasUI: false }, { hasUI: true }, {}]) {
      const feedback = chip.connect(context)
      feedback.show({ kind: "setup" })
      feedback.setStatus("adaptive", "parked")
      feedback.setStatus("another-extension", undefined)
      chip.reset()
    }
    expect(setStatus).not.toHaveBeenCalled()
  })

  it("preserves context methods and fails open when the footer host throws", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const setStatus = vi.fn(() => {
      throw new Error("stale host")
    })
    const notify = vi.fn()
    const chip = createStatusChip()
    const feedback = chip.connect({ hasUI: true, ui: { setStatus, notify } })
    feedback.context.ui.notify()
    expect(notify).toHaveBeenCalledOnce()
    expect(() => {
      feedback.show({ kind: "setup" })
    }).not.toThrow()
    expect(() => {
      feedback.clear()
    }).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("status"))
    log.mockRestore()
  })

  it("preserves Pi's live model/session context getters when wrapping parking", () => {
    let selected = "first"
    const { chip, ctx } = fixture()
    const feedback = chip.connect({
      ...ctx,
      get model() {
        return selected
      },
    })
    expect(feedback.context.model).toBe("first")
    selected = "manual"
    expect(feedback.context.model).toBe("manual")
  })
})
