import { describe, expect, it } from "vitest"
import { sessionOps } from "../../../src/adapters/opencode/session-ops.js"
import { coreRef, fakeSessionOps } from "./helpers.js"

describe("sessionOps", () => {
  it("settles via the host wait", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log))
    await ops.settle("s1")
    expect(log).toEqual(["wait:s1"])
  })

  it("prompts without touching the switch hook", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log), {
      beforeSwitch: (sessionID) => log.push(`tag:${sessionID}`),
    })
    await ops.prompt("s1", "continue from current state")
    expect(log).toEqual(["prompt:s1:continue from current state"])
  })

  it("switches the model and passes no variant key when unset", async () => {
    const log: string[] = []
    const switches: { model: Record<string, unknown> }[] = []
    const source = fakeSessionOps(log)
    const ops = sessionOps({
      ...source,
      switchModel: (input: { sessionID: string; model: Record<string, unknown> }) => {
        switches.push({ model: input.model })
        log.push("switch")
        return Promise.resolve()
      },
    })
    await ops.switchModel("s1", coreRef("p1", "m1"))
    expect(log).toEqual(["switch"])
    expect(switches[0]?.model).toEqual({ providerID: "p1", id: "m1" })
    expect("variant" in (switches[0]?.model ?? {})).toBe(false)
  })

  it("passes the variant when the target carries one", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log))
    await ops.switchModel("s1", coreRef("p1", "m1", "high"))
    expect(log).toEqual(["switch:s1:p1/m1@high"])
  })

  it("tags its own switch BEFORE the host switch (self-attribution order)", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log), {
      beforeSwitch: (sessionID, model) =>
        log.push(`tag:${sessionID}:${model.providerID}/${model.id}`),
    })
    await ops.switchModel("s1", coreRef("p1", "m1"))
    expect(log).toEqual(["tag:s1:p1/m1", "switch:s1:p1/m1"])
  })

  it("works without a beforeSwitch hook", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log))
    await expect(ops.switchModel("s1", coreRef("p1", "m1"))).resolves.toBeUndefined()
    expect(log).toEqual(["switch:s1:p1/m1"])
  })
})
