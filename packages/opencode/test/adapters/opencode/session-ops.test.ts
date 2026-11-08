// covers: ["ADP-014", "ADP-016", "ADP-028"]
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

describe("sessionOps prompt ownership marks", () => {
  it("marks before the prompt and clears after it settles", async () => {
    const log: string[] = []
    const ops = sessionOps(fakeSessionOps(log), {
      beforePrompt: (sessionID) => log.push(`beforePrompt:${sessionID}`),
      afterPrompt: (sessionID, delivered) =>
        log.push(`afterPrompt:${sessionID}:${String(delivered)}`),
    })
    await ops.prompt("s1", "continue from current state")
    expect(log).toEqual([
      "beforePrompt:s1",
      "prompt:s1:continue from current state",
      "afterPrompt:s1:true",
    ])
  })

  it("reports an undelivered prompt so the mark can be dropped", async () => {
    const log: string[] = []
    const source = fakeSessionOps(log)
    const failing = {
      ...source,
      prompt: (input: { sessionID: string; text: string }) => {
        log.push(`prompt:${input.sessionID}:${input.text}`)
        return Promise.reject(new Error("host gone"))
      },
    }
    const ops = sessionOps(failing, {
      beforePrompt: (sessionID) => log.push(`beforePrompt:${sessionID}`),
      afterPrompt: (sessionID, delivered) =>
        log.push(`afterPrompt:${sessionID}:${String(delivered)}`),
    })
    await expect(ops.prompt("s1", "continue from current state")).rejects.toThrow("host gone")
    expect(log).toEqual([
      "beforePrompt:s1",
      "prompt:s1:continue from current state",
      "afterPrompt:s1:false",
    ])
  })
})
